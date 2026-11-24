use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, sync::Mutex, time::Duration};
#[cfg(any(target_os="linux",test))]
use std::path::PathBuf;
#[cfg(target_os="linux")]
use std::{collections::BTreeSet, io::Cursor, process::{Command, Stdio}};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Default, PartialEq, Debug, Serialize)]
#[serde(rename_all="lowercase")]
enum Phase { #[default] Idle, Checking, Downloading, Ready, Prompting, Installing }

#[derive(Default)]
struct Status { busy: bool, manual: bool, phase: Phase, version: Option<String>, prompted: Option<String> }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckRequest { Start, Promote, Ignore }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Progress { Checking, Installing }

impl Progress {
    fn window(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Checking => ("update-checking", "update-checking.html", "TypeRelay — Checking for updates"),
            Self::Installing => ("update-installing", "update-installing.html", "TypeRelay — Installing update"),
        }
    }
}

impl Status {
    fn request(&mut self, manual: bool) -> CheckRequest {
        if !self.busy {
            self.busy=true; self.manual=manual; self.phase=Phase::Checking;
            return CheckRequest::Start;
        }
        if manual && self.can_promote() {
            self.manual=true;
            return CheckRequest::Promote;
        }
        CheckRequest::Ignore
    }
    fn can_promote(&self) -> bool { !self.manual && matches!(self.phase,Phase::Checking|Phase::Downloading) }
    fn offer(&mut self) -> bool {
        if self.phase!=Phase::Ready || self.version.is_none() || !self.manual && self.prompted==self.version { return false; }
        self.prompted=self.version.clone(); self.phase=Phase::Prompting; true
    }
    fn finish(&mut self, ready: bool) { self.busy=false; self.phase=if ready { Phase::Ready } else { Phase::Idle }; }
    fn progress(&self) -> Option<Progress> {
        match self.phase {
            Phase::Checking|Phase::Downloading if self.manual => Some(Progress::Checking),
            Phase::Installing => Some(Progress::Installing),
            _ => None,
        }
    }
    fn menu(&self) -> (&'static str, bool) {
        match self.phase {
            Phase::Downloading => ("Downloading update…", self.can_promote()),
            Phase::Installing => ("Installing update…", false),
            Phase::Checking => ("Checking for updates…", self.can_promote()),
            Phase::Prompting => ("Install update…", false),
            Phase::Ready => ("Install update…", !self.busy),
            Phase::Idle => ("Check for updates", !self.busy),
        }
    }
}

#[derive(Default)]
pub struct UpdateState { status: Mutex<Status>, ready: Mutex<Option<Update>>, progress: tauri::async_runtime::Mutex<()> }

// Metadata and payload live in one atomically published file, never a partially written pair.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Package { version: String, target: String, url: String, signature: String }

impl Package {
    fn from_update(update: &Update) -> Self { Self { version:update.version.clone(), target:format!("{}-{}",update.target,std::env::consts::ARCH), url:update.download_url.to_string(), signature:update.signature.clone() } }
    fn verify(&self, bytes: &[u8], pubkey: &str) -> Result<()> {
        let key=String::from_utf8(STANDARD.decode(pubkey)?)?; let signature=String::from_utf8(STANDARD.decode(&self.signature)?)?;
        minisign_verify::PublicKey::decode(&key)?.verify(bytes, &minisign_verify::Signature::decode(&signature)?, true)?; Ok(())
    }
    fn clear(root: &Path) -> Result<()> {
        match fs::remove_file(root.join("ready")) { Ok(())=>Ok(()), Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(()), Err(error)=>Err(error.into()) }
    }
    fn load(&self, root: &Path, pubkey: &str) -> Result<Option<Vec<u8>>> {
        let data=match fs::read(root.join("ready")) { Ok(data)=>data, Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None), Err(error)=>return Err(error.into()) };
        let valid=(||->Result<Vec<u8>> { let split=data.iter().position(|byte| *byte==b'\n').context("Invalid cached update")?; let metadata:Self=serde_json::from_slice(&data[..split])?; anyhow::ensure!(metadata==*self,"Cached update metadata changed"); let bytes=&data[split+1..]; self.verify(bytes,pubkey)?; Ok(bytes.to_vec()) })();
        match valid { Ok(bytes)=>Ok(Some(bytes)), Err(_)=>{Self::clear(root)?;Ok(None)} }
    }
    fn save(&self, root: &Path, bytes: &[u8], pubkey: &str) -> Result<()> {
        self.verify(bytes,pubkey)?; fs::create_dir_all(root)?;
        let temporary=root.join(format!("pending-{}",uuid::Uuid::new_v4()));
        let result=(||->Result<()> { let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?; serde_json::to_writer(&mut file,self)?; file.write_all(b"\n")?; file.write_all(bytes)?; file.sync_all()?; drop(file); Self::clear(root)?; fs::rename(&temporary,root.join("ready"))?; Ok(()) })();
        let _=fs::remove_file(&temporary); result
    }
    async fn prepare(&self, root: &Path, pubkey: &str, download: impl std::future::Future<Output=Result<Vec<u8>>>) -> Result<Vec<u8>> {
        if let Some(bytes)=self.load(root,pubkey)? { return Ok(bytes); }
        let bytes=download.await?; self.save(root,&bytes,pubkey)?; Ok(bytes)
    }
}

