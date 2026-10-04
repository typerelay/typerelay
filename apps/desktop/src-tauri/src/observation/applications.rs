use super::Observation;
use anyhow::{Context,Result,ensure};
use std::path::Path;
#[cfg(not(target_os="macos"))]
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
pub(super) struct Application { pub id:String, pub name:String }

impl Observation {
    pub fn pick_applications(app:&tauri::AppHandle)->Result<serde_json::Value> {
        let picker=app.dialog().file().set_title("Choose apps to exclude");
        #[cfg(target_os="macos")]
        let picker=picker.set_directory("/Applications").add_filter("Applications",&["app"]);
        #[cfg(target_os="windows")]
        let picker=picker.add_filter("Applications and shortcuts",&["exe","lnk"]);
        #[cfg(target_os="linux")]
        let picker=picker.set_directory("/usr/share/applications");
        let mut applications=Vec::<Application>::new();
        for file in picker.blocking_pick_files().unwrap_or_default() {
            let path=file.into_path().context("Choose a local application")?;
            let application=Self::resolve_application(&path).map_err(|error|anyhow::anyhow!("Could not identify {}: {error:#}. Choose the installed application executable instead of a launcher or installer.",path.display()))?;
            if !applications.iter().any(|value|value.id.eq_ignore_ascii_case(&application.id)){applications.push(application);}
        }
        Ok(serde_json::json!(applications))
    }

