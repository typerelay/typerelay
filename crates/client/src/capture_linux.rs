//! Native capture shares the selected keyboard reader. No second grab or input log.
mod context;
mod helpers;
pub use context::{ContextProvider,Layout};
use anyhow::{Context,Result,ensure};
use crate::{observation::{CaptureFrame,CaptureSource,Edit,Protection},panel_ipc::{PanelIpc,CaptureBody,CaptureControl,CaptureHealth}};
use std::{collections::BTreeSet,os::unix::net::UnixDatagram,sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering},mpsc::{sync_channel,SyncSender}},time::{Duration,Instant}};
use xkbcommon::xkb;

pub struct Translator {state:xkb::State,compose:xkb::compose::State,identity:String,held:BTreeSet<u16>}
impl Translator {
    pub fn new(layout:&Layout)->Result<Self>{
        ensure!(!layout.layout.is_empty()&&[&layout.layout,&layout.variant,&layout.options].iter().all(|s|!s.contains('\0')&&s.len()<=256),"Invalid keyboard layout");
        let context=xkb::Context::new(xkb::CONTEXT_NO_FLAGS);let map=if let Some(text)=&layout.keymap{xkb::Keymap::new_from_string(&context,text.clone(),xkb::KEYMAP_FORMAT_TEXT_V1,xkb::KEYMAP_COMPILE_NO_FLAGS)}else{xkb::Keymap::new_from_names(&context,"evdev","pc105",&layout.layout,&layout.variant,Some(layout.options.clone()),xkb::KEYMAP_COMPILE_NO_FLAGS)}.context("Could not load active keyboard layout")?;
        let group=layout.group.or_else(||layout.active_name.as_ref().and_then(|name|(0..map.num_layouts()).find(|index|map.layout_get_name(*index)==name))).or_else(||(map.num_layouts()==1).then_some(0)).context("Active keyboard layout group unavailable")?;ensure!(group<map.num_layouts(),"Invalid keyboard layout group");
        let mut state=xkb::State::new(&map);let mut locks=0;for(name,active)in [("Lock",layout.caps),("NumLock",layout.num)]{let index=map.mod_get_index(name);if active&&index<xkb::MOD_INVALID&&index<32{locks|=1<<index;}}state.update_mask(0,0,locks,0,0,group);
        let locale=std::env::var_os("LC_ALL").filter(|v|!v.is_empty()).or_else(||std::env::var_os("LC_CTYPE")).or_else(||std::env::var_os("LANG")).unwrap_or_else(||"C.UTF-8".into());let table=xkb::compose::Table::new_from_locale(&context,&locale,xkb::compose::COMPILE_NO_FLAGS).map_err(|_|anyhow::anyhow!("Compose table unavailable for the active locale"))?;
        Ok(Self{state,compose:xkb::compose::State::new(&table,xkb::compose::STATE_NO_FLAGS),identity:layout.identity(),held:BTreeSet::new()})
    }
    pub fn matches(&self,layout:&Layout)->bool{self.identity==layout.identity()}
    pub fn key(&mut self,code:u16,value:i32)->Vec<Edit>{
        let key=xkb::Keycode::new(u32::from(code)+8);if value==0{self.held.remove(&code);self.state.update_key(key,xkb::KeyDirection::Up);return vec![];}
        if value==1{if !self.held.insert(code){return vec![];}self.state.update_key(key,xkb::KeyDirection::Down);}else if value!=2{return vec![Edit::Reset];}
        let sym=self.state.key_get_one_sym(key).raw();
        if [0xffe1,0xffe2,0xffe3,0xffe4,0xffe5,0xffe7,0xffe8,0xffe9,0xffea,0xffeb,0xffec,0xfe03,0xff7f].contains(&sym){return vec![];}
        if self.state.mod_name_is_active("Control",xkb::STATE_MODS_EFFECTIVE)||self.state.mod_name_is_active("Mod1",xkb::STATE_MODS_EFFECTIVE)||self.state.mod_name_is_active("Mod4",xkb::STATE_MODS_EFFECTIVE){self.compose.reset();return vec![Edit::Reset];}
        match sym{0xff0d|0xff8d=>{self.compose.reset();return vec![Edit::Enter];},0xff09=>{self.compose.reset();return vec![Edit::Boundary];},0xff08=>{self.compose.reset();return vec![Edit::Backspace];},0xff1b|0xff50..=0xff58|0xffff=>{self.compose.reset();return vec![Edit::Reset];},_=>{}}
        self.compose.feed(self.state.key_get_one_sym(key));match self.compose.status(){xkb::compose::Status::Composing=>vec![],xkb::compose::Status::Cancelled=>{self.compose.reset();vec![Edit::Reset]},xkb::compose::Status::Composed=>{let text=self.compose.utf8().unwrap_or_default();self.compose.reset();if text.is_empty(){vec![]}else{vec![Edit::Text(text)]}},xkb::compose::Status::Nothing=>{let text=self.state.key_get_utf8(key);if text.is_empty(){vec![Edit::Reset]}else{vec![Edit::Text(text)]}}}
    }
    pub fn wayland_layout()->Result<Layout>{helpers::WaylandMap::read()}
}

