use anyhow::{Context, Result, bail, ensure};
use std::process::Command;

pub struct Installer;

impl Installer {
    #[cfg(feature = "legacy-install")]
    pub fn run(action: &str, dry_run: bool, device_name: Option<&str>, panel_launcher: Option<&std::path::Path>, check: bool, automatic: bool) -> Result<()> {
        let mut command = Command::new("/usr/bin/python3");
        command.arg("-c").arg(include_str!("../../../scripts/installer.py")).arg(action).arg(std::env::current_exe()?).arg(include_str!("../../../scripts/session-access.py"));
        if dry_run { command.arg("--dry-run"); }
        if let Some(name) = device_name { command.args(["--device-name", name]); }
        if let Some(panel) = panel_launcher { command.arg("--panel-launcher").arg(panel); }
        if check { command.arg("--check"); }
        if automatic { command.arg("--automatic"); }
        if !command.status()?.success() { bail!("Installer did not complete; see the message above"); }
        Ok(())
    }

    pub fn devices() -> Result<Vec<(String, std::path::PathBuf, String)>> {
        let mut devices = Vec::new();
        for entry in std::fs::read_dir("/sys/class/input")? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.strip_prefix("event").is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())) { continue; }
            let path = std::path::Path::new("/dev/input").join(name.as_ref());
            let properties = Command::new("/usr/bin/udevadm").args(["info", "--query=property", "--name"]).arg(&path).output()?;
            ensure!(properties.status.success(), "Could not inspect input device {}", path.display());
            devices.push((std::fs::read_to_string(entry.path().join("device/name"))?.trim().into(), path, String::from_utf8(properties.stdout)?));
        }
        Ok(devices)
    }

    pub fn select_keyboard(devices: &[(String, std::path::PathBuf, String)], requested: Option<&str>) -> Result<String> {
        let keyboards: Vec<_> = devices.iter().filter(|(_, _, properties)| properties.lines().any(|p| p == "ID_INPUT_KEYBOARD=1")).collect();
        let keyd = keyboards.iter().any(|(name, _, _)| name == "keyd virtual keyboard");
        if keyd && requested.is_some_and(|name| name != "keyd virtual keyboard") { bail!("Stop keyd before selecting a physical keyboard"); }
        let internal = keyboards.iter().any(|(_, _, properties)| properties.lines().any(|p| p == "ID_INTEGRATION=internal"));
        let candidates: Vec<_> = keyboards.into_iter().filter(|(name, _, properties)| {
            if let Some(requested) = requested { name == requested }
            else if keyd { name == "keyd virtual keyboard" }
            else if internal { properties.lines().any(|p| p == "ID_INTEGRATION=internal") }
            else { !name.to_lowercase().contains("virtual") }
        }).collect();
        ensure!(candidates.len() == 1, "Select exactly one keyboard with --device-name");
        Ok(candidates[0].0.clone())
    }

    pub fn keyboard() -> Result<String> {
        // Preserve the keyboard selected by an earlier managed installation.
        let data = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or(std::path::PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".local/share"));
        let state = data.join("typerelay/installation.json");
        let state: serde_json::Value = if state.exists() { serde_json::from_slice(&std::fs::read(state)?)? } else { serde_json::Value::Null };
        Self::select_keyboard(&Self::devices()?, state["device_name"].as_str())
    }

    pub fn input_paths(devices: &[(String, std::path::PathBuf, String)], keyboard: &str) -> Vec<(std::path::PathBuf, bool)> {
        let mut paths = vec![(std::path::PathBuf::from("/dev/uinput"), true)];
        paths.extend(devices.iter().filter(|(name, _, properties)| name == keyboard || properties.lines().any(|p| matches!(p, "ID_INPUT_MOUSE=1" | "ID_INPUT_TOUCHPAD=1" | "ID_INPUT_TOUCHSCREEN=1"))).map(|(_, path, _)| (path.clone(), false)));
        paths
    }

    pub fn has_access(keyboard: &str) -> Result<bool> {
        use std::os::unix::ffi::OsStrExt;
        Ok(Self::input_paths(&Self::devices()?, keyboard).iter().all(|(path, write)| std::ffi::CString::new(path.as_os_str().as_bytes()).is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::R_OK | if *write { libc::W_OK } else { 0 }) == 0 })))
    }

    pub fn grant_input_access(requested: &str) -> Result<()> {
        ensure!(unsafe { libc::geteuid() } == 0, "Input access requires native administrator authentication");
        let uid: u32 = std::env::var("PKEXEC_UID").context("Run input access through pkexec")?.parse()?;
        ensure!(uid > 0, "Input access is only for a desktop user");
        // Select from trusted kernel/udev device information; no caller-provided paths or UID.
        let devices = Self::devices()?;
        let keyboard = Self::select_keyboard(&devices, Some(requested))?;
        ensure!(Command::new("modprobe").arg("uinput").status()?.success(), "Could not load uinput");
        for (path, write) in Self::input_paths(&devices, &keyboard) {
            ensure!(Command::new("/usr/bin/setfacl").args(["-m", &format!("u:{uid}:{}", if write { "rw" } else { "r" })]).arg(&path).status()?.success(), "Could not grant access to {}", path.display());
        }
        Ok(())
    }

    pub fn prepare_package_service(package: bool) -> Result<()> {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or(std::path::PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".config"));
        let unit = config.join("systemd/user/typerelay.service");
        let managed = if unit.exists() { ensure!(std::fs::read_to_string(&unit)?.starts_with("# Managed by TypeRelay"), "An unmanaged typerelay.service exists; keep it or remove it manually before using the package"); true } else { false };
        let packaged = std::path::Path::new("/usr/lib/systemd/user/typerelay.service").is_file();
        if managed || packaged {
            ensure!(Command::new("systemctl").args(["--user", "stop", "typerelay.service"]).status()?.success(), "Could not stop the previous expansion service");
            ensure!(Command::new("systemctl").args(["--user", "disable", "typerelay.service"]).status()?.success(), "Could not disable the previous expansion service");
        }
        if managed { std::fs::remove_file(unit)?; }
        if package {
            ensure!(packaged, "The package is missing its expansion service");
            for arguments in [vec!["--user", "daemon-reload"], vec!["--user", "import-environment", "WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_RUNTIME_DIR"], vec!["--user", "enable", "--now", "typerelay.service"]] {
                ensure!(Command::new("systemctl").args(arguments).status()?.success(), "Could not start the packaged expansion service");
            }
        }
        Ok(())
    }

    pub fn desktop_entry(launcher: &std::path::Path, tui: bool) -> Result<String> {
        let launcher = launcher.to_str().context("AppImage path is not valid UTF-8")?;
        ensure!(!launcher.chars().any(|c| c.is_control()), "Invalid AppImage launcher path");
        let launcher = launcher.replace('\\', "\\\\\\\\").replace('"', "\\\"").replace('`', "\\`").replace('$', "\\$").replace('%', "%%");
        Ok(format!("# Managed by TypeRelay\n[Desktop Entry]\nType=Application\nName=Typerelay{}\nExec=\"{launcher}\"{}\nIcon=typerelay\nTerminal=false\nCategories=Utility;\n", if tui { " TUI" } else { "" }, if tui { " --tui" } else { "" }))
    }

    pub fn register_appimage(launcher: &std::path::Path, icon: &[u8]) -> Result<()> {
        let data = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or(std::path::PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".local/share"));
        let applications = data.join("applications");
        let icons = data.join("icons/hicolor/128x128/apps");
        std::fs::create_dir_all(&applications)?;
        std::fs::create_dir_all(&icons)?;
        std::fs::write(icons.join("typerelay.png"), icon)?;
        for (name, tui) in [("typerelay-panel.desktop", false), ("typerelay-tui.desktop", true)] {
            let path = applications.join(name);
            if path.exists() {
                let text = std::fs::read_to_string(&path)?;
                ensure!(text.starts_with("# Managed by TypeRelay") || name == "typerelay-panel.desktop" && text.contains("/.local/bin/typerelay-panel"), "An unmanaged desktop launcher exists: {}", path.display());
            }
            let temporary = path.with_extension("desktop.new");
            std::fs::write(&temporary, Self::desktop_entry(launcher, tui)?)?;
            std::fs::rename(temporary, path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appimage_launchers_keep_paths_and_tui_inside_the_bundle() {
        let path = std::path::Path::new("/home/user/My Apps/TypeRelay%1.AppImage");
        let entry = Installer::desktop_entry(path, true).unwrap();
        assert!(entry.contains("Exec=\"/home/user/My Apps/TypeRelay%%1.AppImage\" --tui"));
        assert!(entry.contains("Terminal=false"));
        assert!(!entry.contains(".local/bin"));
        assert!(Installer::desktop_entry(std::path::Path::new("/tmp/bad\npath"), false).is_err());
    }
    #[test]
    fn native_access_selects_one_keyboard_and_only_required_devices() {
        let devices = vec![
            ("Built-in keyboard".into(), "/dev/input/event1".into(), "ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into()),
            ("USB keyboard".into(), "/dev/input/event2".into(), "ID_INPUT_KEYBOARD=1\n".into()),
            ("Mouse".into(), "/dev/input/event3".into(), "ID_INPUT_MOUSE=1\n".into()),
        ];
        let keyboard = Installer::select_keyboard(&devices, None).unwrap();
        assert_eq!(keyboard, "Built-in keyboard");
        assert_eq!(Installer::input_paths(&devices, &keyboard), vec![("/dev/uinput".into(), true), ("/dev/input/event1".into(), false), ("/dev/input/event3".into(), false)]);
        assert_eq!(Installer::select_keyboard(&devices, Some("USB keyboard")).unwrap(), "USB keyboard");
        assert!(Installer::select_keyboard(&devices, Some("Missing keyboard")).is_err());
    }
    #[test]
    fn keyd_is_preferred_and_ambiguous_selection_is_rejected() {
        let mut devices = vec![("First keyboard".into(), "/dev/input/event1".into(), "ID_INPUT_KEYBOARD=1\n".into()), ("Second keyboard".into(), "/dev/input/event2".into(), "ID_INPUT_KEYBOARD=1\n".into())];
        assert!(Installer::select_keyboard(&devices, None).is_err());
        devices.push(("keyd virtual keyboard".into(), "/dev/input/event3".into(), "ID_INPUT_KEYBOARD=1\n".into()));
        assert_eq!(Installer::select_keyboard(&devices, None).unwrap(), "keyd virtual keyboard");
        assert!(Installer::select_keyboard(&devices, Some("First keyboard")).is_err());
    }
}
