use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, os::unix::{fs::{MetadataExt, PermissionsExt}, net::UnixStream}, path::{Path, PathBuf}, time::Duration};

pub struct Hyprland;
impl Hyprland {
    /// Use a private D-Bus connection: libatspi's shared GLib state belongs to the GTK thread.
    /// Unsupported/read failures may fall back; a failed write must never trigger a second move.
    pub fn position_cursor(target: &str, text: &str, utf16: usize, discovering: &std::sync::Arc<std::sync::atomic::AtomicBool>, mut current: impl FnMut() -> Result<bool>) -> Result<bool> {
        use zbus::{blocking::{connection::Builder, Proxy}, zvariant::OwnedObjectPath};
        use std::sync::atomic::Ordering;
        ensure!(current()?, "Cursor target changed");
        if discovering.swap(true, Ordering::SeqCst) { return Ok(false); }
        let worker_active = discovering.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let owned_target = target.to_owned();
        let text = text.to_owned();
        let worker = std::thread::Builder::new().name("cursor-discovery".into()).spawn(move || {
            let prepared = (|| -> Result<_> {
                let target = owned_target.as_str();
                let active = Self::query("activewindow")?;
                ensure!(active["address"] == target, "Cursor target changed");
                let pid = active["pid"].as_u64().context("Missing target process")? as u32;
                let session = Builder::session()?.method_timeout(Duration::from_millis(25)).build()?;
                let address: String = session.call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())?.body().deserialize()?;
                let bus = Builder::address(address.as_str())?.method_timeout(Duration::from_millis(25)).build()?;
                let apps: Vec<(String, OwnedObjectPath)> = bus.call_method(Some("org.a11y.atspi.Registry"), "/org/a11y/atspi/accessible/root", Some("org.a11y.atspi.Accessible"), "GetChildren", &())?.body().deserialize()?;
                let deadline = std::time::Instant::now() + Duration::from_millis(150);
                for (name, root) in apps.into_iter().take(64) {
                    if std::time::Instant::now() >= deadline { break; }
                    let owner: u32 = bus.call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetConnectionUnixProcessID", &(name.as_str(),))?.body().deserialize()?;
                    if owner != pid { continue; }
                    let rule = (vec![(1i32 << 7) | (1 << 12) | (1 << 24), 0], 1i32, std::collections::HashMap::<String, String>::new(), 1i32, vec![0i32; 5], 1i32, vec!["Text"], 1i32, false);
                    let fields: Vec<(String, OwnedObjectPath)> = bus.call_method(Some(name.as_str()), root.as_str(), Some("org.a11y.atspi.Collection"), "GetMatches", &(rule, 1u32, 8i32, true))?.body().deserialize()?;
                    ensure!(fields.len() < 8, "Too many focused text fields");
                    let mut matched = None;
                    for (destination, path) in fields {
                        if destination != name { continue; }
                        let candidate = (|| -> Result<_> {
                            let accessible = Proxy::new(&bus, name.as_str(), path.as_str(), "org.a11y.atspi.Accessible")?;
                            let states: Vec<u32> = accessible.call("GetState", &())?;
                            let required = (1 << 7) | (1 << 12) | (1 << 24);
                            ensure!(states.first().is_some_and(|state| state & required == required), "Field is not editable and focused");
                            let field: Proxy = zbus::blocking::proxy::Builder::new(&bus).destination(name.as_str())?.path(path.as_str())?.interface("org.a11y.atspi.Text")?.cache_properties(zbus::proxy::CacheProperties::No).build()?;
                            let selections: i32 = field.call("GetNSelections", &())?;
                            ensure!(selections == 0, "Field has a selection");
                            let end: i32 = field.get_property("CaretOffset")?;
                            let count = i32::try_from(text.chars().count())?;
                            let mut units = 0;
                            let mut prefix = 0;
                            for ch in text.chars() { if units >= utf16 { break; } units += ch.len_utf16(); prefix += 1; }
                            ensure!(units == utf16, "Invalid cursor boundary");
                            if end >= count {
                                let inserted: String = field.call("GetText", &(end - count, end))?;
                                if inserted == text { return Ok((path.clone(), end, path.clone(), end, end - count + prefix)); }
                            }
                            // Chromium multiline contenteditables expose one embedded block per line.
                            // Only use this mapping when the complete block text exactly matches the paste.
                            let embedded: String = field.call("GetText", &(0i32, -1i32))?;
                            ensure!(embedded.contains('\u{fffc}'), "Field does not expose a plain text offset");
                            let children: Vec<(String, OwnedObjectPath)> = accessible.call("GetChildren", &())?;
                            ensure!(!children.is_empty() && end >= embedded.chars().count() as i32 - 1, "Caret is not at the last text block");
                            let mut lines = Vec::new();
                            let mut representation = String::new();
                            for (owner, child) in &children {
                                ensure!(std::time::Instant::now() < deadline && owner == &name, "Text block discovery unavailable");
                                let child_field = Proxy::new(&bus, name.as_str(), child.as_str(), "org.a11y.atspi.Text")?;
                                let child_accessible = Proxy::new(&bus, name.as_str(), child.as_str(), "org.a11y.atspi.Accessible")?;
                                let role: String = child_accessible.call("GetRoleName", &())?;
                                let line: String = child_field.call("GetText", &(0i32, -1i32))?;
                                ensure!(!line.contains('\u{fffc}') && (line == "\n" || !line.contains('\n')), "Unsupported nested text block");
                                if role == "static" && lines.is_empty() { representation.push_str(&line); } else { ensure!(role == "section" || role == "paragraph", "Unsupported inline text block"); representation.push('\u{fffc}'); }
                                if lines.len() + 1 == children.len() { let caret: i32 = child_field.get_property("CaretOffset")?; ensure!(caret == line.chars().count() as i32 || line == "\n" && caret == 0, "Caret is not at the end of pasted text"); }
                                lines.push(if line == "\n" { String::new() } else { line });
                            }
                            ensure!(representation == embedded, "Text block structure changed");
                            let flattened = lines.join("\n");
                            ensure!(flattened.ends_with(&text), "Text blocks differ from pasted text");
                            let mut offset = flattened.chars().count() as i32 - count + prefix;
                            for (line, (_, child)) in lines.iter().zip(&children) {
                                let length = line.chars().count() as i32;
                                if offset <= length {
                                    let child_field = Proxy::new(&bus, name.as_str(), child.as_str(), "org.a11y.atspi.Text")?;
                                    let initial: i32 = child_field.get_property("CaretOffset")?;
                                    return Ok((path.clone(), end, child.clone(), initial, offset));
                                }
                                offset -= length + 1;
                            }
                            anyhow::bail!("Cursor text block unavailable")
                        })();
                        if let Err(error) = &candidate { if std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Cursor candidate rejected: {error:#}"); } }
                        if let Ok(candidate) = candidate { ensure!(matched.is_none(), "Ambiguous pasted text fields"); matched = Some(candidate); }
                    }
                    let (path, end, destination_path, initial, destination) = matched.context("No matching pasted text field")?;
                    return Ok((bus.clone(), name.clone(), path, end, destination_path, initial, destination));
                }
                anyhow::bail!("Target does not expose accessible text")
            })();
            if let Err(error) = &prepared { if std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Direct cursor unavailable: {error:#}"); } }
            let _ = sender.send(prepared);
            worker_active.store(false, Ordering::SeqCst);
        });
        if worker.is_err() { discovering.store(false, Ordering::SeqCst); return Ok(false); }
        // The worker only reads. A timed-out discovery can never move a caret later.
        let prepared = receiver.recv_timeout(Duration::from_millis(250)).ok().and_then(Result::ok);
        ensure!(current()?, "Cursor target changed during discovery");
        let (bus, name, path, end, destination_path, initial, destination) = match prepared { Some(value) => value, None => return Ok(false) };
        ensure!(Self::query("locked")?["locked"] == false && Self::query("activewindow")?["address"] == target, "Cursor target changed");
        let accessible = Proxy::new(&bus, name.as_str(), path.as_str(), "org.a11y.atspi.Accessible")?;
        let states: Vec<u32> = accessible.call("GetState", &())?;
        ensure!(states.first().is_some_and(|state| state & (1 << 12) != 0), "Cursor field lost focus");
        let field: Proxy = zbus::blocking::proxy::Builder::new(&bus).destination(name.as_str())?.path(path.as_str())?.interface("org.a11y.atspi.Text")?.cache_properties(zbus::proxy::CacheProperties::No).build()?;
        ensure!(field.get_property::<i32>("CaretOffset")? == end && field.call::<_, _, i32>("GetNSelections", &())? == 0, "Cursor changed after paste");
        let field: Proxy = zbus::blocking::proxy::Builder::new(&bus).destination(name.as_str())?.path(destination_path.as_str())?.interface("org.a11y.atspi.Text")?.cache_properties(zbus::proxy::CacheProperties::No).build()?;
        ensure!(field.get_property::<i32>("CaretOffset")? == initial, "Cursor text block changed");
        ensure!(current()?, "Cursor target changed before positioning");
        let moved: bool = field.call("SetCaretOffset", &(destination,))?;
        let deadline = std::time::Instant::now() + Duration::from_millis(100);
        loop {
            ensure!(current()?, "Cursor target changed after positioning");
            let actual: i32 = field.get_property("CaretOffset")?;
            if !moved && actual == initial { return Ok(false); }
            if moved && actual == destination { break; }
            ensure!(moved && std::time::Instant::now() < deadline, "Could not confirm cursor positioning; nothing retried");
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(true)
    }
    pub fn keyboard<'a>(devices: &'a serde_json::Value, device: &str) -> Result<&'a serde_json::Value> {
        let name = device.to_lowercase().replace([' ', '\n', ','], "-");
        let rows = devices["keyboards"].as_array().context("Keyboard information unavailable")?;
        let candidates: Vec<_> = rows.iter().filter(|row| row["name"].as_str().is_some_and(|value| value == name || value.strip_prefix(&format!("{name}-")).is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())))).collect();
        let first = candidates.first().copied().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotConnected, format!("Keyboard {device} is unavailable in Hyprland")))?;
        ensure!(candidates.iter().all(|row| ["layout", "variant", "options", "active_layout_index", "capsLock", "numLock"].iter().all(|field| row[*field] == first[*field])), "Ambiguous Hyprland layout for keyboard {device}; use identical layout and modifier options for these devices");
        Ok(first)
    }
    pub fn shortcut_conflicts(value: &str, binds: &serde_json::Value) -> Result<bool> {
        let (code, groups) = crate::panel::Panel::shortcut(value)?;
        let mask = groups.iter().map(|group| match group[0] { 29 => 4, 42 => 1, 56 => 8, 125 => 64, _ => 0 }).sum::<u64>();
        let name = value.rsplit('+').next().unwrap().to_lowercase();
        let symbol = match name.as_str() { "comma" => ",", "period" => ".", "slash" => "/", "semicolon" => ";", other => other };
        Ok(binds.as_array().is_some_and(|rows| rows.iter().any(|binding| binding["modmask"].as_u64() == Some(mask) && (binding["keycode"].as_u64() == Some(code as u64 + 8) || binding["key"].as_str().is_some_and(|key| key.eq_ignore_ascii_case(&name) || key.eq_ignore_ascii_case(symbol))))))
    }
    pub fn is_terminal(window: &serde_json::Value) -> bool {
        window["tags"].as_array().is_some_and(|tags| tags.iter().any(|tag| tag.as_str().is_some_and(|name| name.trim_end_matches('*') == "terminal")))
    }
    pub fn socket(name: &str) -> Result<PathBuf> {
        Ok(PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR is missing")?).join("hypr").join(std::env::var("HYPRLAND_INSTANCE_SIGNATURE")?).join(name))
    }
    pub fn query(command: &str) -> Result<serde_json::Value> {
        let mut stream = UnixStream::connect(Self::socket(".socket.sock")?)?;
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        stream.set_write_timeout(Some(Duration::from_millis(500)))?;
        stream.write_all(format!("j/{command}").as_bytes())?;
        let mut response = String::new();
        stream.take(1_048_576).read_to_string(&mut response)?;
        Ok(serde_json::from_str(&response)?)
    }
}

