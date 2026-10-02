use anyhow::Result;
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,AtomicI64,Ordering},mpsc::{sync_channel,SyncSender}},time::Duration};
use tauri::{Emitter,Manager};
#[cfg(not(target_os="linux"))]
use typerelay_client::observation::{CaptureContext,CaptureSource};
use typerelay_client::{observation::{Change,Detector,Edit,Event,Settings,Store,CaptureFrame,CaptureHealth,CaptureStats,PassageWork,PassageProgress,PassageRevision},database::Database,config::Match};

enum Input { Legacy(Event),Captured(CaptureFrame) }
pub struct Observation { app:tauri::AppHandle, pub epoch:AtomicU64, pub enabled:AtomicBool, native:AtomicBool,session:Mutex<String>,health:Mutex<CaptureHealth>,stats:Mutex<CaptureStats>,protected:Mutex<Option<String>>,excluded:Mutex<Vec<String>>,verified:AtomicI64, pub status:Mutex<String>, observed:Mutex<Option<(String,i64)>>, store:Mutex<Store>, sender:SyncSender<Input> }
impl Observation {
    pub fn now()->i64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64}
    pub fn start(app:&tauri::AppHandle)->Result<()> {
        let root=app.state::<crate::Runtime>().root.clone();let store=Store::open(&root)?;let settings=store.settings()?;let(sender,receiver)=sync_channel(128);
        let state=Arc::new(Self{app:app.clone(),epoch:AtomicU64::new(1),enabled:AtomicBool::new(settings.enabled),native:AtomicBool::new(settings.native_capture),session:Mutex::new(uuid::Uuid::new_v4().to_string()),health:Mutex::new(CaptureHealth::default()),stats:Mutex::new(CaptureStats::default()),protected:Mutex::new(None),excluded:Mutex::new(settings.excluded_apps.clone()),verified:AtomicI64::new(0),status:Mutex::new("Disabled".into()),observed:Mutex::new(None),store:Mutex::new(store),sender});app.manage(state.clone());
        let handle=app.clone();let observer=state.clone();
        std::thread::spawn(move||{
            let mut detector=Detector::default();let mut epoch=observer.epoch.load(Ordering::SeqCst);let mut prune_at=0;let mut existing=std::collections::HashSet::new();let mut refresh_at=0;let mut work=None::<PassageWork>;let mut pending=std::collections::VecDeque::<PassageRevision>::new();let store=match Store::open(&root){Ok(store)=>store,Err(_)=>return};let _=store.recover_passages();
            loop {
                let event=receiver.recv_timeout(Duration::from_millis(if work.is_some()||!pending.is_empty(){1}else{100})).ok();let now=Self::now();let next_epoch=observer.epoch.load(Ordering::SeqCst);
                if epoch!=next_epoch {detector.clear_passages();pending.clear();if let Some(old)=work.take(){let _=store.cancel_passage(&old);}epoch=next_epoch;}
                let result=(||->Result<()>{
                    let settings=store.settings()?;
                    if epoch!=observer.epoch.load(Ordering::SeqCst){detector.reset();return Ok(());}
                    if now>=prune_at {for change in store.prune(now/1000,&settings)?{let _=handle.emit("suggestion-change",serde_json::json!({"epoch":epoch,"change":change}));}prune_at=now+60000;}
                    if !settings.enabled {detector.reset();return Ok(());}
                    if now>=refresh_at {existing=Store::existing(&Database::open(&root.join("snippets"))?)?;for change in store.suppress_existing(&existing)?{let _=handle.emit("suggestion-change",serde_json::json!({"epoch":epoch,"change":change}));}refresh_at=now+5000;}
                    match event {
                        Some(Input::Captured(frame))=>{
                            let app=frame.context.app.clone();let texts=detector.capture(frame,&settings,epoch,&observer.session.lock().unwrap(),now);
                            if detector.accepted_input(){*observer.observed.lock().unwrap()=Some((app,now));}let _=texts;
                        },
                        Some(Input::Legacy(event))if !settings.native_capture=>{if event.epoch==epoch&&event.safe&&event.direct&&settings.allows(&event.app)&&matches!(&event.edit,Edit::Text(text)if !text.is_empty()){*observer.observed.lock().unwrap()=Some((event.app.clone(),now));}detector.event(event,&settings,epoch,now);},
                        Some(Input::Legacy(_))=>{},
                        None if (0..=1500).contains(&(now-observer.verified.load(Ordering::SeqCst)))=>{detector.idle(now);},
                        None=>{detector.reset();},
                    };
                    for mut revision in detector.take_passages(){
                        if let Some(active)=&work&&active.same_window(&revision){active.merge_changes(&mut revision);store.cancel_passage(active)?;work=None;}
                        if let Some(last)=pending.back_mut()&&last.id==revision.id&&last.base==revision.base{revision.changed_from=revision.changed_from.min(last.changed_from);*last=revision;}else if pending.len()<8{pending.push_back(revision);}else{observer.native_status("Passage analysis busy; some input was skipped");}
                    }
                    if work.is_none()&&let Some(revision)=pending.pop_front(){work=Some(store.begin_passage(revision)?);}
                    if let Some(active)=&mut work&&let PassageProgress::Complete(changes)=store.advance_passage(active,&settings,now/1000)?{work=None;for change in changes{let _=handle.emit("suggestion-change",serde_json::json!({"epoch":epoch,"change":change}));}}
                    if work.is_none()&&pending.is_empty()&&detector.quiet(now)&&store.notification(now/1000,&settings)? {let app=handle.clone();std::thread::spawn(move||{let _=Self::notify(&app,false);});}
                    Ok(())
                })();
                *observer.stats.lock().unwrap()=detector.capture_stats();
                if result.is_err(){detector.clear_passages();pending.clear();if let Some(active)=work.take(){let _=store.cancel_passage(&active);}*observer.status.lock().unwrap()="Unavailable: local observation storage could not be updated".into();}
            }
        });
        {let observer=state.clone();std::thread::spawn(move||loop{let _=observer.publish_control();std::thread::sleep(Duration::from_millis(500));});}
        #[cfg(target_os="linux")]
        {let receiver=typerelay_client::panel_ipc::CaptureReceiver::bind()?;let observer=state.clone();std::thread::spawn(move||loop{let session=observer.session();match receiver.receive(&session){Ok(Some(typerelay_client::panel_ipc::CaptureBody::Frame(frame)))=>observer.capture(frame),Ok(Some(typerelay_client::panel_ipc::CaptureBody::Health(health)))=>observer.native_health(health),_=>std::thread::sleep(Duration::from_millis(5))}});}
        crate::platform::start_observation(state);Ok(())
    }
    pub fn safety(&self,safe:bool) {if self.native.load(Ordering::SeqCst){return;}self.verified.store(if safe{Self::now()}else{0},Ordering::SeqCst);if !safe{self.reset();}}
    pub fn feed(&self,event:Event) {if !self.enabled.load(Ordering::SeqCst)||self.native.load(Ordering::SeqCst){return;}if self.sender.try_send(Input::Legacy(event)).is_err(){self.epoch.fetch_add(1,Ordering::SeqCst);}}
    pub fn native(&self)->bool {self.native.load(Ordering::SeqCst)}
    pub fn session(&self)->String {self.session.lock().unwrap().clone()}
    pub fn capture(&self,frame:CaptureFrame){if !self.enabled.load(Ordering::SeqCst)||!self.native(){return;}if self.sender.try_send(Input::Captured(frame)).is_err(){self.epoch.fetch_add(1,Ordering::SeqCst);}}
    #[cfg(not(target_os="linux"))]
    pub fn native_event(&self,context:CaptureContext,source:CaptureSource,sequence:u64,edit:Edit,at_ms:i64){let frame=CaptureFrame{version:CaptureFrame::VERSION,session:self.session(),source_id:format!("{}:{source:?}",std::env::consts::OS),sequence,at_ms,context,source,edit};self.capture(frame);}
    pub fn native_health(&self,health:CaptureHealth){if self.native(){self.verified.store(if health.blocked.is_none(){Self::now()}else{0},Ordering::SeqCst);self.native_status(health.blocked.as_deref().unwrap_or("Native capture ready"));}*self.health.lock().unwrap()=health;}
    pub fn protect(&self,app:Option<String>){*self.protected.lock().unwrap()=app;}
    fn publish_control(&self)->Result<()> {
        #[cfg(target_os="linux")]
        {typerelay_client::panel_ipc::PanelIpc::configure_capture(&typerelay_client::panel_ipc::CaptureControl{version:1,session:self.session(),enabled:self.enabled.load(Ordering::SeqCst)&&self.native(),expires_ms:Self::now()+2000,protected_app:self.protected.lock().unwrap().clone(),excluded_apps:self.excluded.lock().unwrap().clone()})?;}
        Ok(())
    }
    pub fn reset(&self) {self.feed(Event{epoch:self.epoch.load(Ordering::SeqCst),field:String::new(),app:String::new(),safe:false,direct:false,edit:Edit::Reset});}
    pub fn status(&self,status:&str) {if !self.native(){self.native_status(status);}}
    pub fn native_status(&self,status:&str) {let mut current=self.status.lock().unwrap();if current.as_str()!=status{*current=status.into();let _=self.app.emit("observation-status",if self.enabled.load(Ordering::SeqCst){status}else{"Disabled"});}}
    pub fn open(app:&tauri::AppHandle) {crate::Runtime::open_panel(app,true,true);}
    pub fn notify(app:&tauri::AppHandle,test:bool)->Result<()> {
        let message=if test{"This is a test notification from Typerelay. Open it to return to Suggestions."}else{"Repeated text is ready to review in Typerelay."};
        #[cfg(target_os="macos")]
        {crate::platform::NativeNotifications::suggestion(app.clone(),message)}
        #[cfg(any(target_os="linux",target_os="windows"))]
        {let mut notification=notify_rust::Notification::new();notification.appname("Typerelay").summary(if test{"Typerelay notification test"}else{"Snippet suggestion"}).body(message).action("review","Review");
        #[cfg(target_os="linux")]
        notification.timeout(10000).action("default","Open suggestions");
        #[cfg(target_os="windows")]
        notification.app_id(&app.config().identifier);
        let notification=notification.show()?;let app=app.clone();std::thread::spawn(move||notification.wait_for_action(move|action|if action=="review"||action=="default"{let handle=app.clone();let _=app.run_on_main_thread(move||Self::open(&handle));}));Ok(())}
    }
    #[cfg(target_os="windows")]
    pub fn diagnostics_request(args:&[String])->Option<uuid::Uuid>{args.iter().position(|arg|arg=="--capture-status-request").and_then(|index|args.get(index+1)).and_then(|value|uuid::Uuid::parse_str(value).ok())}
    #[cfg(target_os="windows")]
    pub fn diagnostics_response(app:&tauri::AppHandle,args:&[String])->bool {
        let Some(id)=Self::diagnostics_request(args)else{return false;};
        if let Some(state)=app.try_state::<Arc<Self>>()&&let Ok(value)=state.diagnostics()&&let Ok(root)=typerelay_client::editor::Paths::config_dir(){let path=root.join("observations").join(format!("capture-status-{id}.json"));if let Ok(mut file)=std::fs::OpenOptions::new().write(true).create_new(true).open(path){let _=serde_json::to_writer(&mut file,&value);}}
        true
    }
    #[cfg(target_os="windows")]
    pub fn request_diagnostics()->Result<serde_json::Value> {
        let id=uuid::Uuid::new_v4();let root=typerelay_client::editor::Paths::config_dir()?;let path=root.join("observations").join(format!("capture-status-{id}.json"));
        let mut child=std::process::Command::new(std::env::current_exe()?).args(["--capture-status-request",&id.to_string()]).spawn()?;
        let result=(||->Result<serde_json::Value>{for _ in 0..100{if let Ok(bytes)=std::fs::read(&path)&&let Ok(value)=serde_json::from_slice(&bytes){return Ok(value);}std::thread::sleep(Duration::from_millis(50));}anyhow::bail!("Running Typerelay did not answer; start the matching desktop build")})();
        let _=std::fs::remove_file(path);if child.try_wait().ok().flatten().is_none(){let _=child.kill();}let _=child.wait();result
    }
    pub fn diagnostics(&self)->Result<serde_json::Value> {
        let settings=self.store.lock().unwrap().settings()?;
        let observed=self.observed.lock().unwrap().clone();let recent=observed.filter(|(_,at)|Self::now()-at<60000);
        #[cfg(target_os="macos")]
        let notifications=crate::platform::NativeNotifications::allowed();
        #[cfg(not(target_os="macos"))]
        let notifications:Option<bool>=None;
        #[cfg(target_os="windows")]
        let config=std::env::var_os("APPDATA").map(std::path::PathBuf::from);
        #[cfg(target_os="macos")]
        let config=std::env::var_os("HOME").map(|home|std::path::PathBuf::from(home).join("Library/Application Support"));
        #[cfg(target_os="linux")]
        let config=std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).or_else(||std::env::var_os("HOME").map(|home|std::path::PathBuf::from(home).join(".config")));
        let vscode=config.map(|root|root.join("Code/User/settings.json")).filter(|path|path.is_file()).map(|path|std::fs::read_to_string(path).ok().and_then(|text|Self::vscode_setting(&text)).unwrap_or("unknown".into()));
        let health=self.health.lock().unwrap().clone();
        #[cfg(target_os="linux")]
        let input=typerelay_client::panel_ipc::PanelIpc::input_health();
        #[cfg(not(target_os="linux"))]
        let input=serde_json::Value::Null;
        Ok(serde_json::json!({"epoch":self.epoch.load(Ordering::SeqCst),"platform":std::env::consts::OS,"enabled":settings.enabled,"notifications_enabled":settings.notifications,"native_capture":settings.native_capture,"capture":health,"input":input,"capture_stats":*self.stats.lock().unwrap(),"discovery":self.store.lock().unwrap().discovery_status()?,"edit_support":if settings.native_capture{"Backspace supported; arbitrary selection/replacement requires a verified edit provider"}else{"Provider-dependent"},"notifications_allowed":notifications,"accessibility":crate::platform::accessibility(false),"input_monitoring":crate::platform::input_monitoring(false),"status":if settings.enabled&&settings.native_capture&&Self::now()-health.at_ms>3000{"Native keyboard worker unavailable; restart it from Check setup".into()}else if settings.enabled{self.status.lock().unwrap().clone()}else{"Disabled".into()},"observed_app":recent.map(|(app,_)|app),"vscode":vscode}))
    }
    fn vscode_setting(text:&str)->Option<String> {serde_json::from_str::<serde_json::Value>(text).ok()?.get("editor.accessibilitySupport")?.as_str().filter(|value|["on","off","auto"].contains(value)).map(str::to_owned)}
    pub fn snapshot(&self)->Result<serde_json::Value> {let prefix=typerelay_client::settings::SettingsStore::open(self.app.state::<crate::Runtime>().root.join("settings.yml"))?.settings.trigger_prefix;let setup=self.diagnostics()?;let store=self.store.lock().unwrap();let settings=store.settings()?;Ok(serde_json::json!({"prefix":prefix,"setup":setup,"settings":settings,"status":if self.enabled.load(Ordering::SeqCst){self.status.lock().unwrap().clone()}else{"Disabled".into()},"candidates":store.list(Self::now()/1000,&settings)?,"changes":store.changes(Self::now()/1000,&settings)?,"epoch":self.epoch.load(Ordering::SeqCst)}))}
    pub fn configure(&self,settings:Settings)->Result<serde_json::Value> {settings.validate()?;let store=self.store.lock().unwrap();store.configure(&settings)?;*self.excluded.lock().unwrap()=settings.excluded_apps.clone();self.enabled.store(settings.enabled,Ordering::SeqCst);self.native.store(settings.native_capture,Ordering::SeqCst);*self.session.lock().unwrap()=uuid::Uuid::new_v4().to_string();self.publish_control()?;self.epoch.fetch_add(1,Ordering::SeqCst);*self.observed.lock().unwrap()=None;if settings.enabled{self.status("Waiting for a supported editable field");}Ok(serde_json::json!({"epoch":self.epoch.load(Ordering::SeqCst),"changes":store.changes(Self::now()/1000,&settings)?}))}
    pub fn forget(&self)->Result<u64> {let store=self.store.lock().unwrap();let epoch=self.epoch.fetch_add(1,Ordering::SeqCst)+1;store.forget()?;*self.session.lock().unwrap()=uuid::Uuid::new_v4().to_string();self.publish_control()?;*self.observed.lock().unwrap()=None;Ok(epoch)}
    pub fn action(&self,id:&str,revision:i64,action:&str)->Result<Change> {self.store.lock().unwrap().action(id,revision,action,Self::now()/1000)}
    pub fn save(&self,root:&std::path::Path,id:&str,revision:i64,library:&str,draft:Match)->Result<Change> {self.store.lock().unwrap().save(&Database::open(&root.join("snippets"))?,id,revision,library,draft,Self::now()/1000)}
    pub fn libraries(root:&std::path::Path)->Result<serde_json::Value> {let database=Database::open(&root.join("snippets"))?;let mut result=vec![];for library in database.libraries()? {let id=library["_id"].as_str().unwrap_or("");if library["state"]=="active"&&database.editable(id).is_ok(){result.push(serde_json::json!({"id":id,"name":library["name"],"synced":database.synced(id)?,"shared":library["shared"]==true}));}}Ok(serde_json::json!(result))}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os="windows")]
    #[test]
    fn diagnostic_requests_accept_only_a_nonce_not_a_path(){let id=uuid::Uuid::new_v4();assert_eq!(Observation::diagnostics_request(&["app".into(),"--capture-status-request".into(),id.to_string()]),Some(id));for args in [vec!["--capture-status-request".into()],vec!["--capture-status-request".into(),"../private.sqlite3".into()],vec!["--capture-status-request".into(),"C:\\private.json".into()]]{assert!(Observation::diagnostics_request(&args).is_none());}}
    #[test]
    fn setup_never_reports_unreadable_editor_settings_as_enabled() {
        assert_eq!(Observation::vscode_setting(r#"{"editor.accessibilitySupport":"off"}"#),Some("off".into()));
        assert_eq!(Observation::vscode_setting(r#"{"editor.accessibilitySupport":"on"}"#),Some("on".into()));
        for text in ["", "{}", r#"{"editor.accessibilitySupport":true}"#, "// user settings"]{assert_eq!(Observation::vscode_setting(text),None);}
    }
}
