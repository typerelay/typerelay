use crate::config::FileStore;
use anyhow::{Context, Result, bail};
use evdev::{Device, EventType, InputEvent, KeyCode, InputId, BusType, uinput::VirtualDevice};
use fs2::FileExt;
use std::{collections::{BTreeSet, VecDeque}, fs, io::{Read, Write}, os::unix::net::UnixStream, path::PathBuf, process::Command, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use typerelay_core::{Engine, Input, Expansion};

pub struct Session;

struct ContextWatch {
    stream: UnixStream,
    pending: String,
    pointers: Vec<Device>,
}

impl ContextWatch {
    fn connect() -> Result<Self> {
        let runtime = std::env::var("XDG_RUNTIME_DIR")?;
        let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")?;
        let stream = UnixStream::connect(format!("{runtime}/hypr/{signature}/.socket2.sock"))?;
        stream.set_nonblocking(true)?;
        let mut pointers = Vec::new();
        for (path, _) in Session::devices()? {
            let props = Command::new("udevadm").args(["info", "--query=property", "--name"]).arg(&path).output()?;
            let props = String::from_utf8_lossy(&props.stdout);
            if props.lines().any(|p| p == "ID_INPUT_MOUSE=1" || p == "ID_INPUT_TOUCHPAD=1" || p == "ID_INPUT_TOUCHSCREEN=1") {
                let device = Device::open(&path).with_context(|| format!("Pointer access needed for click cancellation: {}", path.display()))?;
                device.set_nonblocking(true)?;
                pointers.push(device);
            }
        }
        if pointers.is_empty() { bail!("No pointer device available for click cancellation"); }
        Ok(Self { stream, pending: String::new(), pointers })
    }

    fn changed(&mut self) -> Result<bool> {
        let mut changed = false;
        let mut bytes = [0; 4096];
        loop {
            match self.stream.read(&mut bytes) {
                Ok(0) => bail!("Hyprland event connection closed"),
                Ok(n) => self.pending.push_str(&String::from_utf8_lossy(&bytes[..n])),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        while let Some(end) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=end).collect();
            if ["activewindow", "workspace", "focusedmon", "activespecial", "openlayer", "closelayer", "configreloaded"].iter().any(|prefix| line.starts_with(prefix)) { changed = true; }
        }
        if self.pending.len() > 65536 { bail!("Oversized Hyprland event"); }
        for device in &mut self.pointers {
            match device.fetch_events() {
                Ok(events) => {
                    // Conservative: movement, scrolling and touch also cancel the candidate.
                    if events.into_iter().any(|e| e.event_type() != EventType::SYNCHRONIZATION) { changed = true; }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(e) => return Err(e.into()),
            }
        }
        Ok(changed)
    }
}

impl Session {
    fn devices() -> Result<Vec<(PathBuf, String)>> {
        let mut devices = Vec::new();
        for entry in fs::read_dir("/sys/class/input")? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("event") {
                devices.push((PathBuf::from("/dev/input").join(name), fs::read_to_string(entry.path().join("device/name"))?.trim().into()));
            }
        }
        Ok(devices)
    }

    fn hypr(command: &str) -> Result<serde_json::Value> {
        let runtime = std::env::var("XDG_RUNTIME_DIR")?;
        let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")?;
        let mut stream = UnixStream::connect(format!("{runtime}/hypr/{signature}/.socket.sock"))?;
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        stream.set_write_timeout(Some(Duration::from_millis(500)))?;
        stream.write_all(format!("j/{command}").as_bytes())?;
        let mut response = String::new();
        stream.take(1_048_576).read_to_string(&mut response)?;
        Ok(serde_json::from_str(&response)?)
    }

    fn target() -> Result<Option<String>> {
        if Self::hypr("locked")?["locked"].as_bool() != Some(false) { return Ok(None); }
        let active = Self::hypr("activewindow")?;
        Ok(active["address"].as_str().filter(|s| *s != "0x0").map(str::to_owned))
    }

    pub fn doctor() -> Result<()> {
        println!("Wayland: {}", std::env::var("WAYLAND_DISPLAY").unwrap_or_default());
        println!("Hyprland reachable: {}", Self::hypr("locked").is_ok());
        println!("uinput writable: {}", fs::OpenOptions::new().write(true).open("/dev/uinput").is_ok());
        for (path, name) in Self::devices()? {
            if name == "keyd virtual keyboard" {
                println!("Keyboard: {} ({name}), readable: {}", path.display(), Device::open(&path).is_ok());
            }
        }
        println!("Pointer/context access: {}", ContextWatch::connect().is_ok());
        Ok(())
    }

    fn input(code: KeyCode) -> Input {
        match code {
            KeyCode::KEY_SPACE => Input::Space,
            KeyCode::KEY_BACKSPACE => Input::Backspace,
            KeyCode::KEY_COMMA => Input::Character(','),
            KeyCode::KEY_MINUS => Input::Character('-'),
            _ => {
                let keys = [(KeyCode::KEY_A, 'a'), (KeyCode::KEY_B, 'b'), (KeyCode::KEY_C, 'c'), (KeyCode::KEY_D, 'd'), (KeyCode::KEY_E, 'e'), (KeyCode::KEY_F, 'f'), (KeyCode::KEY_G, 'g'), (KeyCode::KEY_H, 'h'), (KeyCode::KEY_I, 'i'), (KeyCode::KEY_J, 'j'), (KeyCode::KEY_K, 'k'), (KeyCode::KEY_L, 'l'), (KeyCode::KEY_M, 'm'), (KeyCode::KEY_N, 'n'), (KeyCode::KEY_O, 'o'), (KeyCode::KEY_P, 'p'), (KeyCode::KEY_Q, 'q'), (KeyCode::KEY_R, 'r'), (KeyCode::KEY_S, 's'), (KeyCode::KEY_T, 't'), (KeyCode::KEY_U, 'u'), (KeyCode::KEY_V, 'v'), (KeyCode::KEY_W, 'w'), (KeyCode::KEY_X, 'x'), (KeyCode::KEY_Y, 'y'), (KeyCode::KEY_Z, 'z'), (KeyCode::KEY_0, '0'), (KeyCode::KEY_1, '1'), (KeyCode::KEY_2, '2'), (KeyCode::KEY_3, '3'), (KeyCode::KEY_4, '4'), (KeyCode::KEY_5, '5'), (KeyCode::KEY_6, '6'), (KeyCode::KEY_7, '7'), (KeyCode::KEY_8, '8'), (KeyCode::KEY_9, '9')];
                keys.iter().find(|(key, _)| *key == code).map_or(Input::Cancel, |(_, c)| Input::Character(*c))
            }
        }
    }

    fn stroke(key: KeyCode, shift: bool) -> Vec<InputEvent> {
        let mut events = Vec::new();
        if shift { events.push(InputEvent::new(EventType::KEY.0, KeyCode::KEY_LEFTSHIFT.0, 1)); }
        events.push(InputEvent::new(EventType::KEY.0, key.0, 1));
        events.push(InputEvent::new(EventType::KEY.0, key.0, 0));
        if shift { events.push(InputEvent::new(EventType::KEY.0, KeyCode::KEY_LEFTSHIFT.0, 0)); }
        events
    }

    fn replacement_key(character: char) -> Result<(KeyCode, bool)> {
        for raw in 1..256 {
            let key = KeyCode(raw);
            if let Input::Character(c) = Self::input(key)
                && c == character.to_ascii_lowercase() { return Ok((key, character.is_ascii_uppercase())); }
        }
        let unshifted = " =[];'`\\./";
        let shifted = ")!@#$%^&*(+{}_:\"~|<>?";
        let keys = [KeyCode::KEY_SPACE, KeyCode::KEY_EQUAL, KeyCode::KEY_LEFTBRACE, KeyCode::KEY_RIGHTBRACE, KeyCode::KEY_SEMICOLON, KeyCode::KEY_APOSTROPHE, KeyCode::KEY_GRAVE, KeyCode::KEY_BACKSLASH, KeyCode::KEY_DOT, KeyCode::KEY_SLASH];
        if let Some(index) = unshifted.chars().position(|c| c == character) { return Ok((keys[index], false)); }
        let keys = [KeyCode::KEY_0, KeyCode::KEY_1, KeyCode::KEY_2, KeyCode::KEY_3, KeyCode::KEY_4, KeyCode::KEY_5, KeyCode::KEY_6, KeyCode::KEY_7, KeyCode::KEY_8, KeyCode::KEY_9, KeyCode::KEY_EQUAL, KeyCode::KEY_LEFTBRACE, KeyCode::KEY_RIGHTBRACE, KeyCode::KEY_MINUS, KeyCode::KEY_SEMICOLON, KeyCode::KEY_APOSTROPHE, KeyCode::KEY_GRAVE, KeyCode::KEY_BACKSLASH, KeyCode::KEY_COMMA, KeyCode::KEY_DOT, KeyCode::KEY_SLASH];
        if let Some(index) = shifted.chars().position(|c| c == character) { return Ok((keys[index], true)); }
        bail!("Unsupported replacement character")
    }

    fn inject(expansion: &Expansion) -> Result<VecDeque<Vec<InputEvent>>> {
        let mut strokes = VecDeque::new();
        for _ in 0..expansion.erase { strokes.push_back(Self::stroke(KeyCode::KEY_BACKSPACE, false)); }
        for c in expansion.text.chars() {
            let (key, shift) = Self::replacement_key(c)?;
            strokes.push_back(Self::stroke(key, shift));
        }
        Ok(strokes)
    }

    pub fn run(mut store: FileStore, device_name: &str) -> Result<()> {
        if unsafe { libc::geteuid() } == 0 { bail!("Run the client as your desktop user, not root"); }
        let runtime = std::env::var("XDG_RUNTIME_DIR")?;
        let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(PathBuf::from(runtime).join("typerelay.lock"))?;
        lock.try_lock_exclusive().context("Another TypeRelay client is already running")?;
        let devices = Self::hypr("devices")?;
        let keyboards = devices["keyboards"].as_array().context("No Hyprland keyboard information")?;
        if keyboards.iter().any(|k| k["layout"].as_str() != Some("us") || k["capsLock"].as_bool() == Some(true)) { bail!("POC requires US-only layouts and Caps Lock off"); }
        if keyboards.iter().any(|k| k["name"].as_str() == Some("espanso-virtual-device")) { bail!("Pause Espanso with `espanso stop` before running TypeRelay"); }
        let selected: Vec<_> = Self::devices()?.into_iter().filter(|(_, n)| n == device_name).collect();
        if selected.len() != 1 { bail!("Expected exactly one keyboard named {device_name}"); }
        let mut keyboard = Device::open(&selected[0].0).context("Keyboard unavailable; use the session access setup")?;
        keyboard.set_nonblocking(true)?;
        if keyboard.get_key_state()?.iter().next().is_some() { bail!("Release all keys before starting"); }
        let mut context = ContextWatch::connect()?;
        // keyd reserves vendor 0x0fac for virtual devices and ignores them, preventing feedback.
        let mut output = VirtualDevice::builder()?.name("TypeRelay virtual keyboard").input_id(InputId::new(BusType::BUS_VIRTUAL, 0x0fac, 0x5452, 1)).with_keys(keyboard.supported_keys().context("Not a keyboard")?)?.build()?;
        thread::sleep(Duration::from_millis(300));
        keyboard.grab()?;
        let running = Arc::new(AtomicBool::new(true));
        let signal = running.clone();
        ctrlc::set_handler(move || signal.store(false, Ordering::SeqCst))?;
        let mut engine = Engine::new(store.snapshot.clone());
        let mut pressed = BTreeSet::new();
        let mut suppressed_space = false;
        let mut target = None;
        let mut last_reload = Instant::now();
        let mut last_input = Instant::now();
        let mut caps = false;
        let mut buffered = VecDeque::new();
        let mut insertion = VecDeque::<Vec<InputEvent>>::new();
        let mut last_stroke = Instant::now();
        eprintln!("TypeRelay running: {} snippets; comma + abbreviation + Space. Ctrl+C stops. No keystrokes are logged.", store.snapshot.len());
        while running.load(Ordering::SeqCst) {
            if context.changed()? || last_input.elapsed() > Duration::from_secs(10) { engine.feed(Input::Cancel); target = None; insertion.clear(); }
            if last_reload.elapsed() > Duration::from_millis(500) {
                match store.reload() {
                    Ok(Some(snapshot)) => { engine.replace_snapshot(snapshot); eprintln!("Snippet snapshot reloaded"); }
                    Ok(None) => (),
                    Err(_) => eprintln!("Snippet reload rejected; keeping last valid snapshot"),
                }
                last_reload = Instant::now();
            }
            let events: Vec<InputEvent> = match keyboard.fetch_events() {
                Ok(events) => events.collect(),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Vec::new(),
                Err(e) => return Err(e.into()),
            };
            buffered.extend(events);
            if buffered.len() > 8192 { bail!("Input backlog exceeded safety limit; stopping"); }
            if !insertion.is_empty() {
                if last_stroke.elapsed() >= Duration::from_millis(2) {
                    if let Some(stroke) = insertion.pop_front() {
                        for event in stroke { output.emit(&[event])?; }
                    }
                    last_stroke = Instant::now();
                }
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            while let Some(event) = buffered.pop_front() {
                if event.event_type() != EventType::KEY { continue; }
                let code = KeyCode(event.code());
                if suppressed_space && code == KeyCode::KEY_SPACE {
                    if event.value() == 0 { suppressed_space = false; }
                    continue;
                }
                if event.value() == 0 { pressed.remove(&code.0); }
                if event.value() == 1 { pressed.insert(code.0); }
                if event.value() != 0 {
                    last_input = Instant::now();
                    if code == KeyCode::KEY_CAPSLOCK && event.value() == 1 { caps = !caps; }
                    let modifiers = [KeyCode::KEY_LEFTSHIFT, KeyCode::KEY_RIGHTSHIFT, KeyCode::KEY_LEFTCTRL, KeyCode::KEY_RIGHTCTRL, KeyCode::KEY_LEFTALT, KeyCode::KEY_RIGHTALT, KeyCode::KEY_LEFTMETA, KeyCode::KEY_RIGHTMETA];
                    if caps || modifiers.iter().any(|key| pressed.contains(&key.0)) {
                        engine.feed(Input::Cancel);
                    } else {
                        if context.changed()? { engine.feed(Input::Cancel); target = None; }
                        if code == KeyCode::KEY_COMMA { target = Self::target()?; if std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Candidate target available: {}", target.is_some()); } }
                        let expansion = if target.is_some() { engine.feed(Self::input(code)) } else { engine.feed(Input::Cancel); None };
                        if expansion.is_some() && std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Match found; held-key count {}", pressed.len()); }
                        if let Some(expansion) = expansion
                            && Self::target()? == target && !context.changed()? && pressed.len() == 1 {
                                insertion = Self::inject(&expansion)?;
                                pressed.remove(&code.0);
                                suppressed_space = true;
                                target = None;
                                break;
                        }
                    }
                }
                output.emit(&[event])?;
            }
            thread::sleep(Duration::from_millis(1));
        }
        for code in pressed { output.emit(&[InputEvent::new(EventType::KEY.0, code, 0)])?; }
        keyboard.ungrab()?;
        eprintln!("TypeRelay stopped");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_printable_ascii_character_has_a_stroke() {
        for byte in 32u8..=126 { assert!(Session::replacement_key(byte as char).is_ok(), "Missing ASCII {byte}"); }
        assert!(Session::replacement_key('é').is_err());
    }
    #[test]
    fn shifted_punctuation_and_case() {
        assert_eq!(Session::replacement_key('A').unwrap(), (KeyCode::KEY_A, true));
        assert_eq!(Session::replacement_key('?').unwrap(), (KeyCode::KEY_SLASH, true));
        assert_eq!(Session::replacement_key('@').unwrap(), (KeyCode::KEY_2, true));
        assert_eq!(Session::replacement_key(' ').unwrap(), (KeyCode::KEY_SPACE, false));
    }
}
