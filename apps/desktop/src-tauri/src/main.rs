#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod platform;
mod browser_bridge;
mod tray;
mod update;
use anyhow::{Context, Result, ensure};
use serde_json::{json,Value};
use std::{sync::{Mutex,atomic::{AtomicBool,Ordering}},path::PathBuf};
use tauri::{Manager,Emitter};
use typerelay_client::{panel::{Panel,PanelSettings,Hit},editor::Paths,database::Database,sync::Sync};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
#[cfg(not(target_os="linux"))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

struct Runtime { root:PathBuf, target:Mutex<Option<platform::Target>>, last:Mutex<Option<platform::Target>>, erase:Mutex<usize>, busy:AtomicBool, syncing:AtomicBool, authenticating:AtomicBool, cancel_auth:AtomicBool, auth_error:Mutex<String>, prompting:AtomicBool, prompt_hit:Mutex<Option<Hit>>, settings:AtomicBool, status:Mutex<String>, #[cfg(any(target_os="windows",target_os="macos"))] expansion_started:AtomicBool, #[cfg(target_os="linux")] registration:Mutex<Option<typerelay_client::desktop::Registration>> }
impl Runtime {
	fn callback_argument(args:&[String])->Option<&str>{args.iter().find(|arg|arg.starts_with("typerelay://oauth/callback?code=")).map(String::as_str)}
	fn receive_callback(args:&[String])->bool{let Some(url)=Self::callback_argument(args)else{return false;};Paths::config_dir().and_then(|root|Sync::receive_callback(&root,url).map(|_|())).is_ok()}
	#[cfg(target_os="macos")]
	fn permission_message(accessibility:bool,input_monitoring:bool)->Option<&'static str> {match(accessibility,input_monitoring){(false,false)=>Some("TypeRelay needs Input Monitoring, then Accessibility. Open Settings to allow both."),(false,true)=>Some("TypeRelay needs Accessibility. Open Settings to allow it."),(true,false)=>Some("TypeRelay needs Input Monitoring. Open Settings to allow it."),(true,true)=>None}}
	#[cfg(target_os="macos")]
	fn permissions()->(bool,bool) {let input_monitoring=platform::input_monitoring(false);let accessibility=platform::accessibility(false);(accessibility,input_monitoring)}
	#[cfg(target_os="macos")]
	fn update_permission_status(&self,accessibility:bool,input_monitoring:bool) {let message=Self::permission_message(accessibility,input_monitoring);let mut status=self.status.lock().unwrap();if let Some(message)=message{*status=message.into();}else if status.starts_with("TypeRelay needs Accessibility")||status.starts_with("TypeRelay needs Input Monitoring"){status.clear();}}
	#[cfg(any(target_os="windows",target_os="macos"))]
	fn start_expansion(app:&tauri::AppHandle)->Result<()> {let state=app.state::<Runtime>();if state.expansion_started.swap(true,Ordering::SeqCst){return Ok(());}let result=(||{let requests=platform::ExpansionSession::start(state.root.join("snippets"),state.root.join("settings.yml"))?;let handle=app.clone();std::thread::spawn(move||for request in requests{if let Err(error)=Runtime::expand(&handle,request){let message=format!("Expansion failed: {error:#}");Runtime::notice(&handle,&message,true);}});Ok(())})();if result.is_err(){state.expansion_started.store(false,Ordering::SeqCst);}result}
    fn hide_on_focus_loss()->bool { cfg!(not(target_os="linux")) }
    fn notice(app:&tauri::AppHandle,message:&str,error:bool) {
        #[cfg(target_os="macos")]
        let result=platform::NativeNotifications::show(message,error);
        #[cfg(any(target_os="linux",target_os="windows"))]
        let result={let mut notice=notify_rust::Notification::new();notice.appname("TypeRelay").summary(if error{"TypeRelay — Error"}else{"TypeRelay"}).body(message);if error{notice.urgency(notify_rust::Urgency::Critical).timeout(notify_rust::Timeout::Never).action("dismiss","Dismiss");}#[cfg(target_os="windows")]notice.app_id(&app.config().identifier);notice.show().map(|_|()).map_err(anyhow::Error::from)};
        if let Err(failure)=result{eprintln!("TypeRelay notification unavailable: {failure:#}");app.dialog().message(format!("{message}\n\nNative notifications are unavailable: {failure:#}")).title("TypeRelay").kind(tauri_plugin_dialog::MessageDialogKind::Error).show(|_|{});}
    }
    fn sync_notice(app:&tauri::AppHandle,message:&str,running:bool) {
        let _=app.emit("sync-notice",json!({"running":running}));
        Self::notice(app,message,message.starts_with("Sync failed")||message.contains("need attention"));
    }
    fn quit(app:&tauri::AppHandle) {
        if app.state::<Runtime>().busy.load(Ordering::SeqCst) {let _=app.emit("panel-error","Insertion is finishing; try Quit again in a moment");return;}
        app.exit(0);
    }
    fn open(app: &tauri::AppHandle, settings:bool) {
        let state=app.state::<Runtime>(); if state.busy.load(Ordering::SeqCst) {return;}
        if state.prompt_hit.lock().unwrap().is_none(){*state.erase.lock().unwrap()=0;}
        let Some(window)=app.get_webview_window("panel") else{return;};
        if state.prompting.load(Ordering::SeqCst) && window.is_visible().unwrap_or(false) { let _=window.set_focus(); return; }
        if !window.is_visible().unwrap_or(false) {
            let captured=platform::Target::capture();
            let target=captured.as_ref().ok().cloned().or_else(||if platform::fallback_allowed(){state.last.lock().unwrap().clone()}else{None});
            if target.is_none(){
                let message=captured.err().map(|e|e.to_string()).unwrap_or("Choose an application to insert into".into());
                #[cfg(target_os="macos")]
                {let (accessibility,input_monitoring)=Runtime::permissions();*state.status.lock().unwrap()=Runtime::permission_message(accessibility,input_monitoring).unwrap_or(&message).into();}
                #[cfg(not(target_os="macos"))]
                {*state.status.lock().unwrap()=message;}
            }
            *state.target.lock().unwrap()=target;
        }
        state.settings.store(settings,Ordering::SeqCst);
        if let Some(target)=state.target.lock().unwrap().as_ref() {
            if let Some((x,y,w,h))=target.bounds {
                let point=(x as f64+w as f64/2.,y as f64+h as f64/2.);
                let monitor=window.available_monitors().ok().and_then(|monitors|monitors.into_iter().find(|m|{let scale=if cfg!(target_os="windows"){1.}else{m.scale_factor()};let p=m.position();let size=m.size();point.0>=p.x as f64/scale && point.1>=p.y as f64/scale && point.0<(p.x as f64+size.width as f64)/scale && point.1<(p.y as f64+size.height as f64)/scale}));
                if let Some(m)=monitor{let scale=m.scale_factor();let _=window.set_position(tauri::PhysicalPosition::new(m.position().x+((m.size().width as f64-640.*scale)/2.) as i32,m.position().y+((m.size().height as f64-480.*scale)/2.) as i32));}else{let _=window.center();}
            }
            else {let _=window.center();}
        } else {let _=window.center();}
        let _=window.show(); let _=window.set_focus();
        let _=app.emit("panel-open",json!({"prompt":state.prompt_hit.lock().unwrap().clone(),"settings":settings,"status":*state.status.lock().unwrap(),"theme":Self::theme()}));
        #[cfg(target_os="linux")]
        {
            let app=app.clone(); std::thread::spawn(move || {
                use typerelay_client::desktop::{Hyprland,Registration};
                for _ in 0..40 {
                    if let Ok(window)=Hyprland::query("activewindow")
                        && window["pid"] == std::process::id() {
                            if let Some(address)=window["address"].as_str() {
                                let selector=serde_json::to_string(&format!("address:{address}")).unwrap();
                                let mut commands=String::new();
                                if window["floating"] != true { commands.push_str(&format!("hl.dispatch(hl.dsp.window.float({{window={selector}, action=\"toggle\"}}));")); }
                                commands.push_str(&format!("hl.dispatch(hl.dsp.window.resize({{window={selector},x=640,y=480}}));"));
                                if let Some((x,y,w,h))=app.state::<Runtime>().target.lock().unwrap().as_ref().and_then(|target|target.bounds) { commands.push_str(&format!("hl.dispatch(hl.dsp.window.move({{window={selector},x={},y={}}}));",x+(w as i32-640)/2,y+(h as i32-480)/2)); }
                                let _=std::process::Command::new("hyprctl").args(["eval",&commands]).output();
                                if let Ok(registration)=Registration::panel(address) { *app.state::<Runtime>().registration.lock().unwrap()=Some(registration); }
                            }
                            break;
                        }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            });
        }
    }
    #[cfg(any(target_os="windows",target_os="macos"))]
    fn expand(app:&tauri::AppHandle,request:platform::ExpansionRequest)->Result<()>{
        #[cfg(target_os="windows")]
        let platform::ExpansionRequest{target,expansion,released}=request;
        #[cfg(target_os="macos")]
        let platform::ExpansionRequest{target,expansion,released,deferred}=request;
        let release=released.recv_timeout(std::time::Duration::from_secs(2)).context("Release Space before expansion");
        #[cfg(target_os="windows")]
        release?;
        #[cfg(target_os="macos")]
        if let Err(error)=release{deferred.finish(&target)?;return Err(error);}
        std::thread::sleep(std::time::Duration::from_millis(75));
        #[cfg(target_os="macos")]
        if deferred.cancelled(){deferred.finish(&target)?;return Ok(());}
        #[cfg(target_os="macos")]
        let prompted=expansion.template.as_ref().is_some_and(|template|template.prompted);
        #[cfg(target_os="macos")]
        if prompted&&deferred.finish(&target)?>0{return Ok(());}
        let result=(||->Result<()>{
        if let Some(template)=expansion.template {
            let identity=template.identity.context("Template identity unavailable")?;
            let hit=Hit{id:identity.id,library:identity.library,revision:identity.revision,library_name:String::new(),title:template.abbreviation.clone(),abbreviation:template.abbreviation,preview:String::new()};
            if template.prompted {
				let state=app.state::<Runtime>();if state.busy.load(Ordering::SeqCst)||state.prompting.load(Ordering::SeqCst){#[cfg(target_os="windows")]platform::paste(&target,0,Some(typerelay_client::clipboard_payload::ClipboardPayload::text(" ".into())))?;return Ok(());}
                let prompt_app=app.clone();let main_app=prompt_app.clone();let prompt_target=target.clone();prompt_app.run_on_main_thread(move||{let state=main_app.state::<Runtime>();*state.target.lock().unwrap()=Some(prompt_target);*state.erase.lock().unwrap()=expansion.erase;*state.prompt_hit.lock().unwrap()=Some(hit);state.prompting.store(true,Ordering::SeqCst);Runtime::open(&main_app,false);})?;return Ok(());
            }
			let directory=app.state::<Runtime>().root.join("snippets");let steps=Panel::steps_at(&directory,&hit,Default::default(),false,typerelay_client::templates::Templates::clock())?;let mut erase=expansion.erase;
			for step in steps {Panel::content(&directory,&hit)?;platform::paste(&target,std::mem::take(&mut erase),match step{typerelay_client::clipboard_payload::ClipboardStep::Payload(payload)=>Some(payload),typerelay_client::clipboard_payload::ClipboardStep::Enter=>None})?;}
		}else{platform::paste(&target,expansion.erase,Some(typerelay_client::clipboard_payload::ClipboardPayload::text(expansion.text)))?;}
        Ok(())})();
        #[cfg(target_os="macos")]
        if !prompted {let replay=deferred.finish(&target).map(|_|());return result.and(replay);}
        result
    }
    fn hide(app:&tauri::AppHandle) {
        if let Some(window)=app.get_webview_window("panel") {let _=window.hide();}
        #[cfg(target_os="linux")]
        { app.state::<Runtime>().registration.lock().unwrap().take(); }
    }
    fn theme()->Value {
        let result=json!({"os":std::env::consts::OS});
        #[cfg(target_os="linux")]
        let mut result=result;
        #[cfg(target_os="linux")]
        if let Some(home)=std::env::var_os("HOME") {
            for path in [".local/state/omarchy/current/theme/colors.toml",".config/omarchy/current/theme/colors.toml"] {
                if let Ok(text)=std::fs::read_to_string(PathBuf::from(&home).join(path)) {
                    for line in text.lines() {if let Some((key,value))=line.split_once('=') {let value=value.trim().trim_matches('"'); if value.len()==7 && value.starts_with('#') && value[1..].bytes().all(|v|v.is_ascii_hexdigit()) {match key.trim(){"background"=>result["background"]=json!(value),"foreground"=>result["foreground"]=json!(value),"accent"=>result["accent"]=json!(value),_=>()}}}}
                    break;
                }
            }
        }
        result
    }
    fn shortcut(app:&tauri::AppHandle, old:Option<&str>, value:&str)->Result<()> {
        Panel::shortcut(value)?;
        #[cfg(not(target_os="linux"))]
        {
            if old != Some(value) { app.global_shortcut().on_shortcut(value,|app,_,event| {if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {Runtime::open(app,false);}}).context("Shortcut already in use; choose another")?; if let Some(old)=old {let _=app.global_shortcut().unregister(old);} }
        }
        #[cfg(target_os="linux")]
        {
            let _=(app,old);
            let binds=typerelay_client::desktop::Hyprland::query("binds")?;
            anyhow::ensure!(!typerelay_client::desktop::Hyprland::shortcut_conflicts(value,&binds)?,"Shortcut is assigned in Hyprland; choose another");
            Paths::atomic_write(&typerelay_client::panel_ipc::PanelIpc::directory()?.join("ready"),std::process::id().to_string().as_bytes(),false)?;
        }
        Ok(())
    }
}
#[tauri::command]
fn initialize(app:tauri::AppHandle)->std::result::Result<Value,String> {
    let state=app.state::<Runtime>(); let settings=Panel::settings(&state.root).map_err(|e|e.to_string())?;
		let empty=Database::open(&state.root.join("snippets")).and_then(|db|db.snapshot()).map(|snapshot|snapshot.is_empty()).unwrap_or(false);
		#[cfg(target_os="macos")]
		let (accessibility,input_monitoring)=Runtime::permissions();
		#[cfg(not(target_os="macos"))]
		let accessibility=platform::accessibility(false);
		#[cfg(not(target_os="macos"))]
		let input_monitoring=platform::input_monitoring(false);
		#[cfg(target_os="macos")]
		{state.update_permission_status(accessibility,input_monitoring);if accessibility&&input_monitoring{match Runtime::start_expansion(&app){Ok(())=>{let mut status=state.status.lock().unwrap();if status.starts_with("TypeRelay could not start Input Monitoring"){status.clear();}},Err(error)=>*state.status.lock().unwrap()=format!("TypeRelay could not start Input Monitoring: {error:#}")}}}
		#[cfg(target_os="macos")]
		let notifications=platform::NativeNotifications::allowed();
		#[cfg(not(target_os="macos"))]
		let notifications:Option<bool>=None;
		let connected=state.root.join("sync/credentials.json").exists();let authenticating=state.authenticating.load(Ordering::SeqCst);
		Ok(json!({"config":settings,"prompt":state.prompt_hit.lock().unwrap().clone(),"server":typerelay_client::settings::SettingsStore::open(state.root.join("settings.yml")).ok().map(|s|s.settings.sync_url).unwrap_or_default(),"connected":connected,"connection_state":if authenticating{"authenticating"}else if connected{"connected"}else{"disconnected"},"auth_error":*state.auth_error.lock().unwrap(),"theme":Runtime::theme(),"settings":state.settings.load(Ordering::SeqCst),"status":*state.status.lock().unwrap(),"update":app.state::<update::UpdateState>().value(),"accessibility":accessibility,"input_monitoring":input_monitoring,"notifications":notifications,"empty":empty,"version":app.package_info().version.to_string()}))
}
#[tauri::command]
async fn search(app:tauri::AppHandle,query:String)->std::result::Result<Value,String> {
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move ||Panel::search(&directory,&query).and_then(|hits|Panel::personal_rows(&directory,&hits)).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn personal_status(app:tauri::AppHandle,hits:Vec<Hit>)->std::result::Result<Value,String> {
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move ||Panel::personal_rows(&directory,&hits).map_err(|error|error.to_string())).await.map_err(|error|error.to_string())?
}
#[tauri::command]
async fn personal_abbreviation(app:tauri::AppHandle,hit:Hit,change:Option<Value>)->std::result::Result<Value,String> {
    let root=app.state::<Runtime>().root.clone();
    tauri::async_runtime::spawn_blocking(move || (|| -> Result<Value> {
        let db=Database::open(&root.join("snippets"))?; let library=db.library(&hit.library)?;
        ensure!(library["shared"]==true && library["permissions"]["read"]==true, "Shared library is no longer available");
        let record=db.records(&hit.library)?.into_iter().find(|row|row["id"]==hit.id && row["state"]=="active").context("Snippet no longer exists")?;
        if let Some(change)=change { db.personal_edit(&hit.library,&hit.id,change["trigger"].as_str(),change["base_revision"].as_i64().context("Missing personal revision")?,change["conflict"].as_str())?; let _=Sync::trigger(&root); }
        Ok(json!({"personal":db.personal(&hit.id)?,"shared_trigger":record["trigger"],"can_edit":library["permissions"]["edit"]==true}))
    })().map_err(|error|error.to_string())).await.map_err(|error|error.to_string())?
}
#[tauri::command]
async fn insert(app:tauri::AppHandle,hit:Hit,values:Option<std::collections::BTreeMap<String,String>>)->std::result::Result<(),String> {
    let state=app.state::<Runtime>(); if state.busy.swap(true,Ordering::SeqCst){return Err("Insertion already in progress".into());}
    let target=state.target.lock().unwrap().clone(); let directory=state.root.join("snippets");
    #[cfg(not(target_os="linux"))]
    let erase=*state.erase.lock().unwrap();
    let Some(target)=target else{state.busy.store(false,Ordering::SeqCst);return Err("No original window; use Copy".into());};
    let clock=typerelay_client::templates::Templates::clock();
    Runtime::hide(&app);
    let result=tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let values=values.unwrap_or_default();
		let steps=Panel::steps_at(&directory,&hit,values.clone(),false,clock)?;
        target.restore()?;
        #[cfg(target_os="linux")]
		{ let _=steps; typerelay_client::panel_ipc::PanelIpc::insert(typerelay_client::panel_ipc::Request{hit,values,generation:None,clock:Some(clock),erase:0,prepare:false,target:target.address.clone(),created_ms:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis()})?; }
        #[cfg(not(target_os="linux"))]
		{ let mut erase=erase;for step in steps { Panel::content(&directory,&hit)?; platform::paste(&target,std::mem::take(&mut erase),match step { typerelay_client::clipboard_payload::ClipboardStep::Payload(payload)=>Some(payload),typerelay_client::clipboard_payload::ClipboardStep::Enter=>None })?; } }
        Ok(())
    }).await.map_err(|e|e.to_string()).and_then(|r|r.map_err(|e|e.to_string()));
    app.state::<Runtime>().busy.store(false,Ordering::SeqCst);
    if result.is_ok(){let state=app.state::<Runtime>();state.status.lock().unwrap().clear();*state.erase.lock().unwrap()=0;state.prompting.store(false,Ordering::SeqCst);state.prompt_hit.lock().unwrap().take();}
    if let Err(error)=&result { eprintln!("TypeRelay insertion failed: {error}");*app.state::<Runtime>().status.lock().unwrap()=error.clone(); if let Some(window)=app.get_webview_window("panel"){let _=window.show();let _=window.set_focus();} }
    result
}
#[tauri::command]
async fn copy_snippet(app:tauri::AppHandle,hit:Hit,values:Option<std::collections::BTreeMap<String,String>>)->std::result::Result<(),String> {
    let directory=app.state::<Runtime>().root.join("snippets");
	 tauri::async_runtime::spawn_blocking(move ||->Result<()>{let content=Panel::content(&directory,&hit)?;if content["type"]=="rich_text"{let(_,payload)=Panel::rich_payload(&directory,&content,values.unwrap_or_default(),false)?;platform::copy_payload(payload)}else{Panel::render(&directory,&hit,values.unwrap_or_default(),false).and_then(|rendered|platform::copy(rendered.text))}}).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}
#[tauri::command]
async fn prepare_template(app:tauri::AppHandle,hit:Hit,values:Option<std::collections::BTreeMap<String,String>>)->std::result::Result<Value,String> {
    let directory=app.state::<Runtime>().root.join("snippets");
	 tauri::async_runtime::spawn_blocking(move||->Result<Value>{let content=Panel::content(&directory,&hit)?;if content["type"]=="rich_text"{let(rendered,_)=Panel::rich_payload(&directory,&content,values.unwrap_or_default(),true)?;Ok(serde_json::json!({"template":{"variables":rendered.variables},"fields":rendered.fields,"steps":rendered.steps.iter().map(|step|match step{typerelay_core::rich_text::RichStep::Content{text,..}=>serde_json::json!({"kind":"text","text":text}),typerelay_core::rich_text::RichStep::Enter=>serde_json::json!({"kind":"enter"})}).collect::<Vec<_>>(),"text":rendered.text,"enter_actions":rendered.enter_actions}))}else{Ok(serde_json::to_value(Panel::render(&directory,&hit,values.unwrap_or_default(),true)?)?)}}).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}
#[tauri::command]
fn set_prompt_view(app:tauri::AppHandle,enabled:bool){let state=app.state::<Runtime>();state.prompting.store(enabled,Ordering::SeqCst);if !enabled{state.prompt_hit.lock().unwrap().take();*state.erase.lock().unwrap()=0;}}
#[tauri::command]
fn set_settings_view(app:tauri::AppHandle,enabled:bool){app.state::<Runtime>().settings.store(enabled,Ordering::SeqCst);}
#[tauri::command]
fn dismiss(app:tauri::AppHandle){set_prompt_view(app.clone(),false);Runtime::hide(&app);}
#[tauri::command]
async fn notify(app:tauri::AppHandle,message:String,error:bool)->std::result::Result<(),String>{
    if message.trim().is_empty(){return Ok(());}
    let message=message.chars().take(4096).collect::<String>();
    tauri::async_runtime::spawn_blocking(move||Runtime::notice(&app,&message,error)).await.map_err(|e|e.to_string())
}
#[tauri::command]
fn sync_now(app:tauri::AppHandle)->std::result::Result<(),String>{
    if app.state::<Runtime>().syncing.swap(true,Ordering::SeqCst) {return Ok(());}
    std::thread::spawn(move||{
        Runtime::sync_notice(&app,"Starting to sync…",true);
        let root=app.state::<Runtime>().root.clone();
        let result=(||->Result<String>{
            anyhow::ensure!(root.join("sync/credentials.json").exists(),"Authenticate in TypeRelay settings first");
            let sync=Sync::new(root.clone(),root.join("snippets"))?;
            let waiting=std::time::Instant::now();
            loop {
                match sync.cycle() {
                    Err(error) if error.to_string().contains("Sync already running") && waiting.elapsed()<std::time::Duration::from_secs(30)=>std::thread::sleep(std::time::Duration::from_millis(500)),
                    outcome=>{outcome?;break;}
                }
            }
            let db=Database::open(&root.join("snippets"))?;
            let conflicts=db.meta("conflicts")?.and_then(|value|value.as_array().map(Vec::len)).unwrap_or(0);
            let rejected=db.meta("last_failure")?.and_then(|value|value.as_str().map(|text|!text.is_empty())).unwrap_or(false);
            Ok(if conflicts>0 || rejected {"Sync completed — some changes need attention. Review the web app or TUI for details.".into()}else{"Sync successful".into()})
        })();
        let message=match result {Ok(message)=>message,Err(error)=>{let _=Paths::atomic_write(&root.join("sync/status"),format!("Sync: {error:#}").as_bytes(),false);if !root.join("sync/credentials.json").exists(){"Sync failed — authenticate in TypeRelay settings first.".into()}else{"Sync failed. Check your connection and TypeRelay sync status.".into()}}};
        Runtime::sync_notice(&app,&message,false);
        app.state::<Runtime>().syncing.store(false,Ordering::SeqCst);
    });
    Ok(())
}
#[tauri::command]
fn save_settings(app:tauri::AppHandle,config:PanelSettings)->std::result::Result<(),String> {
    let root=&app.state::<Runtime>().root;
    let old=Panel::settings(root).map_err(|e|e.to_string())?;
    Runtime::shortcut(&app,Some(&old.shortcut),&config.shortcut).map_err(|e|e.to_string())?;
    let result=(||->Result<()>{if config.launch_at_login{app.autolaunch().enable()?;}else{app.autolaunch().disable()?;} Panel::save_settings(root,&config)})();
    if result.is_err(){let _=Runtime::shortcut(&app,Some(&config.shortcut),&old.shortcut);if old.launch_at_login{let _=app.autolaunch().enable();}else{let _=app.autolaunch().disable();}}
    result.map_err(|e|e.to_string())
}
#[tauri::command]
async fn connect(app:tauri::AppHandle,url:String)->std::result::Result<(),String> {
	let state=app.state::<Runtime>();if state.authenticating.swap(true,Ordering::SeqCst){return Err("Authentication is already in progress".into());}state.cancel_auth.store(false,Ordering::SeqCst);state.auth_error.lock().unwrap().clear();let _=app.emit("auth-state",json!({"state":"authenticating","message":"Complete sign-in in any browser."}));
	let root=state.root.clone();let worker=app.clone();let result=match tauri::async_runtime::spawn_blocking(move||Sync::new(root.clone(),root.join("snippets")).and_then(|sync|sync.connect_cancellable(&url,true,true,&worker.state::<Runtime>().cancel_auth)).map_err(|error|error.to_string())).await{Ok(result)=>result,Err(error)=>Err(error.to_string())};
	let state=app.state::<Runtime>();state.authenticating.store(false,Ordering::SeqCst);let connected=state.root.join("sync/credentials.json").exists();if let Err(error)=&result{*state.auth_error.lock().unwrap()=error.clone();}let _=app.emit("auth-state",json!({"state":if connected{"connected"}else{"disconnected"},"message":result.as_ref().map(|_|"Connected").unwrap_or_else(|error|error.as_str())}));result
}
#[tauri::command]
fn cancel_connect(app:tauri::AppHandle){app.state::<Runtime>().cancel_auth.store(true,Ordering::SeqCst);}
#[tauri::command]
async fn disconnect(app:tauri::AppHandle)->std::result::Result<(),String> {
	app.state::<Runtime>().cancel_auth.store(true,Ordering::SeqCst);let root=app.state::<Runtime>().root.clone();
	tauri::async_runtime::spawn_blocking(move||{let waiting=std::time::Instant::now();loop{let result=Sync::new(root.clone(),root.join("snippets")).and_then(|sync|sync.disconnect());match result{Err(error)if error.to_string().contains("Sync already running")&&waiting.elapsed()<std::time::Duration::from_secs(3)=>std::thread::sleep(std::time::Duration::from_millis(100)),outcome=>return outcome.map_err(|error|error.to_string())}}}).await.map_err(|error|error.to_string())?
}
#[tauri::command]
async fn libraries(app:tauri::AppHandle)->std::result::Result<Value,String>{
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move ||Panel::libraries(&directory).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn merge_destinations(app:tauri::AppHandle,source:String)->std::result::Result<Value,String>{let directory=app.state::<Runtime>().root.join("snippets");tauri::async_runtime::spawn_blocking(move||Panel::merge_destinations(&directory,&source).map_err(|error|error.to_string())).await.map_err(|error|error.to_string())?}
#[tauri::command]
async fn merge_library(app:tauri::AppHandle,source:String,destination:String)->std::result::Result<Value,String>{let root=app.state::<Runtime>().root.clone();tauri::async_runtime::spawn_blocking(move||{let db=Database::open(&root.join("snippets")).map_err(|error|error.to_string())?;let queued=db.merge(&source,&destination).map_err(|error|error.to_string())?;if !queued{return Ok(json!({"queued":false}));}let sync=Sync::new(root.clone(),root.join("snippets")).map_err(|error|error.to_string())?;let waiting=std::time::Instant::now();let outcome=loop{match sync.cycle(){Err(error)if error.to_string().contains("Sync already running")&&waiting.elapsed()<std::time::Duration::from_secs(30)=>std::thread::sleep(std::time::Duration::from_millis(250)),result=>break result,}};if outcome.is_err(){let _=Sync::trigger(&root);return Ok(json!({"queued":true}));}let db=Database::open(&root.join("snippets")).map_err(|error|error.to_string())?;if db.pending_merge(&source).map_err(|error|error.to_string())?{Ok(json!({"queued":true}))}else if db.library(&source).map_err(|error|error.to_string())?["state"]=="trashed"{Ok(json!({"queued":false}))}else{Err(db.meta("last_failure").ok().flatten().and_then(|value|value.as_str().map(str::to_owned)).filter(|value|!value.is_empty()).unwrap_or_else(||"Library merge did not complete".into()))}}).await.map_err(|error|error.to_string())?}
#[tauri::command]
async fn conflicts(app:tauri::AppHandle)->std::result::Result<Value,String>{let directory=app.state::<Runtime>().root.join("snippets");tauri::async_runtime::spawn_blocking(move||Panel::conflicts(&directory).map_err(|error|error.to_string())).await.map_err(|error|error.to_string())?}
#[tauri::command]
async fn resolve_conflict(app:tauri::AppHandle,id:String,choice:String,value:Option<Value>)->std::result::Result<(),String>{let root=app.state::<Runtime>().root.clone();tauri::async_runtime::spawn_blocking(move||Sync::new(root.clone(),root.join("snippets")).and_then(|sync|sync.resolve_conflict(&id,&choice,value)).map_err(|error|error.to_string())).await.map_err(|error|error.to_string())?}
#[tauri::command]
async fn enroll(app:tauri::AppHandle,names:Vec<String>)->std::result::Result<(),String>{let root=app.state::<Runtime>().root.clone();tauri::async_runtime::spawn_blocking(move||->Result<()>{let sync=Sync::new(root.clone(),root.join("snippets"))?;for name in names{sync.enroll(&name)?;}Ok(())}).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())}
#[tauri::command]
fn open_accessibility_settings()->std::result::Result<(),String>{platform::open_accessibility_settings().map_err(|e|e.to_string())}
#[tauri::command]
fn open_input_monitoring_settings()->std::result::Result<(),String>{platform::open_input_monitoring_settings().map_err(|e|e.to_string())}
#[tauri::command]
fn open_notification_settings()->std::result::Result<(),String>{#[cfg(target_os="macos")] {platform::NativeNotifications::open_settings().map_err(|e|e.to_string())} #[cfg(not(target_os="macos"))] {Err("Notification settings are available on macOS".into())}}
#[tauri::command]
fn open_tui()->std::result::Result<(),String>{platform::open_tui().map_err(|e|e.to_string())}
#[tauri::command]
fn open_web_app(url:Option<String>)->std::result::Result<(),String>{platform::open_web_app(url.as_deref()).map_err(|e|e.to_string())}
fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.get(1).is_some_and(|value| value.starts_with("chrome-extension://")) { if let Err(error) = browser_bridge::BrowserBridge::serve() { eprintln!("TypeRelay browser bridge: {error:#}"); } return; }
    if arguments.get(1).is_some_and(|value| value == "--register-chrome-extension") { let result = arguments.get(2).context("Chrome extension ID required").and_then(|id| browser_bridge::BrowserBridge::register(id)); if let Err(error) = result { eprintln!("TypeRelay browser registration: {error:#}"); std::process::exit(1); } return; }
    if std::env::args().any(|a|a=="--version"){println!("typerelay-panel {}",env!("TYPERELAY_VERSION"));return;}
	if Runtime::receive_callback(&arguments){return;}
    #[cfg(target_os="macos")]
    if std::env::args().any(|a|a=="--accessibility-status"){println!("{}",if platform::accessibility(false){"allowed"}else{"required"});return;}
    #[cfg(target_os="macos")]
    if std::env::args().any(|a|a=="--input-monitoring-status"){println!("{}",if platform::input_monitoring(false){"allowed"}else{"required"});return;}
    #[cfg(target_os="macos")]
    if std::env::args().any(|a|a=="--repair-input"){if let Err(error)=platform::release_modifiers(){eprintln!("TypeRelay input repair failed: {error}");std::process::exit(1);}return;}
    #[cfg(target_os="linux")]
    if std::env::args().any(|a|a=="--quit") {if let Ok(root)=typerelay_client::panel_ipc::PanelIpc::directory()&& let Ok(socket)=std::os::unix::net::UnixDatagram::unbound(){let _=socket.send_to(b"quit",root.join("events.sock"));}return;}

    #[cfg(target_os="linux")]
    if std::env::args().any(|a|a=="clipboard-serve") {let _=typerelay_client::clipboard::PasteJob::serve_restored();return;}
	let builder=tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,args,_|{let callback=Runtime::receive_callback(&args);if args.iter().any(|arg|arg=="--uninstall"){let _=app.autolaunch().disable();Runtime::quit(app);}else if args.iter().any(|arg|arg=="--quit"){Runtime::quit(app);}else if !callback&&!args.iter().any(|arg|arg=="--background"){Runtime::open(app,false);}})).plugin(tauri_plugin_deep_link::init()).plugin(tauri_plugin_autostart::Builder::new().args(["--background"]).build()).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os="linux"))]
    let builder=builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    let result=builder.setup(|app| {
        browser_bridge::BrowserBridge::refresh_registration();
        #[cfg(target_os="macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        let root=Paths::config_dir()?; Database::open(&root.join("snippets"))?;
        {use tauri_plugin_deep_link::DeepLinkExt;#[cfg(target_os="linux")]app.deep_link().register_all()?;let callback_root=root.clone();app.deep_link().on_open_url(move|event|for url in event.urls(){let _=Sync::receive_callback(&callback_root,url.as_str());});if let Some(urls)=app.deep_link().get_current()?{for url in urls{let _=Sync::receive_callback(&root,url.as_str());}}}
        Sync::worker(root.clone(),root.join("snippets"));
        let config=Panel::settings(&root)?;
		app.manage(Runtime{root:root.clone(),target:Mutex::new(None),last:Mutex::new(None),erase:Mutex::new(0),busy:AtomicBool::new(false),syncing:AtomicBool::new(false),authenticating:AtomicBool::new(false),cancel_auth:AtomicBool::new(false),auth_error:Mutex::new(String::new()),prompting:AtomicBool::new(false),prompt_hit:Mutex::new(None),settings:AtomicBool::new(false),status:Mutex::new(String::new()),#[cfg(any(target_os="windows",target_os="macos"))] expansion_started:AtomicBool::new(false),#[cfg(target_os="linux")] registration:Mutex::new(None)});
		app.manage(update::UpdateState::default());
		#[cfg(target_os="macos")]
		let missing_permissions={let (accessibility,input_monitoring)=Runtime::permissions();app.state::<Runtime>().update_permission_status(accessibility,input_monitoring);if accessibility&&input_monitoring&&let Err(error)=Runtime::start_expansion(app.handle()){*app.state::<Runtime>().status.lock().unwrap()=format!("TypeRelay could not start Input Monitoring: {error:#}");}!(accessibility&&input_monitoring)};
        #[cfg(target_os="windows")]
        Runtime::start_expansion(app.handle())?;
        #[cfg(target_os="linux")]
        {let _=std::fs::remove_file(typerelay_client::panel_ipc::PanelIpc::directory()?.join("ready"));}
        if std::env::args().any(|arg|arg=="--quit"||arg=="--uninstall") {if std::env::args().any(|arg|arg=="--uninstall"){app.autolaunch().disable()?;}app.handle().exit(0);return Ok(());}
        if let Err(error)=Runtime::shortcut(app.handle(),None,&config.shortcut){*app.state::<Runtime>().status.lock().unwrap()=error.to_string();}
        if config.launch_at_login && let Err(error)=app.autolaunch().enable(){*app.state::<Runtime>().status.lock().unwrap()=format!("Could not enable launch at login: {error}");}
		if let Err(error)=tray::install(app.handle()){*app.state::<Runtime>().status.lock().unwrap()=format!("Tray unavailable: {error}. Use the shortcut or launcher.");}
		update::schedule(app.handle().clone());
        let handle=app.handle().clone();
        std::thread::spawn(move||loop { if let Some(window)=handle.get_webview_window("panel")&& !window.is_visible().unwrap_or(false)&& let Ok(target)=platform::Target::capture(){*handle.state::<Runtime>().last.lock().unwrap()=Some(target);} std::thread::sleep(std::time::Duration::from_millis(150)); });
        #[cfg(target_os="linux")]
        {
            app.manage(typerelay_client::panel_ipc::PanelIpc::register()?);
            let path=typerelay_client::panel_ipc::PanelIpc::directory()?.join("events.sock");let _=std::fs::remove_file(&path);
            let socket=std::os::unix::net::UnixDatagram::bind(path)?;let handle=app.handle().clone();
            std::thread::spawn(move||{let mut bytes=[0;16384];loop{if let Ok(length)=socket.recv(&mut bytes){
                if let Ok(prompt)=serde_json::from_slice::<typerelay_client::panel_ipc::Prompt>(&bytes[..length]) {
                    let prepared=(||->Result<_>{ anyhow::ensure!(!handle.state::<Runtime>().prompting.load(Ordering::SeqCst)&&!handle.state::<Runtime>().busy.load(Ordering::SeqCst),"Finish or cancel the current template first"); let target=platform::Target::capture()?;anyhow::ensure!(target.address==prompt.target,"Original window changed");typerelay_client::panel_ipc::PanelIpc::insert(typerelay_client::panel_ipc::Request{clock:None,generation:Some(prompt.generation),hit:prompt.hit.clone(),target:prompt.target.clone(),created_ms:prompt.created_ms,values:Default::default(),erase:prompt.erase,prepare:true})?;anyhow::ensure!(target.focused()?,"Original window changed");Ok(target) })();
                    let app=handle.clone();let _=handle.run_on_main_thread(move||match prepared { Ok(target)=>{let state=app.state::<Runtime>();*state.target.lock().unwrap()=Some(target);*state.prompt_hit.lock().unwrap()=Some(prompt.hit);Runtime::open(&app,false);state.prompting.store(true,Ordering::SeqCst);},Err(error)=>{let _=app.emit("panel-error",error.to_string());} });
                } else {let quit=&bytes[..length]==b"quit";let app=handle.clone();let _=handle.run_on_main_thread(move||if quit{Runtime::quit(&app);}else{Runtime::open(&app,false);});}
            }}});
        }
        if !std::env::args().any(|a|a=="--background"){
            #[cfg(target_os="macos")]
            Runtime::open(app.handle(),missing_permissions);
            #[cfg(not(target_os="macos"))]
            Runtime::open(app.handle(),false);
        }
        Ok(())
    }).on_window_event(|window,event|match event {
        tauri::WindowEvent::CloseRequested{api,..}=>{api.prevent_close();set_prompt_view(window.app_handle().clone(),false);Runtime::hide(window.app_handle());},
        tauri::WindowEvent::Focused(false)if Runtime::hide_on_focus_loss() && !window.app_handle().state::<Runtime>().busy.load(Ordering::SeqCst) && !window.app_handle().state::<Runtime>().settings.load(Ordering::SeqCst) && !window.app_handle().state::<Runtime>().prompting.load(Ordering::SeqCst)=> {Runtime::hide(window.app_handle());},_=>()
    }).invoke_handler(tauri::generate_handler![initialize,search,personal_status,personal_abbreviation,insert,copy_snippet,prepare_template,set_prompt_view,set_settings_view,dismiss,notify,sync_now,save_settings,connect,cancel_connect,disconnect,libraries,merge_destinations,merge_library,conflicts,resolve_conflict,enroll,open_accessibility_settings,open_input_monitoring_settings,open_notification_settings,open_tui,open_web_app]).run(tauri::generate_context!());
    if let Err(error)=result {eprintln!("TypeRelay panel: {error}");std::process::exit(1);}
}

#[cfg(all(test,target_os="linux"))]
mod tests {
    use super::*;
    #[test]
    fn search_panel_ignores_compositor_focus_loss() { assert!(!Runtime::hide_on_focus_loss()); }
	#[test]
	fn desktop_callback_is_selected_from_instance_arguments(){let args=vec!["typerelay-panel".into(),"typerelay://oauth/callback?code=one&state=two".into()];assert_eq!(Runtime::callback_argument(&args),Some("typerelay://oauth/callback?code=one&state=two"));}
}
