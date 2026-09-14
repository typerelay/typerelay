use anyhow::Result;
#[cfg(target_os="linux")]
use anyhow::Context;
use serde_json::{json, Value};
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
#[cfg(target_os="linux")]
use std::{collections::BTreeSet, fs, io::Cursor, path::PathBuf, process::Command};
#[cfg(target_os="linux")]
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct UpdateState { checking: AtomicBool, installing: AtomicBool, available: Mutex<Option<String>> }

impl Default for UpdateState {
    fn default() -> Self { Self { checking: AtomicBool::new(false), installing: AtomicBool::new(false), available: Mutex::new(None) } }
}

impl UpdateState {
    pub fn value(&self) -> Value { json!({"checking":self.checking.load(Ordering::SeqCst),"installing":self.installing.load(Ordering::SeqCst),"version":*self.available.lock().unwrap()}) }
}

fn emit(app: &AppHandle) { let _ = app.emit("update-status", app.state::<UpdateState>().value()); }

fn message(app: &AppHandle, title: &str, body: impl Into<String>, buttons: MessageDialogButtons) -> bool {
    app.dialog().message(body).title(title).buttons(buttons).blocking_show()
}

fn notify_available(_app: &AppHandle, version: &str) {
    #[cfg(target_os="linux")]
    if let Err(error)=notify_rust::Notification::new().appname("TypeRelay").summary("TypeRelay update available").body(&format!("TypeRelay {version} is available. Use the tray menu to install it.")).show(){eprintln!("TypeRelay update notification unavailable: {error}");}
    #[cfg(not(target_os="linux"))]
	if let Err(error)=tauri_plugin_notification::NotificationExt::notification(_app).builder().title("TypeRelay update available").body(format!("TypeRelay {version} is available. Use the tray menu to install it.")).show(){eprintln!("TypeRelay update notification unavailable: {error}");}
}

#[cfg(target_os="linux")]
fn unpack_linux(bytes: &[u8], version: &str) -> Result<PathBuf> {
    let root=std::env::temp_dir().join(format!("typerelay-update-{}-{}",std::process::id(),uuid::Uuid::new_v4()));fs::create_dir(&root)?;
    let result=(||->Result<()>{let allowed=BTreeSet::from(["typerelay".to_string(),"typerelay-tui".to_string(),"typerelay-panel".to_string()]);let mut found=BTreeSet::new();let mut archive=tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));for item in archive.entries()?{let mut item=item?;let path=item.path()?.into_owned();let name=path.file_name().and_then(|value|value.to_str()).context("Update contains an invalid path")?;if path.components().count()!=1||!allowed.contains(name)||!item.header().entry_type().is_file(){anyhow::bail!("Update contains an unsafe or unexpected file");}let destination=root.join(name);item.unpack(&destination)?;found.insert(name.to_string());}anyhow::ensure!(found==allowed,"Update must contain matching engine, TUI and panel binaries");for name in allowed{let file=root.join(&name);let output=Command::new(&file).arg("--version").output()?;anyhow::ensure!(output.status.success()&&String::from_utf8_lossy(&output.stdout).trim()==format!("{name} {version}"),"{name} version does not match {version}");}Ok(())})();
    if let Err(error)=result {let _=fs::remove_dir_all(&root);return Err(error);}
    Ok(root)
}

async fn install(app: AppHandle, update: Update) -> Result<()> {
    let state=app.state::<UpdateState>();if state.installing.swap(true,Ordering::SeqCst){return Ok(());}emit(&app);
    let result=async {
        let bytes=update.download(|_,_|{},||{}).await?;
        let ready=tauri::async_runtime::spawn_blocking({let app=app.clone();let version=update.version.clone();move||message(&app,"TypeRelay update ready",format!("TypeRelay {version} is downloaded. Restart and install it now?"),MessageDialogButtons::OkCancelCustom("Restart now".into(),"Later".into()))}).await?;
        if !ready{return Ok(());}
		#[cfg(target_os="linux")]
		{let directory=unpack_linux(&bytes,&update.version)?;let engine=directory.join("typerelay");Command::new(engine).arg("update").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;app.exit(0);Ok(())}
		#[cfg(target_os="windows")]
		{update.install(bytes)?;Ok(())}
		#[cfg(target_os="macos")]
		{update.install(bytes)?;app.restart();}
    }.await;
    state.installing.store(false,Ordering::SeqCst);emit(&app);result
}

pub fn check(app: AppHandle, manual: bool) {
    let state=app.state::<UpdateState>();if state.checking.swap(true,Ordering::SeqCst){return;}emit(&app);
    tauri::async_runtime::spawn(async move {
        let result=async {Ok::<_,anyhow::Error>(app.updater()?.check().await?)}.await;
        match result {
			Ok(Some(update))=>{let changed=app.state::<UpdateState>().available.lock().unwrap().replace(update.version.clone()).as_deref()!=Some(update.version.as_str());emit(&app);if manual {let download=tauri::async_runtime::spawn_blocking({let app=app.clone();let version=update.version.clone();move||message(&app,"TypeRelay update available",format!("TypeRelay {version} is available. Download it now?"),MessageDialogButtons::OkCancelCustom("Download".into(),"Later".into()))}).await.unwrap_or(false);if download&&let Err(error)=install(app.clone(),update).await{let text=error.to_string();let app2=app.clone();let _=tauri::async_runtime::spawn_blocking(move||message(&app2,"Update failed",text,MessageDialogButtons::Ok)).await;}}else if changed{notify_available(&app,&update.version);}},
            Ok(None)=>{*app.state::<UpdateState>().available.lock().unwrap()=None;if manual{let app2=app.clone();let _=tauri::async_runtime::spawn_blocking(move||message(&app2,"TypeRelay is up to date","You already have the latest version.",MessageDialogButtons::Ok)).await;}},
            Err(error)=>if manual{let app2=app.clone();let text=error.to_string();let _=tauri::async_runtime::spawn_blocking(move||message(&app2,"Update check failed",text,MessageDialogButtons::Ok)).await;},
        }
        app.state::<UpdateState>().checking.store(false,Ordering::SeqCst);emit(&app);
    });
}

pub fn schedule(app: AppHandle) {std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_secs(15));loop{check(app.clone(),false);std::thread::sleep(std::time::Duration::from_secs(6*60*60));}});}
