use anyhow::Result;
use tauri::Manager;
use crate::Runtime;
pub(crate) struct Tray(#[cfg(target_os="linux")] tauri::AppHandle);
#[cfg(target_os="linux")]
impl ksni::Tray for Tray {
    fn id(&self)->String{"typerelay-panel".into()}
    fn title(&self)->String{"TypeRelay".into()}
    fn icon_pixmap(&self)->Vec<ksni::Icon>{let image=tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).expect("bundled icon");let mut data=image.rgba().to_vec();for pixel in data.as_chunks_mut::<4>().0{pixel.rotate_right(1);}vec![ksni::Icon{width:image.width() as i32,height:image.height() as i32,data}]}
    fn activate(&mut self,_:i32,_:i32){let app=self.0.clone();let _=self.0.run_on_main_thread(move||Runtime::open(&app,false));}
	fn menu(&self)->Vec<ksni::MenuItem<Self>>{use ksni::{menu::StandardItem,MenuItem};vec![StandardItem{label:"Sync now".into(),activate:Box::new(|tray:&mut Self|{let _=crate::sync_now(tray.0.clone());}),..Default::default()}.into(),StandardItem{label:"Settings".into(),activate:Box::new(|tray:&mut Self|{let app=tray.0.clone();let _=tray.0.run_on_main_thread(move||Runtime::open(&app,true));}),..Default::default()}.into(),MenuItem::Separator,StandardItem{label:self.0.state::<crate::update::UpdateState>().menu().0.into(),enabled:self.0.state::<crate::update::UpdateState>().menu().1,activate:Box::new(|tray:&mut Self|crate::update::check(tray.0.clone(),true)),..Default::default()}.into(),StandardItem{label:"Quit".into(),activate:Box::new(|tray:&mut Self|Runtime::quit(&tray.0)),..Default::default()}.into()]}
}
pub fn install(app:&tauri::AppHandle)->Result<()> {
    #[cfg(target_os="linux")]
    {use ksni::blocking::TrayMethods;let handle=Tray(app.clone()).assume_sni_available(true).spawn()?;app.manage(handle);}
    #[cfg(not(target_os="linux"))]
    {
		use tauri::{menu::{MenuBuilder,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
		let sync=MenuItem::with_id(app,"sync","Sync now",true,None::<&str>)?;let settings=MenuItem::with_id(app,"settings","Settings",true,None::<&str>)?;let updates=MenuItem::with_id(app,"updates","Check for updates",true,None::<&str>)?;let quit=MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?;
		app.manage(updates.clone());
		let menu=MenuBuilder::new(app).item(&sync).item(&settings).separator().item(&updates).item(&quit).build()?;
        let icon: &[u8]=if cfg!(target_os="macos"){include_bytes!("../icons/tray-template.png")}else{include_bytes!("../icons/icon.png")};
		let tray=TrayIconBuilder::with_id("typerelay").icon(tauri::image::Image::from_bytes(icon)?).icon_as_template(cfg!(target_os="macos")).tooltip("TypeRelay").menu(&menu).show_menu_on_left_click(false).on_menu_event(|app,event|match event.id.as_ref(){"sync"=>{let _=crate::sync_now(app.clone());},"updates"=>crate::update::check(app.clone(),true),"settings"=>Runtime::open(app,true),"quit"=>Runtime::quit(app),_=>()}).on_tray_icon_event(move|tray,event|{if matches!(event,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){Runtime::open(tray.app_handle(),false);}
            #[cfg(target_os="macos")]
            if matches!(event,TrayIconEvent::Click{button:MouseButton::Right,button_state:MouseButtonState::Down,..}) {
                // macOS 27 swallows left clicks while NSStatusItem has a menu attached.
                // Attach only while presenting, matching tray-icon's upstream fix #365.
                if let Err(error)=tray.set_menu(Some(menu.clone())).and_then(|_|tray.with_inner_tray_icon(|inner|{inner.show_menu();if let Some(status)=inner.ns_status_item(){status.setMenu(None);}})){eprintln!("TypeRelay tray menu failed: {error}");}
            }
        }).build(app)?;
        #[cfg(target_os="macos")]
        tray.with_inner_tray_icon(|inner|{inner.set_show_menu_on_right_click(false);if let Some(status)=inner.ns_status_item(){status.setMenu(None);}})?;
        #[cfg(not(target_os="macos"))]
        let _=tray;
    }
    Ok(())
}

// Refresh the existing menu item without replacing the tray or opening a window.
impl Tray {
    pub fn update(app:&tauri::AppHandle) {
        #[cfg(target_os="linux")]
        if let Some(handle)=app.try_state::<ksni::blocking::Handle<Tray>>() { Self::update_linux(handle.inner().clone()); }
        #[cfg(not(target_os="linux"))]
        if let Some(item)=app.try_state::<tauri::menu::MenuItem<tauri::Wry>>() { let (label,enabled)=app.state::<crate::update::UpdateState>().menu(); let _=item.set_text(label); let _=item.set_enabled(enabled); }
    }

    #[cfg(target_os="linux")]
    fn update_linux<T: ksni::Tray + Send + 'static>(handle: ksni::blocking::Handle<T>) -> tauri::async_runtime::JoinHandle<()> {
        // ksni enters its own runtime; neither an async worker nor a tray callback can block here.
        tauri::async_runtime::spawn_blocking(move|| { handle.update(|_|{}); })
    }
}

#[cfg(all(test,target_os="linux"))]
mod tests {
    use super::*;
    use ksni::blocking::TrayMethods;
    use std::sync::{Arc, atomic::{AtomicUsize,Ordering}};

    struct TestTray(Arc<AtomicUsize>);
    impl ksni::Tray for TestTray {
        fn id(&self) -> String { "typerelay-update-test".into() }
        fn title(&self) -> String { self.0.load(Ordering::SeqCst).to_string() }
    }

    #[test]
    #[ignore = "Run with dbus-run-session -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --include-ignored"]
    fn updater_refreshes_linux_tray_from_async_worker() {
        let phase=Arc::new(AtomicUsize::new(0));
        let handle=TestTray(phase.clone()).assume_sni_available(true).spawn().unwrap();
        let result=tauri::async_runtime::block_on(tauri::async_runtime::spawn({ let handle=handle.clone(); async move {
            for value in [1,2,3,0] {
                phase.store(value,Ordering::SeqCst);
                Tray::update_linux(handle.clone()).await?;
                let observed=tauri::async_runtime::spawn_blocking({ let handle=handle.clone(); move||handle.update(|tray|ksni::Tray::title(tray)) }).await?;
                assert_eq!(observed,Some(value.to_string()));
            }
            Ok::<(),tauri::Error>(())
        } }));
        handle.shutdown().wait();
        result.unwrap().unwrap();
    }
}
