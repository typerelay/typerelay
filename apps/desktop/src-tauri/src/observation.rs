use anyhow::Result;
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,AtomicI64,Ordering},mpsc::{sync_channel,SyncSender}},time::Duration};
use tauri::{Emitter,Manager};
use typerelay_client::{observation::{Change,Detector,Edit,Event,Settings,Store},database::Database,config::Match};

pub struct Observation { app:tauri::AppHandle, pub epoch:AtomicU64, pub enabled:AtomicBool, verified:AtomicI64, pub status:Mutex<String>, store:Mutex<Store>, sender:SyncSender<Event> }
impl Observation {
    pub fn now()->i64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64}
    pub fn start(app:&tauri::AppHandle)->Result<()> {
        let root=app.state::<crate::Runtime>().root.clone();let store=Store::open(&root)?;let settings=store.settings()?;let(sender,receiver)=sync_channel(128);
        let state=Arc::new(Self{app:app.clone(),epoch:AtomicU64::new(1),enabled:AtomicBool::new(settings.enabled),verified:AtomicI64::new(0),status:Mutex::new("Disabled".into()),store:Mutex::new(store),sender});app.manage(state.clone());
        let handle=app.clone();let observer=state.clone();
        std::thread::spawn(move||{
            let mut detector=Detector::default();let mut epoch=observer.epoch.load(Ordering::SeqCst);let mut prune_at=0;let mut existing=std::collections::HashSet::new();let mut refresh_at=0;
            loop {
                let event=receiver.recv_timeout(Duration::from_millis(100)).ok();let now=Self::now();let next_epoch=observer.epoch.load(Ordering::SeqCst);
                if epoch!=next_epoch {detector.reset();epoch=next_epoch;}
                let result=(||->Result<()>{
                    let store=observer.store.lock().unwrap();let settings=store.settings()?;
                    if epoch!=observer.epoch.load(Ordering::SeqCst){detector.reset();return Ok(());}
                    if now>=prune_at {for change in store.prune(now/1000,&settings)?{let _=handle.emit("suggestion-change",serde_json::json!({"epoch":epoch,"change":change}));}prune_at=now+60000;}
                    if !settings.enabled||!(0..=500).contains(&(now-observer.verified.load(Ordering::SeqCst))) {detector.reset();return Ok(());}
                    if now>=refresh_at {existing=Store::existing(&Database::open(&root.join("snippets"))?)?;for change in store.suppress_existing(&existing)?{let _=handle.emit("suggestion-change",serde_json::json!({"epoch":epoch,"change":change}));}refresh_at=now+5000;}
                    let text=if let Some(event)=event {detector.event(event,&settings,epoch,now)}else{detector.idle(now)};
                    if let Some(text)=text&&let Some(change)=store.observe(&text,now/1000,&settings,&existing)?{let _=handle.emit("suggestion-change",serde_json::json!({"epoch":epoch,"change":change}));}
                    if detector.quiet(now)&&store.notification(now/1000,&settings)? {let app=handle.clone();std::thread::spawn(move||Self::notify(&app));}
                    Ok(())
                })();
                if result.is_err(){detector.reset();*observer.status.lock().unwrap()="Unavailable: local observation storage could not be updated".into();}
            }
        });
        crate::platform::start_observation(state);Ok(())
    }
    pub fn safety(&self,safe:bool) {self.verified.store(if safe{Self::now()}else{0},Ordering::SeqCst);if !safe{self.reset();}}
    pub fn feed(&self,event:Event) {if !self.enabled.load(Ordering::SeqCst){return;}if self.sender.try_send(event).is_err(){self.epoch.fetch_add(1,Ordering::SeqCst);}}
    pub fn reset(&self) {self.feed(Event{epoch:self.epoch.load(Ordering::SeqCst),field:String::new(),app:String::new(),safe:false,direct:false,edit:Edit::Reset});}
    pub fn status(&self,status:&str) {let mut current=self.status.lock().unwrap();if current.as_str()!=status{*current=status.into();let _=self.app.emit("observation-status",if self.enabled.load(Ordering::SeqCst){status}else{"Disabled"});}}
    pub fn open(app:&tauri::AppHandle) {crate::Runtime::open(app,true);let _=app.emit("suggestions-open",());}
    fn notify(app:&tauri::AppHandle) {
        #[cfg(target_os="macos")]
        {let _=crate::platform::NativeNotifications::suggestion(app.clone());}
        #[cfg(any(target_os="linux",target_os="windows"))]
        {let mut notification=notify_rust::Notification::new();notification.appname("Typerelay").summary("Snippet suggestion").body("Repeated text is ready to review in Typerelay.").action("review","Review");
        #[cfg(target_os="windows")]
        notification.app_id(&app.config().identifier);
        if let Ok(notification)=notification.show(){let app=app.clone();notification.wait_for_action(move|action|if action=="review"||action=="default"{let handle=app.clone();let _=app.run_on_main_thread(move||Self::open(&handle));});}}
    }
    pub fn snapshot(&self)->Result<serde_json::Value> {let store=self.store.lock().unwrap();let settings=store.settings()?;store.prune(Self::now()/1000,&settings)?;Ok(serde_json::json!({"settings":settings,"status":if self.enabled.load(Ordering::SeqCst){self.status.lock().unwrap().clone()}else{"Disabled".into()},"candidates":store.list(Self::now()/1000,&settings)?,"changes":store.changes(Self::now()/1000,&settings)?,"epoch":self.epoch.load(Ordering::SeqCst)}))}
    pub fn configure(&self,settings:Settings)->Result<serde_json::Value> {settings.validate()?;let store=self.store.lock().unwrap();store.configure(&settings)?;self.enabled.store(settings.enabled,Ordering::SeqCst);self.epoch.fetch_add(1,Ordering::SeqCst);if settings.enabled{self.status("Waiting for a supported editable field");}Ok(serde_json::json!({"epoch":self.epoch.load(Ordering::SeqCst),"changes":store.changes(Self::now()/1000,&settings)?}))}
    pub fn forget(&self)->Result<u64> {let store=self.store.lock().unwrap();let epoch=self.epoch.fetch_add(1,Ordering::SeqCst)+1;store.forget()?;Ok(epoch)}
    pub fn action(&self,id:&str,revision:i64,action:&str)->Result<Change> {self.store.lock().unwrap().action(id,revision,action,Self::now()/1000)}
    pub fn save(&self,root:&std::path::Path,id:&str,revision:i64,library:&str,draft:Match)->Result<Change> {self.store.lock().unwrap().save(&Database::open(&root.join("snippets"))?,id,revision,library,draft,Self::now()/1000)}
    pub fn libraries(root:&std::path::Path)->Result<serde_json::Value> {let database=Database::open(&root.join("snippets"))?;let mut result=vec![];for library in database.libraries()? {let id=library["_id"].as_str().unwrap_or("");if library["state"]=="active"&&database.editable(id).is_ok(){result.push(serde_json::json!({"id":id,"name":library["name"],"synced":database.synced(id)?,"shared":library["shared"]==true}));}}Ok(serde_json::json!(result))}
}
