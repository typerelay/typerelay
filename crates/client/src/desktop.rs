use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, os::unix::{fs::{MetadataExt, PermissionsExt}, net::UnixStream}, path::{Path, PathBuf}, time::Duration};

pub struct Hyprland;
impl Hyprland {
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