impl UpdateState {
    #[cfg(target_os="linux")]
    fn linux_target(bundle: Option<tauri::utils::config::BundleType>) -> Option<String> {
        use tauri::utils::config::BundleType;
        let suffix=match bundle { Some(BundleType::AppImage)=>"appimage", Some(BundleType::Deb)=>"deb", Some(BundleType::Rpm)=>"rpm", _=>return None };
        Some(format!("linux-{}-{suffix}",std::env::consts::ARCH))
    }
    pub fn value(&self) -> Value { let status=self.status.lock().unwrap(); json!({"checking":status.busy,"installing":status.phase==Phase::Installing,"version":status.version,"phase":status.phase}) }
    pub fn menu(&self) -> (&'static str, bool) { self.status.lock().unwrap().menu() }
    fn phase(&self, app: &AppHandle, phase: Phase) { self.status.lock().unwrap().phase=phase; emit(app); }
    async fn prepare(&self, app: &AppHandle, manual: bool) -> Result<Option<(Update, Vec<u8>)>> {
        let root=app.path().app_cache_dir()?.join("updates");
        // A tray action can use the feed-validated package already offered this session, even offline.
        let ready=if manual { self.ready.lock().unwrap().clone() } else { None };
        let update=match ready { Some(update)=>Some(update), None=>{
            let builder=app.updater_builder().timeout(Duration::from_secs(30));
            #[cfg(target_os="linux")]
            let builder=match Self::linux_target(tauri::utils::platform::bundle_type()) { Some(target)=>builder.target(target), None=>builder };
            builder.build()?.check().await?
        } };
        let Some(mut update)=update else {
            *self.ready.lock().unwrap()=None; self.status.lock().unwrap().version=None; Package::clear(&root)?;
            return Ok(None);
        };
        *self.ready.lock().unwrap()=None; self.status.lock().unwrap().version=Some(update.version.clone());
        self.phase(app,Phase::Downloading);
        // The updater plugin does not carry the check timeout over to the download.
        update.timeout=Some(Duration::from_secs(10*60));
        let pubkey=app.config().plugins.0.get("updater").and_then(|config|config.get("pubkey")).and_then(Value::as_str).context("Missing updater public key")?;
        let package=Package::from_update(&update);
        let bytes=package.prepare(&root,pubkey,async { Ok(update.download(|_,_|{},||{}).await?) }).await?;
        *self.ready.lock().unwrap()=Some(update.clone());
        Ok(Some((update,bytes)))
    }
    async fn run(&self, app: &AppHandle, manual: bool) -> Result<()> {
        let prepared=self.prepare(app,manual).await?;
        let (interactive, offer)={
            let mut status=self.status.lock().unwrap();
            status.phase=if prepared.is_some() { Phase::Ready } else { Phase::Idle };
            (status.manual,status.offer())
        };
        emit(app);
        sync_progress(app).await;
        if let Some((update,bytes))=prepared {
            if !offer { return Ok(()); }
            let accepted=tauri::async_runtime::spawn_blocking({ let app=app.clone(); let version=update.version.clone(); move||message(&app,"TypeRelay update ready",format!("TypeRelay {version} is ready. Install and restart?"),MessageDialogButtons::OkCancelCustom("Update & Restart".into(),"Later".into())) }).await?;
            if accepted {
                self.phase(app,Phase::Installing);
                sync_progress(app).await;
                install(app.clone(),update,bytes).await?;
            }
        } else if interactive {
            tauri::async_runtime::spawn_blocking({ let app=app.clone(); move||message(&app,"TypeRelay is up to date","You already have the latest version.",MessageDialogButtons::Ok) }).await?;
        }
        Ok(())
    }
}

async fn sync_progress(app: &AppHandle) {
    let state=app.state::<UpdateState>();
    let _progress=state.progress.lock().await;
    let visible=state.status.lock().unwrap().progress();
    if let Some(progress)=visible {
        let (label,page,title)=progress.window();
        if app.get_webview_window(label).is_none() {
            let handle=app.clone();
            // Creating a WebView2 window inside a main-thread event handler can deadlock.
            let create=tauri::async_runtime::spawn_blocking(move||->tauri::Result<()> {
                let window=WebviewWindowBuilder::new(&handle,label,WebviewUrl::App(page.into())).title(title).center()
                    .inner_size(320.0,112.0).resizable(false).decorations(false).always_on_top(true)
                    .visible(false).skip_taskbar(true).build()?;
                window.on_window_event(|event|if let tauri::WindowEvent::CloseRequested{api,..}=event { api.prevent_close(); });
                Ok(())
            });
            if let Err(error)=create.await.and_then(|result|result) { eprintln!("TypeRelay update progress window: {error}"); }
        }
    }
    let (done,mut result)=tauri::async_runtime::channel(1);
    let handle=app.clone();
    // Wait for show/hide on the UI thread before starting work or opening a native dialog.
    let dispatched=app.run_on_main_thread(move|| { let _=done.try_send(render_progress(&handle)); });
    if let Err(error)=match dispatched { Ok(())=>result.recv().await.unwrap_or(Ok(())), Err(error)=>Err(error) } {
        eprintln!("TypeRelay update progress window: {error}");
    }
}

fn render_progress(app: &AppHandle) -> tauri::Result<()> {
    let visible=app.state::<UpdateState>().status.lock().unwrap().progress();
    for progress in [Progress::Checking,Progress::Installing] {
        let (label,_,_)=progress.window();
        if let Some(window)=app.get_webview_window(label) {
            if visible==Some(progress) { window.show()?; window.set_focus()?; }
            else { window.hide()?; }
        }
    }
    Ok(())
}

fn emit(app: &AppHandle) { let _=app.emit("update-status",app.state::<UpdateState>().value()); crate::tray::Tray::update(app); }

fn message(app: &AppHandle, title: &str, body: impl Into<String>, buttons: MessageDialogButtons) -> bool {
    app.dialog().message(body).title(title).buttons(buttons).blocking_show()
}

#[cfg(target_os="linux")]
fn unpack_linux(bytes: &[u8], version: &str) -> Result<PathBuf> {
    let root=std::env::temp_dir().join(format!("typerelay-update-{}-{}",std::process::id(),uuid::Uuid::new_v4()));fs::create_dir(&root)?;
    let result=(||->Result<()>{let allowed=BTreeSet::from(["typerelay".to_string(),"typerelay-tui".to_string(),"typerelay-panel".to_string(),"typerelay-ai".to_string()]);let mut found=BTreeSet::new();let mut archive=tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));for item in archive.entries()?{let mut item=item?;let path=item.path()?.into_owned();let name=path.file_name().and_then(|value|value.to_str()).context("Update contains an invalid path")?;if path.components().count()!=1||!allowed.contains(name)||!item.header().entry_type().is_file(){anyhow::bail!("Update contains an unsafe or unexpected file");}let destination=root.join(name);item.unpack(&destination)?;found.insert(name.to_string());}anyhow::ensure!(found==allowed,"Update must contain matching engine, TUI, panel and AI binaries");for name in allowed{let file=root.join(&name);let output=Command::new(&file).arg("--version").output()?;anyhow::ensure!(output.status.success()&&String::from_utf8_lossy(&output.stdout).trim()==format!("{name} {version}"),"{name} version does not match {version}");}Ok(())})();
    if let Err(error)=result {let _=fs::remove_dir_all(&root);return Err(error);}
    Ok(root)
}