    pub(super) fn resolve_application(path:&Path)->Result<Application> {
        let path=path.canonicalize().context("Application is missing or inaccessible")?;
        #[cfg(target_os="macos")]
        {
            use objc2_foundation::{NSBundle,NSString};
            ensure!(path.is_dir()&&path.extension().is_some_and(|ext|ext.eq_ignore_ascii_case("app")),"Choose an .app bundle");
            let bundle=NSBundle::bundleWithPath(&NSString::from_str(path.to_str().context("Invalid application path")?)).context("Invalid application bundle")?;
            let id=bundle.bundleIdentifier().context("Application has no bundle identifier")?.to_string();
            let name=path.file_stem().context("Application has no name")?.to_string_lossy().into_owned();
            ensure!(!id.is_empty()&&id.len()<=512&&name.len()<=512,"Invalid application identity");
            Ok(Application{id,name})
        }
        #[cfg(target_os="windows")]
        {
            use std::io::Read;
            let target=if path.extension().is_some_and(|ext|ext.eq_ignore_ascii_case("lnk")){Self::shortcut_target(&path)?}else{path.clone()};
            ensure!(target.is_file()&&target.extension().is_some_and(|ext|ext.eq_ignore_ascii_case("exe")),"Choose an executable application or its shortcut");
            let mut header=[0u8;2];std::fs::File::open(&target)?.read_exact(&mut header)?;ensure!(&header==b"MZ","Not a Windows application executable");
            let id=target.file_name().context("Application has no executable name")?.to_str().context("Invalid executable name")?.to_owned();
            ensure!(!["update.exe","rundll32.exe","explorer.exe","cmd.exe","powershell.exe","pwsh.exe","msiexec.exe"].contains(&id.to_ascii_lowercase().as_str()),"This launcher does not identify a single application");
            let name=path.file_stem().context("Application has no name")?.to_string_lossy().into_owned();
            ensure!(id.len()<=512&&name.len()<=512,"Application name is too long");
            Ok(Application{id,name})
        }
        #[cfg(target_os="linux")]
        {
            use std::{io::Read,os::unix::fs::PermissionsExt};
            let (target,name)=if path.extension().is_some_and(|ext|ext=="desktop") {
                ensure!(path.metadata()?.len()<=65536,"Application launcher is too large");
                let text=std::fs::read_to_string(&path)?;let mut entry=false;let mut fields=std::collections::BTreeMap::new();
                for line in text.lines().map(str::trim) {if line.starts_with('['){entry=line=="[Desktop Entry]";}else if entry&&!line.starts_with('#')&&let Some((key,value))=line.split_once('='){ensure!(fields.insert(key.trim(),value.trim()).is_none(),"Ambiguous application launcher");}}
                ensure!(fields.get("Type")==Some(&"Application")&&fields.get("Terminal")!=Some(&"true"),"Choose a desktop application");
                let executable=Self::desktop_executable(fields.get("Exec").context("Launcher has no executable")?)?;
                let target=if Path::new(&executable).is_absolute(){PathBuf::from(executable)}else{ensure!(!executable.contains('/'),"Relative executable paths cannot be identified");std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|directory|directory.join(&executable)).find(|candidate|candidate.is_file()&&candidate.metadata().is_ok_and(|metadata|metadata.permissions().mode()&0o111!=0)).context("Launcher executable is not installed")?};
                (target,fields.get("Name").context("Launcher has no application name")?.to_string())
            }else{(path.clone(),path.file_name().context("Application has no name")?.to_string_lossy().into_owned())};
            let target=target.canonicalize()?;
            ensure!(target.is_file()&&target.metadata()?.permissions().mode()&0o111!=0,"Choose an executable application");
            let mut header=[0u8;12];std::fs::File::open(&target)?.read_exact(&mut header).context("Not an application executable")?;
            ensure!(&header[..4]==b"\x7fELF"&&&header[8..10]!=b"AI","Scripts and AppImages do not expose a reliable application identity; choose the installed app binary");
            let id=target.file_name().context("Application has no executable name")?.to_str().context("Invalid executable name")?.to_owned();
            ensure!(!["env","flatpak","snap","sh","bash","fish","electron","python","python3","java","mono","wine","wine64"].contains(&id.as_str())&&!id.starts_with("electron-"),"This launcher runs multiple apps; choose the actual app binary");
            ensure!(!name.is_empty()&&name.len()<=512&&id.len()<=512,"Invalid application name");
            Ok(Application{id,name})
        }
    }

    #[cfg(target_os="linux")]
    fn desktop_executable(command:&str)->Result<String> {
        // Read only the executable token. Never evaluate a shell or execute a launcher.
        let mut value=String::new();let mut quoted=false;let mut escaped=false;
        for c in command.trim().chars() {
            if escaped {ensure!(['\\','"','`','$',' '].contains(&c),"Unsupported launcher escape");value.push(c);escaped=false;}
            else if c=='\\'{escaped=true;}
            else if c=='"'{quoted=!quoted;}
            else if c.is_whitespace()&&!quoted{break;}
            else{ensure!(c!='%'&&c!='\''&&!c.is_control(),"Unsupported launcher executable");value.push(c);}
        }
        ensure!(!quoted&&!escaped&&!value.is_empty(),"Invalid launcher executable");Ok(value)
    }

    #[cfg(target_os="windows")]
    fn shortcut_target(path:&Path)->Result<PathBuf> {
        use windows::{core::{Interface,PCWSTR},Win32::{System::Com::{CoInitializeEx,CoUninitialize,CoCreateInstance,COINIT_APARTMENTTHREADED,CLSCTX_INPROC_SERVER,IPersistFile,STGM_READ},UI::Shell::{IShellLinkW,ShellLink}}};
        use std::os::windows::ffi::OsStrExt;
        unsafe {
            CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok()?;
            let result=(||->Result<PathBuf>{
                let link:IShellLinkW=CoCreateInstance(&ShellLink,None,CLSCTX_INPROC_SERVER)?;let file:IPersistFile=link.cast()?;let wide=path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();file.Load(PCWSTR(wide.as_ptr()),STGM_READ)?;
                let mut buffer=[0u16;32768];link.GetPath(&mut buffer,std::ptr::null_mut(),0)?;
                let length=buffer.iter().position(|c|*c==0).context("Shortcut target is too long")?;ensure!(length>0,"Shortcut does not point to a local executable");
                let target=PathBuf::from(String::from_utf16(&buffer[..length])?);ensure!(target.is_absolute(),"Shortcut target is not absolute");Ok(target.canonicalize()?)
            })();
            CoUninitialize();result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os="linux")]
    #[test]
    fn linux_picker_resolves_real_executable_identity_without_executing_launchers() {
        use std::os::unix::fs::{symlink,PermissionsExt};
        let root=tempfile::tempdir().unwrap();let executable=root.path().join("Actual App");std::fs::copy(std::env::current_exe().unwrap(),&executable).unwrap();let alias=root.path().join("different-name");symlink(&executable,&alias).unwrap();
        assert_eq!(Observation::resolve_application(&alias).unwrap().id,"Actual App");
        let launcher=root.path().join("editor.desktop");std::fs::write(&launcher,format!("[Desktop Entry]\nType=Application\nName=Friendly Editor\nExec=\"{}\" --new-window %U\n[Desktop Action other]\nExec=ignored\n",alias.display())).unwrap();
        let app=Observation::resolve_application(&launcher).unwrap();assert_eq!(app.id,"Actual App");assert_eq!(app.name,"Friendly Editor");
        for command in ["env EDITOR=1 editor", "flatpak run org.editor.App", "sh -c touch /tmp/not-executed", "\"unterminated", "missing-editor-app"] {std::fs::write(&launcher,format!("[Desktop Entry]\nType=Application\nName=Editor\nExec={command}\n")).unwrap();assert!(Observation::resolve_application(&launcher).is_err(),"{command}");}
        std::fs::write(&launcher,"[Desktop Entry]\nType=Application\nName=Editor\nExec=/bin/sh\nExec=/bin/ls\n").unwrap();assert!(Observation::resolve_application(&launcher).is_err());
        let script=root.path().join("script");std::fs::write(&script,"#!/bin/sh\nexit 1\n").unwrap();std::fs::set_permissions(&script,std::fs::Permissions::from_mode(0o755)).unwrap();assert!(Observation::resolve_application(&script).is_err());
        std::fs::set_permissions(&executable,std::fs::Permissions::from_mode(0o644)).unwrap();assert!(Observation::resolve_application(&executable).is_err());assert!(Observation::resolve_application(root.path()).is_err());assert!(Observation::resolve_application(&root.path().join("missing")).is_err());
    }
    #[cfg(target_os="linux")]
    #[test]
    fn desktop_executable_token_honors_quotes_and_rejects_ambiguous_values() {
        assert_eq!(Observation::desktop_executable("\"/opt/My App/editor\" --new %U").unwrap(),"/opt/My App/editor");
        assert_eq!(Observation::desktop_executable("editor %F").unwrap(),"editor");
        for command in ["", "\"unterminated", "editor\\", "%f", "'shell quotes'", "editor\\q"]{assert!(Observation::desktop_executable(command).is_err());}
    }
    #[cfg(target_os="windows")]
    #[test]
    fn windows_picker_resolves_executables_and_shortcut_targets() {
        use windows::{core::{Interface,PCWSTR},Win32::{System::Com::{CoInitializeEx,CoUninitialize,CoCreateInstance,COINIT_APARTMENTTHREADED,CLSCTX_INPROC_SERVER,IPersistFile},UI::Shell::{IShellLinkW,ShellLink}}};
        use std::os::windows::ffi::OsStrExt;
        let root=tempfile::tempdir().unwrap();let executable=root.path().join("ActualApp.exe");std::fs::copy(std::env::current_exe().unwrap(),&executable).unwrap();let shortcut=root.path().join("Friendly Editor.lnk");
        unsafe {CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().unwrap();let link:IShellLinkW=CoCreateInstance(&ShellLink,None,CLSCTX_INPROC_SERVER).unwrap();let target=executable.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();link.SetPath(PCWSTR(target.as_ptr())).unwrap();let file:IPersistFile=link.cast().unwrap();let path=shortcut.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();file.Save(PCWSTR(path.as_ptr()),true).unwrap();drop(file);drop(link);CoUninitialize();}
        let app=Observation::resolve_application(&shortcut).unwrap();assert_eq!(app.id,"ActualApp.exe");assert_eq!(app.name,"Friendly Editor");assert_eq!(Observation::resolve_application(&executable).unwrap().id,"ActualApp.exe");
        std::fs::write(root.path().join("broken.exe"),"not a program").unwrap();assert!(Observation::resolve_application(&root.path().join("broken.exe")).is_err());
    }
    #[cfg(target_os="macos")]
    #[test]
    fn macos_picker_reads_bundle_identity_and_rejects_missing_metadata() {
        let root=tempfile::tempdir().unwrap();let app=root.path().join("Friendly Editor.app");std::fs::create_dir_all(app.join("Contents")).unwrap();std::fs::write(app.join("Contents/Info.plist"),r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.actual-editor</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#).unwrap();
        let result=Observation::resolve_application(&app).unwrap();assert_eq!(result.id,"org.example.actual-editor");assert_eq!(result.name,"Friendly Editor");
        let invalid=root.path().join("Missing.app");std::fs::create_dir(&invalid).unwrap();assert!(Observation::resolve_application(&invalid).is_err());assert!(Observation::resolve_application(root.path()).is_err());
    }
}