#[derive(Deserialize, Serialize)]
struct Identity { pid: u32, start: String, address: String }

pub struct Registration { path: PathBuf }
impl Registration {
    fn directory() -> Result<PathBuf> { Ok(PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR is missing")?).join("typerelay-tui")) }
    fn start_time(pid: u32) -> Option<String> {
        fs::read_to_string(format!("/proc/{pid}/stat")).ok()?.rsplit_once(") ")?.1.split_whitespace().nth(19).map(str::to_owned)
    }
    pub fn current_window() -> Result<Self> {
        let mut last = None;
        for _ in 0..20 {
            match Self::try_current_window() { Ok(registration) => return Ok(registration), Err(error) => last = Some(error) }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(last.unwrap())
    }
    pub fn panel(address: &str) -> Result<Self> {
        let active = Hyprland::query("activewindow")?;
        ensure!(active["pid"] == std::process::id() && active["address"] == address, "Panel does not own the focused window");
        Self::create(&Self::directory()?, address)
    }
    fn try_current_window() -> Result<Self> {
        let active = Hyprland::query("activewindow")?;
        ensure!(Hyprland::is_terminal(&active), "Focus the Omarchy terminal launching the TUI before starting it");
        let window_pid = active["pid"].as_u64().context("Cannot identify the terminal process")? as u32;
        let mut pid = std::process::id();
        let mut belongs_to_window = false;
        for _ in 0..64 {
            if pid == window_pid { belongs_to_window = true; break; }
            let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { break; };
            let Some(parent) = stat.rsplit_once(") ").and_then(|(_, fields)| fields.split_whitespace().nth(1)).and_then(|value| value.parse::<u32>().ok()) else { break; };
            if parent == 0 || parent == pid { break; }
            pid = parent;
        }
        ensure!(belongs_to_window, "Focus the terminal launching the TUI before starting it");
        let address = active["address"].as_str().filter(|s| *s != "0x0").context("Cannot identify the TUI window; launch from a focused Hyprland terminal")?;
        Self::create(&Self::directory()?, address)
    }
    fn create(directory: &Path, address: &str) -> Result<Self> {
        fs::create_dir_all(directory)?;
        ensure!(fs::metadata(directory)?.uid() == unsafe { libc::geteuid() }, "Runtime registry has a different owner");
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        let pid = std::process::id();
        let identity = Identity { pid, start: Self::start_time(pid).context("Cannot identify editor process")?, address: address.into() };
        let path = directory.join(format!("{pid}.json"));
        crate::editor::Paths::atomic_write(&path, &serde_json::to_vec(&identity)?, false)?;
        Ok(Self { path })
    }
    pub fn inhibited(address: &str) -> bool { Self::directory().is_ok_and(|directory| Self::inhibited_in(&directory, address)) }
    fn inhibited_in(directory: &Path, address: &str) -> bool {
        let Ok(entries) = fs::read_dir(directory) else { return false; };
        for entry in entries.flatten().take(256) {
            let Ok(metadata) = entry.metadata() else { continue; };
            if !entry.file_type().is_ok_and(|t| t.is_file()) || metadata.uid() != unsafe { libc::geteuid() } || metadata.len() > 8192 { continue; }
            let Ok(bytes) = fs::read(entry.path()) else { continue; };
            let Ok(identity) = serde_json::from_slice::<Identity>(&bytes) else { continue; };
            if identity.address == address && Self::start_time(identity.pid).as_ref() == Some(&identity.start) { return true; }
        }
        false
    }
}

impl Drop for Registration { fn drop(&mut self) { let _ = fs::remove_file(&self.path); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_cursor_discovery_falls_back_without_spawning_or_clearing_worker() {
        let busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        assert!(!Hyprland::position_cursor("unused", "text", 0, &busy, || Ok(true)).unwrap());
        assert!(busy.load(std::sync::atomic::Ordering::SeqCst));
        assert!(Hyprland::position_cursor("unused", "text", 0, &busy, || Ok(false)).is_err());
    }
    #[test]
    fn shortcut_conflicts_accept_keysym_names_symbols_and_keycodes() {
        for binding in [serde_json::json!({"modmask":5,"key":"semicolon"}),serde_json::json!({"modmask":5,"key":";"}),serde_json::json!({"modmask":5,"keycode":47})] { assert!(Hyprland::shortcut_conflicts("Ctrl+Shift+Semicolon", &serde_json::json!([binding])).unwrap()); }
        assert!(!Hyprland::shortcut_conflicts("Ctrl+Shift+Semicolon", &serde_json::json!([{"modmask":4,"key":"semicolon"}])).unwrap());
    }
    #[test]
    fn launching_app_cannot_be_mistaken_for_editor_terminal() {
        assert!(!Hyprland::is_terminal(&serde_json::json!({"class": "chatgpt", "tags": ["default-opacity*"]})));
        assert!(Hyprland::is_terminal(&serde_json::json!({"class": "foot", "tags": ["terminal*"]})));
    }
    #[test]
    fn window_scoped_live_registration_and_stale_identity() {
        let dir = tempfile::tempdir().unwrap();
        let registration = Registration::create(dir.path(), "0xabc").unwrap();
        assert!(Registration::inhibited_in(dir.path(), "0xabc"));
        assert!(!Registration::inhibited_in(dir.path(), "0xdef"));
        let stale = Identity { pid: std::process::id(), start: "different-process-start".into(), address: "0xabc".into() };
        fs::write(&registration.path, serde_json::to_vec(&stale).unwrap()).unwrap();
        assert!(!Registration::inhibited_in(dir.path(), "0xabc"));
        drop(registration);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod keyboard_resolution_tests {
    use super::*;
    #[test]
    fn composite_interface_suffix_is_not_a_disconnected_keyboard() {
        for suffix in ["", "-1", "-17"] {let name=format!("kinesis-advantage2-keyboard{suffix}");let devices=serde_json::json!({"mice":[{"name":"kinesis-advantage2-keyboard"}],"keyboards":[{"name":name,"layout":"us"}]});assert_eq!(Hyprland::keyboard(&devices,"Kinesis Advantage2 Keyboard").unwrap()["layout"],"us");}
    }
    #[test]
    fn ambiguous_layout_is_rejected_even_when_one_name_is_exact() {
        let mut devices=serde_json::json!({"keyboards":[{"name":"usb-keyboard","layout":"us","options":"ctrl:nocaps"},{"name":"usb-keyboard-1","layout":"us","options":"ctrl:nocaps"}]});assert!(Hyprland::keyboard(&devices,"USB Keyboard").is_ok());
        for (field,value) in [("layout","de"),("options",""),("variant","intl")] {let old=devices["keyboards"][1][field].clone();devices["keyboards"][1][field]=value.into();assert!(Hyprland::keyboard(&devices,"USB Keyboard").is_err());devices["keyboards"][1][field]=old;}
    }
    #[test]
    fn consumer_interface_and_main_keyboard_are_never_guessed() {
        let devices=serde_json::json!({"keyboards":[{"name":"usb-keyboard-consumer-control","main":true},{"name":"usb-keyboard-1-extra"},{"name":"other-keyboard"}]});assert!(Hyprland::keyboard(&devices,"USB Keyboard").is_err());
    }
}