async fn install(app: AppHandle, update: Update, bytes: Vec<u8>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move||->Result<()> {
        typerelay_client::native_ai::NativeAi::stop(&app.state::<crate::Runtime>().root)?;
        #[cfg(target_os="linux")]
        {
            if tauri::utils::platform::bundle_type().is_some() { update.install(bytes)?; app.restart(); }
            let directory=unpack_linux(&bytes,&update.version)?;let engine=directory.join("typerelay");if let Err(error)=Command::new(engine).arg("update").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn(){let _=fs::remove_dir_all(directory);return Err(error.into());}app.exit(0);Ok(())
        }
        #[cfg(target_os="windows")]
        { let _=app; update.install(bytes)?; Ok(()) }
        #[cfg(target_os="macos")]
        {update.install(bytes)?;app.restart();}
    }).await?
}

pub fn check(app: AppHandle, manual: bool) {
    let request=app.state::<UpdateState>().status.lock().unwrap().request(manual);
    if request==CheckRequest::Ignore { return; }
    // Linux menu callbacks run on the tray thread; emit only after dispatch to avoid a tray update deadlock.
    tauri::async_runtime::spawn(async move {
        emit(&app);
        if manual { sync_progress(&app).await; }
        if request==CheckRequest::Promote { return; }
        let state=app.state::<UpdateState>(); let result=state.run(&app,manual).await;
        let ready=state.ready.lock().unwrap().is_some();
        if let Err(error)=result {
            let interactive={
                let mut status=state.status.lock().unwrap();
                let interactive=status.manual || matches!(status.phase,Phase::Prompting|Phase::Installing);
                status.phase=if ready { Phase::Ready } else { Phase::Idle };
                interactive
            };
            sync_progress(&app).await;
            eprintln!("TypeRelay update failed: {error:#}");
            if interactive {
                let _=tauri::async_runtime::spawn_blocking({ let app=app.clone(); move||app.dialog().message(format!("{error:#}\nTry again from the update menu.")).title("Update failed").kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show() }).await;
            }
        } else if state.status.lock().unwrap().phase==Phase::Installing {
            // The installer has taken over. Keep progress visible until the app closes.
            return;
        }
        state.status.lock().unwrap().finish(ready); emit(&app);
    });
}

pub fn schedule(app: AppHandle) {std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_secs(15));loop{check(app.clone(),false);std::thread::sleep(std::time::Duration::from_secs(6*60*60));}});}

#[cfg(test)]
#[path="update_tests.rs"]
mod tests;
