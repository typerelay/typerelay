use anyhow::Result;
use tauri::Manager;
use crate::Runtime;
#[cfg(target_os="linux")]
struct Tray(tauri::AppHandle);
#[cfg(target_os="linux")]
impl ksni::Tray for Tray {
    fn id(&self)->String{"typerelay-panel".into()}
    fn title(&self)->String{"TypeRelay".into()}
    fn icon_pixmap(&self)->Vec<ksni::Icon>{let image=tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).expect("bundled icon");let mut data=image.rgba().to_vec();for pixel in data.as_chunks_mut::<4>().0{pixel.rotate_right(1);}vec![ksni::Icon{width:image.width() as i32,height:image.height() as i32,data}]}
    fn activate(&mut self,_:i32,_:i32){let app=self.0.clone();let _=self.0.run_on_main_thread(move||Runtime::open(&app,false));}
	fn menu(&self)->Vec<ksni::MenuItem<Self>>{use ksni::{menu::StandardItem,MenuItem};vec![StandardItem{label:"Sync now".into(),activate:Box::new(|tray:&mut Self|{let _=crate::sync_now(tray.0.clone());}),..Default::default()}.into(),StandardItem{label:"Settings".into(),activate:Box::new(|tray:&mut Self|{let app=tray.0.clone();let _=tray.0.run_on_main_thread(move||Runtime::open(&app,true));}),..Default::default()}.into(),MenuItem::Separator,StandardItem{label:"Check for updates".into(),activate:Box::new(|tray:&mut Self|crate::update::check(tray.0.clone(),true)),..Default::default()}.into(),StandardItem{label:"Quit".into(),activate:Box::new(|tray:&mut Self|Runtime::quit(&tray.0)),..Default::default()}.into()]}
}
pub fn install(app:&tauri::AppHandle)->Result<()> {
    #[cfg(target_os="linux")]
    {use ksni::blocking::TrayMethods;let handle=Tray(app.clone()).assume_sni_available(true).spawn()?;app.manage(handle);}
    #[cfg(not(target_os="linux"))]
    {
		use tauri::{menu::{MenuBuilder,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
		let sync=MenuItem::with_id(app,"sync","Sync now",true,None::<&str>)?;let settings=MenuItem::with_id(app,"settings","Settings",true,None::<&str>)?;let updates=MenuItem::with_id(app,"updates","Check for updates",true,None::<&str>)?;let quit=MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?;
		let menu=MenuBuilder::new(app).item(&sync).item(&settings).separator().item(&updates).item(&quit).build()?;
        let icon: &[u8]=if cfg!(target_os="macos"){include_bytes!("../icons/tray-template.png")}else{include_bytes!("../icons/icon.png")};
		TrayIconBuilder::with_id("typerelay").icon(tauri::image::Image::from_bytes(icon)?).icon_as_template(cfg!(target_os="macos")).tooltip("TypeRelay").menu(&menu).show_menu_on_left_click(false).on_menu_event(|app,event|match event.id.as_ref(){"sync"=>{let _=crate::sync_now(app.clone());},"updates"=>crate::update::check(app.clone(),true),"settings"=>Runtime::open(app,true),"quit"=>Runtime::quit(app),_=>()}).on_tray_icon_event(|tray,event|{if matches!(event,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){Runtime::open(tray.app_handle(),false);}}).build(app)?;
    }
    Ok(())
}
