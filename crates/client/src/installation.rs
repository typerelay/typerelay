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
            let device_name = match std::fs::read_to_string(entry.path().join("device/name")) { Ok(name) => name.trim().to_owned(), Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue, Err(error) => return Err(error.into()) };
            let properties = Command::new("/usr/bin/udevadm").args(["info", "--query=property", "--name"]).arg(&path).output()?;
            if !properties.status.success() && !path.exists() { continue; }
            ensure!(properties.status.success(), "Could not inspect input device {}", path.display());
            devices.push((device_name, path, String::from_utf8(properties.stdout)?));
        }
        Ok(devices)
    }

    pub fn keyboard_devices(devices: &[(String, std::path::PathBuf, String)]) -> Vec<&(String, std::path::PathBuf, String)> {
        devices.iter().filter(|(name, _, properties)| !name.eq_ignore_ascii_case("TypeRelay virtual keyboard") && properties.lines().any(|p| p == "ID_INPUT_KEYBOARD=1")).collect()
    }

    pub fn physical_keyboard(properties: &str) -> bool {
        properties.lines().any(|p| p == "ID_INPUT_KEYBOARD=1") && properties.lines().any(|p| p.starts_with("DEVPATH=/devices/") && !p.starts_with("DEVPATH=/devices/virtual/input/"))
    }

    pub fn input_keyboards<'a>(devices: &'a [(String, std::path::PathBuf, String)], requested: &str) -> Vec<&'a (String, std::path::PathBuf, String)> {
        Self::keyboard_devices(devices).into_iter().filter(|(name, _, properties)| if requested == "auto" { Self::physical_keyboard(properties) } else { name == requested }).collect()
    }

    pub fn keyboard_mode() -> Result<String> {
        let settings = crate::panel::Panel::settings(&crate::editor::Paths::config_dir()?)?;
        Ok(if settings.keyboard.is_empty() { "auto".into() } else { settings.keyboard })
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
        if candidates.is_empty() { return Err(std::io::Error::new(std::io::ErrorKind::NotConnected, format!("Selected keyboard is disconnected. Available keyboards: {available}")).into()); }
        ensure!(candidates.len() == 1, "Choose your keyboard in Settings → Advanced (terminal: --device-name). Available keyboards: {available}");
        Ok(candidates[0].0.clone())
    }

    pub fn configured_keyboard(devices: &[(String, std::path::PathBuf, String)], settings: &crate::panel::PanelSettings) -> Result<String> {
        let requested=(!settings.keyboard.is_empty()).then_some(settings.keyboard.as_str());
        Self::select_keyboard(devices,requested).or_else(|error| {
            if requested.is_none() && !settings.keyboard_fallback.is_empty() { Self::select_keyboard(devices,Some(&settings.keyboard_fallback)).or(Err(error)) } else { Err(error) }
        })
    }

    pub fn keyboard() -> Result<String> {
        let settings = crate::panel::Panel::settings(&crate::editor::Paths::config_dir()?)?;
        if !settings.keyboard.is_empty() || !settings.keyboard_fallback.is_empty() { return Self::configured_keyboard(&Self::devices()?, &settings); }
        // Preserve the keyboard selected by an earlier managed installation.
        let data = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or(std::path::PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".local/share"));
        let state = data.join("typerelay/installation.json");
        let state: serde_json::Value = if state.exists() { serde_json::from_slice(&std::fs::read(state)?)? } else { serde_json::Value::Null };
        Self::select_keyboard(&Self::devices()?, state["device_name"].as_str())
    }

    pub fn input_paths(devices: &[(String, std::path::PathBuf, String)], keyboard: &str) -> Vec<(std::path::PathBuf, bool)> {
        let mut paths = vec![(std::path::PathBuf::from("/dev/uinput"), true)];
        paths.extend(devices.iter().filter(|(name, _, properties)| properties.lines().any(|p| p == "ID_INPUT_KEYBOARD=1" && (name == keyboard || keyboard == "auto" && Self::physical_keyboard(properties)) || matches!(p, "ID_INPUT_MOUSE=1" | "ID_INPUT_TOUCHPAD=1" | "ID_INPUT_TOUCHSCREEN=1"))).map(|(_, path, _)| (path.clone(), false)));
        paths
    }

    pub fn has_access(keyboard: &str) -> Result<bool> {
        use std::os::unix::ffi::OsStrExt;
        Ok(Self::input_paths(&Self::devices()?, keyboard).iter().all(|(path, write)| std::ffi::CString::new(path.as_os_str().as_bytes()).is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::R_OK | if *write { libc::W_OK } else { 0 }) == 0 })))
    }

    pub fn persistent_access(keyboard: &str) -> bool {
        let uid = unsafe { libc::geteuid() };
        std::fs::read_to_string(format!("/etc/udev/rules.d/99-typerelay-{uid}.rules")).is_ok_and(|rules| rules == Self::input_rules(uid, keyboard))
    }

    pub fn install_capture_helper(desktop:&str)->Result<String>{
        use std::{fs,path::PathBuf};
        let home=PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?);let data=std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(||home.join(".local/share"));
        match desktop {
            "gnome"=>{let path=data.join("gnome-shell/extensions/capture@typerelay.com");fs::create_dir_all(&path)?;fs::write(path.join("metadata.json"),include_str!("../../../apps/desktop/helpers/gnome/metadata.json"))?;fs::write(path.join("extension.js"),include_str!("../../../apps/desktop/helpers/gnome/extension.js"))?;let enabled=Command::new("gnome-extensions").args(["enable","capture@typerelay.com"]).status().is_ok_and(|status|status.success());Ok(if enabled{"Desktop helper enabled"}else{"Helper installed. Log out and back in, then enable Typerelay input context in GNOME Extensions."}.into())},
            "kde"=>{let path=data.join("kwin/scripts/typerelay-capture");fs::create_dir_all(path.join("contents/code"))?;fs::write(path.join("metadata.json"),include_str!("../../../apps/desktop/helpers/kwin/metadata.json"))?;fs::write(path.join("contents/code/main.js"),include_str!("../../../apps/desktop/helpers/kwin/main.js"))?;ensure!(Command::new("kwriteconfig6").args(["--file","kwinrc","--group","Plugins","--key","typerelay-captureEnabled","true"]).status()?.success(),"Could not enable KWin helper");let bus=zbus::blocking::Connection::session()?;let _=bus.call_method(Some("org.kde.KWin"),"/KWin",Some("org.kde.KWin"),"reconfigure",&());Ok("Desktop helper installed. Enable Typerelay input context under Window Management → KWin Scripts if not already active.".into())},
            _=>anyhow::bail!("This desktop does not require the GNOME/KWin helper"),
        }
    }
    pub fn grant_input_access(requested: &str) -> Result<()> {
        ensure!(unsafe { libc::geteuid() } == 0, "Input access requires native administrator authentication");
        let uid: u32 = std::env::var("PKEXEC_UID").context("Run input access through pkexec")?.parse()?;
        ensure!(uid > 0, "Input access is only for a desktop user");
        // Select from trusted kernel/udev device information; no caller-provided paths or UID.
        let devices = Self::devices()?;
        let keyboard = if requested == "auto" { "auto".to_owned() } else { Self::select_keyboard(&devices, Some(requested))? };
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
        let rules = Self::input_rules(uid, keyboard);
        Self::write_managed(&[
            (root.join(format!("etc/udev/rules.d/99-typerelay-{uid}.rules")), rules, 0o644),
            (root.join(format!("etc/modules-load.d/typerelay-{uid}.conf")), "# Managed by TypeRelay\nuinput\n".into(), 0o644),
        ])
    }

    fn input_rules(uid: u32, keyboard: &str) -> String {
        let access = format!("RUN+=\"/usr/bin/setfacl -m u:{uid}:r $env{{DEVNAME}}\"");
        let selector = if keyboard == "auto" { "DEVPATH!=\"/devices/virtual/input/*\", ".to_owned() } else { format!("ATTRS{{name}}==\"{keyboard}\", ") };
        let mut rules = format!("# Managed by TypeRelay\nACTION!=\"remove\", SUBSYSTEM==\"input\", KERNEL==\"event*\", ENV{{ID_INPUT_KEYBOARD}}==\"1\", {selector}{access}\n");
        for kind in ["MOUSE", "TOUCHPAD", "TOUCHSCREEN"] { rules.push_str(&format!("ACTION!=\"remove\", SUBSYSTEM==\"input\", KERNEL==\"event*\", ENV{{ID_INPUT_{kind}}}==\"1\", {access}\n")); }
        rules.push_str(&format!("ACTION!=\"remove\", SUBSYSTEM==\"misc\", KERNEL==\"uinput\", RUN+=\"/usr/bin/setfacl -m u:{uid}:rw $env{{DEVNAME}}\"\n"));
        rules
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
        Ok(files.iter().all(|(path, _, _)| std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() == text.len() as u64 && metadata.permissions().mode() & 0o111 != 0) && std::fs::read_to_string(path).is_ok_and(|content| content == text)))
    }

    pub fn migrate_terminal_commands(package: bool, version: &str) -> Result<()> {
        use std::path::{Path, PathBuf};
        let home = PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?);
        let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
        let bin = home.join(".local/bin");
        if !package && ["typerelay", "typerelay-tui"].iter().any(|name| !std::fs::symlink_metadata(bin.join(name)).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)) {
            ensure!(Self::appimage_commands(Path::new("/"), false)?, "Finish AppImage terminal command setup before replacing older commands in {}.", bin.display());
        }
        let command_dir = Path::new(if package { "/usr/bin" } else { "/usr/local/bin" });
        Self::retire_legacy_commands(&bin, &data.join("typerelay/installation.json"), &Self::legacy_service_path()?, command_dir, version)
    }

    fn retire_legacy_commands(bin: &std::path::Path, manifest: &std::path::Path, service: &std::path::Path, command_dir: &std::path::Path, version: &str) -> Result<()> {
        use sha2::{Digest, Sha256};
        use std::{fs, io::{self, ErrorKind, Read, Seek}, os::unix::{fs::{MetadataExt, OpenOptionsExt}, process::ExitStatusExt}, process::Stdio};
        let mut candidates = Vec::new();
        for name in ["typerelay", "typerelay-tui"] {
            let path = bin.join(name);
            match fs::symlink_metadata(&path) {
                Ok(_) => candidates.push((name, path)),
                Err(error) if error.kind() == ErrorKind::NotFound => (),
                Err(error) => return Err(error).with_context(|| format!("Could not inspect {}", path.display())),
            }
        }
        if candidates.is_empty() { return Ok(()); }
        for name in ["typerelay", "typerelay-tui"] {
            let command = command_dir.join(name);
            // AppImage helpers can keep an inherited pipe open after the timeout process exits.
            let mut output = tempfile::tempfile()?;
            let result = Command::new("/usr/bin/timeout").args(["--kill-after=1s", "5s"]).arg(&command).arg("--version").stdin(Stdio::null()).stdout(output.try_clone()?).stderr(Stdio::null()).status();
            let reason = if result.as_ref().is_ok_and(|status| matches!(status.code(), Some(124 | 137)) || status.signal() == Some(libc::SIGKILL)) { "Timed out verifying" } else { "Could not verify" };
            let mut actual = String::new();
            output.rewind()?;
            let ready = result.is_ok_and(|status| status.success()) && output.take(256).read_to_string(&mut actual).is_ok() && actual.trim() == format!("{name} {version}");
            ensure!(ready, "{reason} {} at version {version}. Older terminal commands may still be in use: {}", command.display(), candidates.iter().map(|(_, path)| path.display().to_string()).collect::<Vec<_>>().join(", "));
        }
        let state: serde_json::Value = fs::read(manifest).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let mut backup = None;
        let mut conflicts = Vec::new();
        for (name, path) in candidates {
            let expected = state["binaries"][name].as_str().or_else(|| if name == "typerelay" { state["binary_sha256"].as_str() } else { None });
            let matched = expected.and_then(|hash| {
                let mut file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&path).ok()?;
                let metadata = file.metadata().ok()?;
                let mut digest = Sha256::new();
                (metadata.is_file() && io::copy(&mut file, &mut digest).is_ok() && format!("{:x}", digest.finalize()) == hash).then_some(metadata)
            });
            let Some(matched) = matched else {
                if !fs::symlink_metadata(&path).is_err_and(|error| error.kind() == ErrorKind::NotFound) { conflicts.push(path.display().to_string()); }
                continue;
            };
            ensure!(fs::symlink_metadata(service).is_err_and(|error| error.kind() == ErrorKind::NotFound), "The old TypeRelay service at {} still needs its terminal commands in {}. Finish Linux setup to switch them to the current package.", service.display(), bin.display());
            let directory = match &mut backup {
                Some(directory) => directory,
                None => backup.insert(tempfile::Builder::new().prefix(".typerelay-legacy-").tempdir_in(bin)?),
            };
            if !fs::symlink_metadata(&path).is_ok_and(|current| current.is_file() && current.dev() == matched.dev() && current.ino() == matched.ino() && current.ctime() == matched.ctime() && current.ctime_nsec() == matched.ctime_nsec()) {
                conflicts.push(path.display().to_string());
                continue;
            }
            fs::rename(&path, directory.path().join(name)).with_context(|| format!("Could not back up {}", path.display()))?;
            directory.disable_cleanup(true);
        }
        ensure!(conflicts.is_empty(), "These files can override the current TypeRelay terminal commands. Review and move them aside if they belong to an older installation: {}", conflicts.join(", "));
        Ok(())
    }

    fn legacy_service_path() -> Result<std::path::PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or(std::path::PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".config"));
        Ok(config.join("systemd/user/typerelay.service"))
    }

    pub fn prepare_package_service(package: bool) -> Result<()> {
        let unit = Self::legacy_service_path()?;
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
    fn terminal_migration_backs_up_managed_commands_only_after_verifying_replacements() {
        use sha2::{Digest, Sha256};
        use std::{fs, os::unix::fs::PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("local");
        let package = root.path().join("package");
        let manifest = root.path().join("installation.json");
        let service = root.path().join("typerelay.service");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(&package).unwrap();
        Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap();

        let commands = ["typerelay", "typerelay-tui"];
        let legacy = b"old managed binary";
        let checksum = format!("{:x}", Sha256::digest(legacy));
        for name in commands { fs::write(bin.join(name), legacy).unwrap(); }
        fs::write(&manifest, serde_json::json!({"binaries": {"typerelay": checksum, "typerelay-tui": checksum}}).to_string()).unwrap();
        for name in commands {
            let command = package.join(name);
            let version = if name == "typerelay" { "1.4.3" } else { "1.3.3" };
            fs::write(&command, format!("#!/bin/sh\nprintf '%s\\n' '{name} {version}'\n")).unwrap();
            fs::set_permissions(&command, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let error = Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap_err();
        assert!(error.to_string().contains("typerelay-tui"));
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 2);
        for name in commands { assert_eq!(fs::read(bin.join(name)).unwrap(), legacy); }

        fs::write(package.join("typerelay-tui"), "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n").unwrap();
        let started = std::time::Instant::now();
        let error = Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap_err();
        assert!(error.to_string().contains("Timed out verifying"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(15));
        for name in commands { assert_eq!(fs::read(bin.join(name)).unwrap(), legacy); }

        fs::write(package.join("typerelay-tui"), "#!/bin/sh\nprintf '%s\\n' 'typerelay-tui 1.4.3'\n").unwrap();
        fs::write(&service, "legacy service").unwrap();
        let error = Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap_err();
        assert!(error.to_string().contains("typerelay.service"));
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 2);
        fs::remove_file(&service).unwrap();

        Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap();
        Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap();
        let entries: Vec<_> = fs::read_dir(&bin).unwrap().map(|entry| entry.unwrap().path()).collect();
        assert_eq!(entries.len(), 1);
        for name in commands { assert_eq!(fs::read(entries[0].join(name)).unwrap(), legacy); }

        let path = std::env::join_paths([&bin, &package]).unwrap();
        let shell = Command::new("/bin/sh").args(["-c", "typerelay --version && typerelay-tui --version"]).env("PATH", path).output().unwrap();
        assert!(shell.status.success());
        assert_eq!(shell.stdout, b"typerelay 1.4.3\ntyperelay-tui 1.4.3\n");

        fs::write(bin.join("typerelay"), b"unmanaged").unwrap();
        let tui = bin.join("typerelay-tui");
        fs::write(&tui, legacy).unwrap();
        fs::write(package.join("typerelay-tui"), format!("#!/bin/sh\nln -sfn '{}' '{}'\nprintf '%s\\n' 'typerelay-tui 1.4.3'\n", entries[0].join("typerelay-tui").display(), tui.display())).unwrap();
        let error = Installer::retire_legacy_commands(&bin, &manifest, &service, &package, "1.4.3").unwrap_err().to_string();
        for name in commands { assert!(error.contains(&*bin.join(name).to_string_lossy())); }
        assert_eq!(fs::read(bin.join("typerelay")).unwrap(), b"unmanaged");
        assert!(fs::symlink_metadata(bin.join("typerelay-tui")).unwrap().is_symlink());
    }

    #[test]
    fn automatic_inputs_include_both_physical_keyboards_and_exclude_virtual_and_pointer_interfaces() {
        let devices=vec![("Laptop".into(),"/dev/input/event3".into(),"ID_INPUT_KEYBOARD=1\nDEVPATH=/devices/platform/i8042/input3/event3".into()),("USB".into(),"/dev/input/event8".into(),"ID_INPUT_KEYBOARD=1\nDEVPATH=/devices/pci/usb/input8/event8".into()),("USB".into(),"/dev/input/event7".into(),"ID_INPUT_MOUSE=1\nDEVPATH=/devices/pci/usb/input7/event7".into()),("Other virtual keyboard".into(),"/dev/input/event9".into(),"ID_INPUT_KEYBOARD=1\nDEVPATH=/devices/virtual/input/input9/event9".into())];
        let names:Vec<_>=Installer::input_keyboards(&devices,"auto").iter().map(|row|row.0.as_str()).collect();assert_eq!(names,vec!["Laptop","USB"]);
        assert_eq!(Installer::input_keyboards(&devices,"Laptop").len(),1);
        let paths=Installer::input_paths(&devices,"auto");assert!(paths.iter().any(|(path,_)|path==std::path::Path::new("/dev/input/event3")));assert!(paths.iter().any(|(path,_)|path==std::path::Path::new("/dev/input/event8")));assert!(!paths.iter().any(|(path,_)|path==std::path::Path::new("/dev/input/event9")));
    }
    #[test]
    fn automatic_permissions_are_persistent_and_not_bound_to_a_name_or_event_number() {
        let root=tempfile::tempdir().unwrap();Installer::persist_input_access(root.path(),1234,"auto").unwrap();let path=root.path().join("etc/udev/rules.d/99-typerelay-1234.rules");let first=std::fs::read_to_string(&path).unwrap();assert!(first.contains("ENV{ID_INPUT_KEYBOARD}==\"1\""));assert!(first.contains("DEVPATH!=\"/devices/virtual/input/*\""));assert!(!first.contains("ATTRS{name}"));Installer::persist_input_access(root.path(),1234,"auto").unwrap();assert_eq!(first,std::fs::read_to_string(path).unwrap());
    }
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
    fn automatic_keyboard_fallback_saves_and_survives_restart() {
        let devices=vec![("Laptop keyboard".into(),"/dev/input/event1".into(),"ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into()),("USB keyboard".into(),"/dev/input/event2".into(),"ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into()),("TypeRelay virtual keyboard".into(),"/dev/input/event3".into(),"ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into())];
        assert!(Installer::select_keyboard(&devices,None).is_err());
        let root=tempfile::tempdir().unwrap();let mut settings=crate::panel::PanelSettings{keyboard_fallback:"USB keyboard".into(),..Default::default()};
        settings.keyboard_fallback=Installer::configured_keyboard(&devices,&settings).unwrap();crate::panel::Panel::save_settings(root.path(),&settings).unwrap();
        let saved=crate::panel::Panel::settings(root.path()).unwrap();assert!(saved.keyboard.is_empty());assert_eq!(saved.keyboard_fallback,"USB keyboard");assert_eq!(Installer::configured_keyboard(&devices,&saved).unwrap(),"USB keyboard");
        assert_eq!(Installer::configured_keyboard(&devices[..1],&saved).unwrap(),"Laptop keyboard");
        assert!(Installer::configured_keyboard(&devices[2..],&saved).is_err());
        assert!(Installer::select_keyboard(&devices,Some("TypeRelay virtual keyboard")).is_err());
        settings.keyboard="Missing keyboard".into();assert!(Installer::configured_keyboard(&devices,&settings).is_err());
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
        assert!(!Installer::appimage_commands(root.path(), false).unwrap());
        assert!(Installer::appimage_commands(root.path(), true).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), text);
        std::fs::remove_file(&tui).unwrap();
        std::fs::write(&tui, "Custom TUI command\n").unwrap();
        assert!(Installer::appimage_commands(root.path(), true).is_err());
        assert_eq!(std::fs::read_to_string(tui).unwrap(), "Custom TUI command\n");
    }
}
