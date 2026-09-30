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

    pub fn keyboard_devices(devices: &[(String, std::path::PathBuf, String)]) -> Vec<&(String, std::path::PathBuf, String)> {
        devices.iter().filter(|(_, _, properties)| properties.lines().any(|p| p == "ID_INPUT_KEYBOARD=1")).collect()
    }

    pub fn select_keyboard(devices: &[(String, std::path::PathBuf, String)], requested: Option<&str>) -> Result<String> {
        let keyboards = Self::keyboard_devices(devices);
        let available=keyboards.iter().map(|(name,_,_)|name.as_str()).collect::<Vec<_>>().join(", ");
        let keyd = keyboards.iter().any(|(name, _, _)| name == "keyd virtual keyboard");
        if keyd && requested.is_some_and(|name| name != "keyd virtual keyboard") { bail!("Stop keyd before selecting a physical keyboard"); }
        let internal = keyboards.iter().any(|(_, _, properties)| properties.lines().any(|p| p == "ID_INTEGRATION=internal"));
        let candidates: Vec<_> = keyboards.into_iter().filter(|(name, _, properties)| {
            if let Some(requested) = requested { name == requested }
            else if keyd { name == "keyd virtual keyboard" }
            else if internal { properties.lines().any(|p| p == "ID_INTEGRATION=internal") }
            else { !name.to_lowercase().contains("virtual") }
        }).collect();
        ensure!(candidates.len() == 1, "Choose your keyboard in Settings → General (terminal: --device-name). Available keyboards: {available}");
        Ok(candidates[0].0.clone())
    }

    pub fn keyboard() -> Result<String> {
        let settings = crate::panel::Panel::settings(&crate::editor::Paths::config_dir()?)?;
        if !settings.keyboard.is_empty() { return Self::select_keyboard(&Self::devices()?, Some(&settings.keyboard)); }
        // Preserve the keyboard selected by an earlier managed installation.
        let data = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or(std::path::PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".local/share"));
        let state = data.join("typerelay/installation.json");
        let state: serde_json::Value = if state.exists() { serde_json::from_slice(&std::fs::read(state)?)? } else { serde_json::Value::Null };
        Self::select_keyboard(&Self::devices()?, state["device_name"].as_str())
    }

    pub fn input_paths(devices: &[(String, std::path::PathBuf, String)], keyboard: &str) -> Vec<(std::path::PathBuf, bool)> {
        let mut paths = vec![(std::path::PathBuf::from("/dev/uinput"), true)];
        paths.extend(devices.iter().filter(|(name, _, properties)| properties.lines().any(|p| p == "ID_INPUT_KEYBOARD=1" && name == keyboard || matches!(p, "ID_INPUT_MOUSE=1" | "ID_INPUT_TOUCHPAD=1" | "ID_INPUT_TOUCHSCREEN=1"))).map(|(_, path, _)| (path.clone(), false)));
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
        Self::persist_input_access(std::path::Path::new("/"), uid, &keyboard)?;
        ensure!(Command::new("modprobe").arg("uinput").status()?.success(), "Could not load uinput");
        ensure!(Command::new("/usr/bin/udevadm").args(["control", "--reload-rules"]).status()?.success(), "Could not reload keyboard access rules");
        for (path, write) in Self::input_paths(&devices, &keyboard) {
            ensure!(Command::new("/usr/bin/setfacl").args(["-m", &format!("u:{uid}:{}", if write { "rw" } else { "r" })]).arg(&path).status()?.success(), "Could not grant access to {}", path.display());
        }
        Ok(())
    }

    fn persist_input_access(root: &std::path::Path, uid: u32, keyboard: &str) -> Result<()> {
        ensure!(uid > 0, "Input access is only for a desktop user");
        ensure!(!keyboard.is_empty() && !keyboard.chars().any(|c| c.is_control() || "\"\\*?[]|$%".contains(c)), "Keyboard name contains unsupported udev-rule characters");
        let access = format!("RUN+=\"/usr/bin/setfacl -m u:{uid}:r $env{{DEVNAME}}\"");
        let mut rules = format!("# Managed by TypeRelay\nACTION!=\"remove\", SUBSYSTEM==\"input\", KERNEL==\"event*\", ENV{{ID_INPUT_KEYBOARD}}==\"1\", ATTRS{{name}}==\"{keyboard}\", {access}\n");
        for kind in ["MOUSE", "TOUCHPAD", "TOUCHSCREEN"] { rules.push_str(&format!("ACTION!=\"remove\", SUBSYSTEM==\"input\", KERNEL==\"event*\", ENV{{ID_INPUT_{kind}}}==\"1\", {access}\n")); }
        rules.push_str(&format!("ACTION!=\"remove\", SUBSYSTEM==\"misc\", KERNEL==\"uinput\", RUN+=\"/usr/bin/setfacl -m u:{uid}:rw $env{{DEVNAME}}\"\n"));
        Self::write_managed(&[
            (root.join(format!("etc/udev/rules.d/99-typerelay-{uid}.rules")), rules, 0o644),
            (root.join(format!("etc/modules-load.d/typerelay-{uid}.conf")), "# Managed by TypeRelay\nuinput\n".into(), 0o644),
        ])
    }

    fn write_managed(files: &[(std::path::PathBuf, String, u32)]) -> Result<()> {
        use std::{io::Write, os::unix::fs::PermissionsExt};
        for (path, _, _) in files {
            if let Ok(metadata) = std::fs::symlink_metadata(path) { ensure!(metadata.is_file() && std::fs::read_to_string(path)?.lines().take(2).any(|line| line == "# Managed by TypeRelay"), "Refusing to overwrite unmanaged file: {}", path.display()); }
        }
        for (path, text, mode) in files {
            let directory = path.parent().context("Installation directory is missing")?;
            std::fs::create_dir_all(directory)?;
            let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
            temporary.write_all(text.as_bytes())?;
            temporary.as_file().set_permissions(std::fs::Permissions::from_mode(*mode))?;
            temporary.persist(path)?;
        }
        Ok(())
    }

    pub fn appimage_commands(root: &std::path::Path, install: bool) -> Result<bool> {
        use std::os::unix::fs::PermissionsExt;
        let text = include_str!("../../../scripts/appimage-cli.sh");
        let files: Vec<_> = ["typerelay", "typerelay-tui"].into_iter().map(|name| (root.join("usr/local/bin").join(name), text.to_owned(), 0o755)).collect();
        if install { Self::write_managed(&files)?; }
        Ok(files.iter().all(|(path, _, _)| std::fs::read_to_string(path).is_ok_and(|content| content == text) && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)))
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
        Self::register_appimage_at(&data, launcher, icon)
    }

    fn register_appimage_at(data: &std::path::Path, launcher: &std::path::Path, icon: &[u8]) -> Result<()> {
        let applications = data.join("applications");
        let icons = data.join("icons/hicolor/128x128/apps");
        std::fs::create_dir_all(&applications)?;
        std::fs::create_dir_all(&icons)?;
        std::fs::write(icons.join("typerelay.png"), icon)?;
        let mut integrated = false;
        let mut entries=std::fs::read_dir(&applications)?.collect::<std::io::Result<Vec<_>>>()?;entries.sort_by_key(|entry|entry.file_name());
        for entry in entries {
            let name = entry.file_name();let name = name.to_string_lossy();
            if !name.starts_with("appimagekit_") || !name.ends_with("-TypeRelay.desktop") || !entry.file_type()?.is_file() { continue; }
            let text = std::fs::read_to_string(entry.path())?;
            if !text.lines().any(|line| line.starts_with("X-AppImage-Identifier=")) { continue; }
            let current = !integrated && text.lines().any(|line| line.strip_prefix("TryExec=") == launcher.to_str());
            integrated |= current;
            let mut main = false;let mut normalized = String::new();
            for line in text.lines() {
                if line.starts_with('[') { main = line == "[Desktop Entry]"; }
                if main && line.starts_with("NoDisplay=") { continue; }
                normalized.push_str(if main && line.starts_with("Name=") { "Name=Typerelay" } else { line });normalized.push('\n');
                if line == "[Desktop Entry]" && !current { normalized.push_str("NoDisplay=true\n"); }
            }
            let temporary = entry.path().with_extension("desktop.new");std::fs::write(&temporary, normalized)?;std::fs::rename(temporary, entry.path())?;
        }
        for (name, tui) in [("typerelay-panel.desktop", false), ("typerelay-tui.desktop", true)] {
            let path = applications.join(name);
            if path.exists() {
                let text = std::fs::read_to_string(&path)?;
                ensure!(text.starts_with("# Managed by TypeRelay") || name == "typerelay-panel.desktop" && text.contains("/.local/bin/typerelay-panel"), "An unmanaged desktop launcher exists: {}", path.display());
            }
            let temporary = path.with_extension("desktop.new");
            let mut text = Self::desktop_entry(launcher, tui)?;
            if integrated && !tui { text.push_str("NoDisplay=true\n"); }
            std::fs::write(&temporary, text)?;
            std::fs::rename(temporary, path)?;
        }
        let reference = data.join("typerelay/appimage-path");
        std::fs::create_dir_all(reference.parent().context("AppImage directory is missing")?)?;
        let temporary = reference.with_extension("new");
        std::fs::write(&temporary, format!("{}\n", launcher.to_str().context("AppImage path is not valid UTF-8")?))?;
        std::fs::rename(temporary, reference)?;
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
    #[test]
    fn composite_devices_and_multiple_internal_keyboards_use_explicit_selection() {
        let devices=vec![
            ("Laptop keyboard".into(),"/dev/input/event1".into(),"ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into()),
            ("Composite USB device".into(),"/dev/input/event2".into(),"ID_INPUT_MOUSE=1\n".into()),
            ("Composite USB device".into(),"/dev/input/event3".into(),"ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into()),
            ("Composite USB device".into(),"/dev/input/event4".into(),"ID_INPUT_KEY=1\n".into()),
            ("Security token".into(),"/dev/input/event5".into(),"ID_INPUT_KEYBOARD=1\nID_INTEGRATION=external\n".into()),
        ];
        assert!(Installer::select_keyboard(&devices,None).is_err());
        assert_eq!(Installer::select_keyboard(&devices,Some("Composite USB device")).unwrap(),"Composite USB device");
        let selected:Vec<_>=Installer::keyboard_devices(&devices).into_iter().filter(|(name,_,_)|name=="Composite USB device").collect();
        assert_eq!(selected.len(),1);assert_eq!(selected[0].1,std::path::Path::new("/dev/input/event3"));
        assert_eq!(Installer::input_paths(&devices,"Composite USB device"),vec![("/dev/uinput".into(),true),("/dev/input/event2".into(),false),("/dev/input/event3".into(),false)]);
    }
    #[test]
    fn appimage_registration_uses_one_native_launcher_and_preserves_its_actions() {
        let data=tempfile::tempdir().unwrap();let applications=data.path().join("applications");std::fs::create_dir_all(&applications).unwrap();
        let current=applications.join("appimagekit_current-TypeRelay.desktop");let duplicate=applications.join("appimagekit_duplicate-TypeRelay.desktop");let old=applications.join("appimagekit_old-TypeRelay.desktop");
        std::fs::write(&current,"[Desktop Entry]\nName=TypeRelay (1)\nExec=/apps/current.AppImage\nTryExec=/apps/current.AppImage\nX-AppImage-Identifier=current\n\n[Desktop Action Remove]\nName=Delete this AppImage\nExec=remove current\n").unwrap();
        std::fs::write(&old,"[Desktop Entry]\nName=TypeRelay\nTryExec=/apps/old.AppImage\nX-AppImage-Identifier=old\n").unwrap();
        std::fs::write(&duplicate,"[Desktop Entry]\nName=TypeRelay (2)\nTryExec=/apps/current.AppImage\nX-AppImage-Identifier=duplicate\n").unwrap();
        let launcher=std::path::Path::new("/apps/current.AppImage");
        for _ in 0..2 {
            Installer::register_appimage_at(data.path(),launcher,&[]).unwrap();
            let text=std::fs::read_to_string(&current).unwrap();assert!(text.contains("Name=Typerelay\n"));assert!(!text.contains("NoDisplay=true"));assert!(text.contains("[Desktop Action Remove]\nName=Delete this AppImage\nExec=remove current"));
            assert!(std::fs::read_to_string(&old).unwrap().contains("NoDisplay=true"));
            assert!(std::fs::read_to_string(&duplicate).unwrap().contains("NoDisplay=true"));
            assert!(std::fs::read_to_string(applications.join("typerelay-panel.desktop")).unwrap().contains("NoDisplay=true"));
            assert!(!std::fs::read_to_string(applications.join("typerelay-tui.desktop")).unwrap().contains("NoDisplay=true"));
        }
        std::fs::remove_file(&current).unwrap();std::fs::remove_file(&duplicate).unwrap();Installer::register_appimage_at(data.path(),launcher,&[]).unwrap();
        assert!(!std::fs::read_to_string(applications.join("typerelay-panel.desktop")).unwrap().contains("NoDisplay=true"));
    }
    #[test]
    fn input_access_survives_device_renumbering_and_repeated_setup() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        Installer::persist_input_access(root.path(), 1234, "Built-in keyboard").unwrap();
        let rule = root.path().join("etc/udev/rules.d/99-typerelay-1234.rules");
        let first = std::fs::read_to_string(&rule).unwrap();
        assert!(first.contains("ATTRS{name}==\"Built-in keyboard\""));
        assert!(first.contains("u:1234:r $env{DEVNAME}"));
        assert!(first.contains("u:1234:rw $env{DEVNAME}"));
        assert!(!first.contains("/dev/input/event"));
        assert!(!first.contains("MODE="));
        assert_eq!(first.lines().filter(|line| line.contains("ID_INPUT_")).count(), 4);
        assert_eq!(std::fs::read_to_string(root.path().join("etc/modules-load.d/typerelay-1234.conf")).unwrap(), "# Managed by TypeRelay\nuinput\n");
        assert_eq!(std::fs::metadata(&rule).unwrap().permissions().mode() & 0o777, 0o644);
        Installer::persist_input_access(root.path(), 1234, "Built-in keyboard").unwrap();
        assert_eq!(std::fs::read_to_string(&rule).unwrap(), first);
        if Command::new("/usr/bin/udevadm").arg("--help").output().is_ok_and(|help| String::from_utf8_lossy(&help.stdout).contains("verify")) {
            let validation = Command::new("/usr/bin/udevadm").arg("verify").arg(&rule).output().unwrap();
            assert!(validation.status.success(), "{}", String::from_utf8_lossy(&validation.stderr));
        }
    }
    #[test]
    fn persistent_access_rejects_patterns_and_preserves_unmanaged_files() {
        let root = tempfile::tempdir().unwrap();
        for keyboard in ["", "*", "Keyboard\nother", "Keyboard\"", "Keyboard\\", "Keyboard?", "Keyboard[1]", "Keyboard|other", "$env{DEVNAME}", "Keyboard%"] { assert!(Installer::persist_input_access(root.path(), 1234, keyboard).is_err()); }
        assert!(Installer::persist_input_access(root.path(), 0, "Keyboard").is_err());
        assert!(!root.path().join("etc").exists());
        let module = root.path().join("etc/modules-load.d/typerelay-1234.conf");
        std::fs::create_dir_all(module.parent().unwrap()).unwrap();
        std::fs::write(&module, "Custom configuration\n").unwrap();
        assert!(Installer::persist_input_access(root.path(), 1234, "Keyboard").is_err());
        assert_eq!(std::fs::read_to_string(module).unwrap(), "Custom configuration\n");
        assert!(!root.path().join("etc/udev").exists());
    }
    #[test]
    fn appimage_command_setup_is_idempotent_and_preserves_custom_commands() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let text = include_str!("../../../scripts/appimage-cli.sh");
        assert!(!Installer::appimage_commands(root.path(), false).unwrap());
        assert!(Installer::appimage_commands(root.path(), true).unwrap());
        assert!(Installer::appimage_commands(root.path(), false).unwrap());
        assert!(Installer::appimage_commands(root.path(), true).unwrap());
        let tui = root.path().join("usr/local/bin/typerelay-tui");
        std::fs::set_permissions(&tui, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!Installer::appimage_commands(root.path(), false).unwrap());
        assert!(Installer::appimage_commands(root.path(), true).unwrap());
        let target = root.path().join("custom-tui");
        std::fs::write(&target, text).unwrap();
        std::fs::remove_file(&tui).unwrap();
        std::os::unix::fs::symlink(&target, &tui).unwrap();
        assert!(Installer::appimage_commands(root.path(), true).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), text);
        std::fs::remove_file(&tui).unwrap();
        std::fs::write(&tui, "Custom TUI command\n").unwrap();
        assert!(Installer::appimage_commands(root.path(), true).is_err());
        assert_eq!(std::fs::read_to_string(tui).unwrap(), "Custom TUI command\n");
    }
}
