#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod platform;
mod tray;
mod update;
use anyhow::{Context,Result};
use serde_json::{json,Value};
use std::{sync::{Mutex,atomic::{AtomicBool,Ordering}},path::PathBuf};
use tauri::{Manager,Emitter};
use typerelay_client::{panel::{Panel,PanelSettings,Hit},editor::Paths,database::Database,sync::Sync};
use tauri_plugin_autostart::ManagerExt as _;
#[cfg(not(target_os="linux"))]
use tauri_plugin_notification::NotificationExt;
#[cfg(not(target_os="linux"))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

struct Runtime { root:PathBuf, target:Mutex<Option<platform::Target>>, last:Mutex<Option<platform::Target>>, erase:Mutex<usize>, busy:AtomicBool, syncing:AtomicBool, prompting:AtomicBool, prompt_hit:Mutex<Option<Hit>>, settings:AtomicBool, status:Mutex<String>, #[cfg(target_os="linux")] registration:Mutex<Option<typerelay_client::desktop::Registration>> }
impl Runtime {
    fn hide_on_focus_loss()->bool { cfg!(not(target_os="linux")) }
    fn sync_notice(app:&tauri::AppHandle,message:&str) {
        *app.state::<Runtime>().status.lock().unwrap()=message.into();
        let _=app.emit("sync-status",message);
        #[cfg(target_os="linux")]
        if let Err(error)=notify_rust::Notification::new().appname("TypeRelay").summary("TypeRelay").body(message).show(){eprintln!("TypeRelay sync notification unavailable: {error}");}
        #[cfg(not(target_os="linux"))]
        if let Err(error)=app.notification().builder().title("TypeRelay").body(message).show(){eprintln!("TypeRelay sync notification unavailable: {error}");}
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
            if target.is_none(){*state.status.lock().unwrap()=captured.err().map(|e|e.to_string()).unwrap_or("Choose an application to insert into".into());}
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
    #[cfg(target_os="windows")]
    fn expand(app:&tauri::AppHandle,request:platform::ExpansionRequest)->Result<()>{
        let platform::ExpansionRequest{target,expansion,released}=request;released.recv_timeout(std::time::Duration::from_secs(2)).context("Release Space before expansion")?;std::thread::sleep(std::time::Duration::from_millis(75));
        if let Some(template)=expansion.template {
            let identity=template.identity.context("Template identity unavailable")?;
            let hit=Hit{id:identity.id,library:identity.library,revision:identity.revision,library_name:String::new(),title:template.abbreviation.clone(),abbreviation:template.abbreviation,preview:String::new()};
            if template.prompted {
                let state=app.state::<Runtime>();if state.busy.load(Ordering::SeqCst)||state.prompting.load(Ordering::SeqCst){platform::paste(&target,0,Some(" ".into()))?;return Ok(());}
                let prompt_app=app.clone();let main_app=prompt_app.clone();prompt_app.run_on_main_thread(move||{let state=main_app.state::<Runtime>();*state.target.lock().unwrap()=Some(target);*state.erase.lock().unwrap()=expansion.erase;*state.prompt_hit.lock().unwrap()=Some(hit);state.prompting.store(true,Ordering::SeqCst);Runtime::open(&main_app,false);})?;return Ok(());
            }
            let rendered=Panel::render(&app.state::<Runtime>().root.join("snippets"),&hit,Default::default(),false)?;let mut erase=expansion.erase;
            for step in rendered.steps {Panel::content(&app.state::<Runtime>().root.join("snippets"),&hit)?;platform::paste(&target,std::mem::take(&mut erase),match step{typerelay_core::template::Step::Text{text}=>Some(text),typerelay_core::template::Step::Enter=>None})?;}
        } else {platform::paste(&target,expansion.erase,Some(expansion.text))?;}
        Ok(())
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
		Ok(json!({"config":settings,"prompt":state.prompt_hit.lock().unwrap().clone(),"server":typerelay_client::settings::SettingsStore::open(state.root.join("settings.yml")).ok().map(|s|s.settings.sync_url).unwrap_or_default(),"theme":Runtime::theme(),"settings":state.settings.load(Ordering::SeqCst),"status":*state.status.lock().unwrap(),"update":app.state::<update::UpdateState>().value(),"accessibility":platform::accessibility(false)}))
}
#[tauri::command]
async fn search(app:tauri::AppHandle,query:String)->std::result::Result<Vec<Hit>,String> {
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move ||Panel::search(&directory,&query).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
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
        let rendered=Panel::render_at(&directory,&hit,values.clone(),false,clock)?;
        target.restore()?;
        #[cfg(target_os="linux")]
        { let _=rendered; typerelay_client::panel_ipc::PanelIpc::insert(typerelay_client::panel_ipc::Request{hit,values,generation:None,clock:Some(clock),erase:0,prepare:false,target:target.address.clone(),created_ms:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis()})?; }
        #[cfg(not(target_os="linux"))]
        { let mut erase=erase;for step in rendered.steps { Panel::content(&directory,&hit)?; platform::paste(&target,std::mem::take(&mut erase),match step { typerelay_core::template::Step::Text{text}=>Some(text),typerelay_core::template::Step::Enter=>None })?; } }
        Ok(())
    }).await.map_err(|e|e.to_string()).and_then(|r|r.map_err(|e|e.to_string()));
    app.state::<Runtime>().busy.store(false,Ordering::SeqCst);
    if result.is_ok(){let state=app.state::<Runtime>();state.status.lock().unwrap().clear();*state.erase.lock().unwrap()=0;state.prompting.store(false,Ordering::SeqCst);state.prompt_hit.lock().unwrap().take();}
    if let Err(error)=&result { *app.state::<Runtime>().status.lock().unwrap()=error.clone(); if let Some(window)=app.get_webview_window("panel"){let _=window.show();let _=window.set_focus();} }
    result
}
#[tauri::command]
async fn copy_snippet(app:tauri::AppHandle,hit:Hit,values:Option<std::collections::BTreeMap<String,String>>)->std::result::Result<(),String> {
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move ||Panel::render(&directory,&hit,values.unwrap_or_default(),false).and_then(|rendered|platform::copy(rendered.text)).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn prepare_template(app:tauri::AppHandle,hit:Hit,values:Option<std::collections::BTreeMap<String,String>>)->std::result::Result<typerelay_core::template::Rendered,String> {
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move||Panel::render(&directory,&hit,values.unwrap_or_default(),true).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn set_prompt_view(app:tauri::AppHandle,enabled:bool){let state=app.state::<Runtime>();state.prompting.store(enabled,Ordering::SeqCst);if !enabled{state.prompt_hit.lock().unwrap().take();*state.erase.lock().unwrap()=0;}}
#[tauri::command]
fn set_settings_view(app:tauri::AppHandle,enabled:bool){app.state::<Runtime>().settings.store(enabled,Ordering::SeqCst);}
#[tauri::command]
fn dismiss(app:tauri::AppHandle){set_prompt_view(app.clone(),false);Runtime::hide(&app);}
#[tauri::command]
fn sync_now(app:tauri::AppHandle)->std::result::Result<(),String>{
    if app.state::<Runtime>().syncing.swap(true,Ordering::SeqCst) {return Ok(());}
    std::thread::spawn(move||{
        Runtime::sync_notice(&app,"Starting to sync…");
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
        Runtime::sync_notice(&app,&message);
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
    let root=app.state::<Runtime>().root.clone();
    tauri::async_runtime::spawn_blocking(move ||Sync::new(root.clone(),root.join("snippets")).and_then(|sync|sync.connect(&url,true)).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn libraries(app:tauri::AppHandle)->std::result::Result<Value,String>{
    let directory=app.state::<Runtime>().root.join("snippets");
    tauri::async_runtime::spawn_blocking(move ||->Result<Value>{let db=Database::open(&directory)?;let mut rows=Vec::new();for library in db.libraries()?{let id=library["_id"].as_str().context("Missing library ID")?;if library["state"]=="active" && !db.synced(id)?{rows.push(json!({"name":library["name"]}));}}Ok(json!(rows))}).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}
#[tauri::command]
async fn enroll(app:tauri::AppHandle,names:Vec<String>)->std::result::Result<(),String>{let root=app.state::<Runtime>().root.clone();tauri::async_runtime::spawn_blocking(move||->Result<()>{let sync=Sync::new(root.clone(),root.join("snippets"))?;for name in names{sync.enroll(&name)?;}Ok(())}).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())}
#[tauri::command]
fn open_accessibility_settings()->std::result::Result<(),String>{platform::open_accessibility_settings().map_err(|e|e.to_string())}
#[tauri::command]
fn open_tui()->std::result::Result<(),String>{platform::open_tui().map_err(|e|e.to_string())}
fn main() {
    if std::env::args().any(|a|a=="--version"){println!("typerelay-panel {}",env!("CARGO_PKG_VERSION"));return;}
    #[cfg(target_os="macos")]
    if std::env::args().any(|a|a=="--accessibility-status"){println!("{}",if platform::accessibility(false){"allowed"}else{"required"});return;}
    #[cfg(target_os="linux")]
    if std::env::args().any(|a|a=="--quit") {if let Ok(root)=typerelay_client::panel_ipc::PanelIpc::directory()&& let Ok(socket)=std::os::unix::net::UnixDatagram::unbound(){let _=socket.send_to(b"quit",root.join("events.sock"));}return;}

    #[cfg(target_os="linux")]
    if std::env::args().any(|a|a=="clipboard-serve") {let _=typerelay_client::clipboard::PasteJob::serve_restored();return;}
	let builder=tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,args,_|{if args.iter().any(|arg|arg=="--uninstall"){let _=app.autolaunch().disable();Runtime::quit(app);}else if args.iter().any(|arg|arg=="--quit"){Runtime::quit(app);}else if !args.iter().any(|arg|arg=="--background"){Runtime::open(app,false);}})).plugin(tauri_plugin_autostart::Builder::new().args(["--background"]).build()).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os="linux"))]
    let builder=builder.plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_global_shortcut::Builder::new().build());
    let result=builder.setup(|app| {
        #[cfg(target_os="macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        let root=Paths::config_dir()?; Database::open(&root.join("snippets"))?;
        Sync::worker(root.clone(),root.join("snippets"));
        let config=Panel::settings(&root)?;
		app.manage(Runtime{root:root.clone(),target:Mutex::new(None),last:Mutex::new(None),erase:Mutex::new(0),busy:AtomicBool::new(false),syncing:AtomicBool::new(false),prompting:AtomicBool::new(false),prompt_hit:Mutex::new(None),settings:AtomicBool::new(false),status:Mutex::new(String::new()),#[cfg(target_os="linux")] registration:Mutex::new(None)});
		app.manage(update::UpdateState::default());
		#[cfg(target_os="macos")]
		if !platform::accessibility(true){*app.state::<Runtime>().status.lock().unwrap()="Allow TypeRelay in System Settings → Privacy & Security → Accessibility".into();}
        #[cfg(target_os="windows")]
        {let requests=platform::ExpansionSession::start(root.join("snippets"),root.join("settings.yml"))?;let handle=app.handle().clone();std::thread::spawn(move||for request in requests{if let Err(error)=Runtime::expand(&handle,request){let message=format!("Expansion failed: {error:#}");*handle.state::<Runtime>().status.lock().unwrap()=message.clone();let _=handle.notification().builder().title("TypeRelay").body(&message).show();}});}
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
        if !std::env::args().any(|a|a=="--background"){Runtime::open(app.handle(),false);}
        Ok(())
    }).on_window_event(|window,event|match event {
        tauri::WindowEvent::CloseRequested{api,..}=>{api.prevent_close();set_prompt_view(window.app_handle().clone(),false);Runtime::hide(window.app_handle());},
        tauri::WindowEvent::Focused(false)if Runtime::hide_on_focus_loss() && !window.app_handle().state::<Runtime>().busy.load(Ordering::SeqCst) && !window.app_handle().state::<Runtime>().settings.load(Ordering::SeqCst) && !window.app_handle().state::<Runtime>().prompting.load(Ordering::SeqCst)=> {Runtime::hide(window.app_handle());},_=>()
    }).invoke_handler(tauri::generate_handler![initialize,search,insert,copy_snippet,prepare_template,set_prompt_view,set_settings_view,dismiss,sync_now,save_settings,connect,libraries,enroll,open_accessibility_settings,open_tui]).run(tauri::generate_context!());
    if let Err(error)=result {eprintln!("TypeRelay panel: {error}");std::process::exit(1);}
}

#[cfg(all(test,target_os="linux"))]
mod tests {
    use super::*;
    #[test]
    fn search_panel_ignores_compositor_focus_loss() { assert!(!Runtime::hide_on_focus_loss()); }
}