enum Physical { Key{code:u16,value:i32,at:Instant,generation:u64},Reset,Pointer }
pub struct CapturePublisher {sender:SyncSender<Physical>,enabled:Arc<AtomicBool>,generation:Arc<AtomicU64>}
impl CapturePublisher {
    pub fn now()->i64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64}
    pub fn start(device:String)->Result<Self>{
        PanelIpc::register_capture_worker()?;let(socket_sender,receiver)=sync_channel(1024);let enabled=Arc::new(AtomicBool::new(false));let generation=Arc::new(AtomicU64::new(1));let active=enabled.clone();let reset=generation.clone();
        std::thread::spawn(move||{
            let socket=match UnixDatagram::unbound(){Ok(socket)=>socket,Err(_)=>return};if socket.set_nonblocking(true).is_err(){return;}
            let cache=Arc::new(Mutex::new(context::ContextCache::default()));let _helper=helpers::ContextService::start(cache.clone());let mut provider=ContextProvider::new(cache.clone()).ok();let mut translator=None::<Translator>;let mut sequence=0u64;let source_id=uuid::Uuid::new_v4().to_string();let mut control=CaptureControl::default();let mut refresh=Instant::now()-Duration::from_secs(1);let mut current=None::<crate::observation::CaptureContext>;let mut seen_generation=reset.load(Ordering::SeqCst);
            loop {
                let event=receiver.recv_timeout(Duration::from_millis(20));if matches!(event,Err(std::sync::mpsc::RecvTimeoutError::Disconnected)){break;}
                if refresh.elapsed()>=Duration::from_millis(100)||matches!(&event,Ok(Physical::Key{value:1|2,..}|Physical::Pointer)){
                    let next=PanelIpc::capture_control().unwrap_or_default();let available=next.version==1&&next.enabled&&next.expires_ms>Self::now();active.store(available,Ordering::SeqCst);if next.session!=control.session{sequence=0;}if next.session!=control.session||!available{translator=None;current=None;reset.fetch_add(1,Ordering::SeqCst);}control=next;
                    if available{
                        if provider.is_none(){provider=ContextProvider::new(cache.clone()).ok();}
                        let result=provider.as_mut().context("Session context unavailable").and_then(|provider|provider.snapshot(&device));
                        let mut health=CaptureHealth{device:device.clone(),desktop:ContextProvider::desktop(),source:"keyboard".into(),at_ms:Self::now(),..Default::default()};
                        match result{Ok((mut context,layout,desktop))=>{
                            if control.protected_app.as_deref()==Some(context.app.as_str()){context.protection=Protection::Protected;}
                            health.desktop=desktop;health.layout=layout.active_name.clone().unwrap_or_else(||layout.layout.clone());health.app=Some(context.app.clone());health.ime=context.ime.clone();
                            if translator.as_ref().is_none_or(|value|!value.matches(&layout)){match Translator::new(&layout){Ok(value)=>{translator=Some(value);reset.fetch_add(1,Ordering::SeqCst);},Err(error)=>{translator=None;health.blocked=Some(error.to_string());}}}
                            if context.authority==CaptureSource::Ime{health.blocked=Some("IME active: verified commit integration is required".into());}
                            if let Some(previous)=&current&&previous.generation!=context.generation{let edit=if previous.layout==context.layout{Edit::Boundary}else{Edit::Reset};sequence+=1;let frame=CaptureFrame{version:1,session:control.session.clone(),source_id:source_id.clone(),sequence,at_ms:Self::now(),context:previous.clone(),source:CaptureSource::Keyboard,edit};let _=PanelIpc::send_capture(&socket,&control.session,CaptureBody::Frame(frame));}
                            if context.protection==Protection::Protected{health.blocked=Some("Learning paused in a protected field".into());}else if !crate::observation::Settings::supported_app(&context.app)||control.excluded_apps.iter().any(|app|app.eq_ignore_ascii_case(&context.app)){health.blocked=Some("Learning paused in this application".into());}
                            if health.blocked.is_some(){context.active=false;}current=Some(context);
                        },Err(error)=>{current=None;translator=None;health.blocked=Some(error.to_string());reset.fetch_add(1,Ordering::SeqCst);}}
                        let _=PanelIpc::send_capture(&socket,&control.session,CaptureBody::Health(health));
                    }
                    refresh=Instant::now();
                }
                if !active.load(Ordering::SeqCst){continue;}
                let Some(context)=current.clone()else{continue;};let current_generation=reset.load(Ordering::SeqCst);
                let mut edits=vec![];if seen_generation!=current_generation{edits.push(Edit::Reset);seen_generation=current_generation;}
                match event{Ok(Physical::Key{code,value,at,generation})if at.elapsed()<Duration::from_millis(250)&&generation==current_generation=>{if let Some(translator)=&mut translator{let translated=translator.key(code,value);if context.active{edits.extend(translated);}else{edits.push(Edit::Reset);}}},Ok(Physical::Key{..}|Physical::Reset|Physical::Pointer)=>edits.push(Edit::Reset),_=>{}}
                for edit in edits{sequence+=1;let frame=CaptureFrame{version:CaptureFrame::VERSION,session:control.session.clone(),source_id:source_id.clone(),sequence,at_ms:Self::now(),context:context.clone(),source:CaptureSource::Keyboard,edit};let _=PanelIpc::send_capture(&socket,&control.session,CaptureBody::Frame(frame));}
            }
        });
        Ok(Self{sender:socket_sender,enabled,generation})
    }
    pub fn key(&self,event:&evdev::InputEvent){if !self.enabled.load(Ordering::SeqCst){return;}if event.event_type()==evdev::EventType::SYNCHRONIZATION&&event.code()==3{self.reset();return;}if event.event_type()!=evdev::EventType::KEY{return;}let value=Physical::Key{code:event.code(),value:event.value(),at:Instant::now(),generation:self.generation.load(Ordering::SeqCst)};if self.sender.try_send(value).is_err(){self.generation.fetch_add(1,Ordering::SeqCst);}}
    pub fn pointer(&self){if self.enabled.load(Ordering::SeqCst)&&self.sender.try_send(Physical::Pointer).is_err(){self.reset();}}
    pub fn reset(&self){self.generation.fetch_add(1,Ordering::SeqCst);let _=self.sender.try_send(Physical::Reset);}
    pub fn observe_only(requested:&str,running:Arc<AtomicBool>)->Result<()> {
        use evdev::Device;let device=if requested=="auto"{crate::installation::Installer::keyboard()?}else{requested.into()};let devices=crate::installation::Installer::devices()?;let choices=crate::installation::Installer::keyboard_devices(&devices);let selected:Vec<_>=choices.iter().filter(|(name,_,_)|name==&device).collect();ensure!(selected.len()==1,"Select an available keyboard in Typerelay settings");let mut keyboard=Device::open(&selected[0].1).context("Allow access to the selected keyboard in Check setup")?;keyboard.set_nonblocking(true)?;let capture=Self::start(device)?;let mut pointers=vec![];for(_,path,props)in &devices{if path!=&selected[0].1&&props.lines().any(|p|["ID_INPUT_MOUSE=1","ID_INPUT_TOUCHPAD=1","ID_INPUT_TOUCHSCREEN=1"].contains(&p)){let pointer=Device::open(path).context("Allow pointer access for safe capture boundaries")?;pointer.set_nonblocking(true)?;pointers.push(pointer);}}
        while running.load(Ordering::SeqCst){for pointer in &mut pointers{if let Ok(events)=pointer.fetch_events()&&events.into_iter().any(|e|e.event_type()==evdev::EventType::KEY&&e.value()==1){capture.pointer();}}match keyboard.fetch_events(){Ok(events)=>for event in events{capture.key(&event);},Err(error)if error.kind()==std::io::ErrorKind::WouldBlock=>{},Err(error)=>return Err(error.into())};std::thread::sleep(Duration::from_millis(2));}Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore="requires an unlocked local desktop session"]
    fn live_context_and_layout_metadata() {
        let mut provider=ContextProvider::new(Arc::new(Mutex::new(context::ContextCache::default()))).unwrap();let device=crate::installation::Installer::keyboard().unwrap();let(context,layout,desktop)=provider.snapshot(&device).unwrap();assert!(context.active);assert!(!context.app.is_empty());assert!(!context.window.is_empty());assert!(Translator::new(&layout).is_ok());println!("Verified context: desktop={desktop}, keyboard={device}, layout={}",layout.layout);
    }
    #[test]
    fn layouts_shift_altgr_dead_keys_and_boundaries_use_xkb() {
        let mut us=Translator::new(&Layout{layout:"us".into(),..Default::default()}).unwrap();assert_eq!(us.key(30,1),vec![Edit::Text("a".into())]);us.key(30,0);us.key(42,1);assert_eq!(us.key(3,1),vec![Edit::Text("@".into())]);us.key(3,0);us.key(42,0);assert_eq!(us.key(15,1),vec![Edit::Boundary]);
        let mut de=Translator::new(&Layout{layout:"de".into(),..Default::default()}).unwrap();de.key(100,1);assert_eq!(de.key(16,1),vec![Edit::Text("@".into())]);
        let mut intl=Translator::new(&Layout{layout:"us".into(),variant:"intl".into(),..Default::default()}).unwrap();assert!(intl.key(40,1).is_empty());intl.key(40,0);assert_eq!(intl.key(18,1),vec![Edit::Text("é".into())]);
    }
    #[test]
    fn slow_or_disconnected_observation_consumer_never_blocks_keyboard_path() {
        let(sender,receiver)=sync_channel(1);let publisher=CapturePublisher{sender,enabled:Arc::new(AtomicBool::new(true)),generation:Arc::new(AtomicU64::new(1))};let event=evdev::InputEvent::new(evdev::EventType::KEY.0,30,1);let at=Instant::now();for _ in 0..10000{publisher.key(&event);}assert!(at.elapsed()<Duration::from_secs(1));assert!(publisher.generation.load(Ordering::SeqCst)>1);drop(receiver);let at=Instant::now();for _ in 0..10000{publisher.key(&event);}assert!(at.elapsed()<Duration::from_secs(1));
    }
}
