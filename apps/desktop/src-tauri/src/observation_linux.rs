//! Observe direct AT-SPI keys in focused editable controls without reading document text.
use std::{ffi::{c_char,c_void,CStr,CString},sync::Arc,time::{Duration,Instant}};
use anyhow::{Result,ensure};
use typerelay_client::observation::{Edit,Event};
use crate::observation::Observation;
type Object=*mut c_void;
#[repr(C)]
struct Value { kind:usize, data:[u64;2] }
#[repr(C)]
struct AccessibleEvent { kind:*const c_char,source:Object,detail1:i32,detail2:i32,data:Value,sender:Object }
#[repr(C)]
struct KeyEvent { kind:i32,id:u32,hardware:u16,modifiers:u16,timestamp:u32,text:*const c_char,is_text:i32 }
impl KeyEvent {
    unsafe fn edit(&self)->Option<Edit> {unsafe{
        if self.kind!=0||[0xffe1,0xffe2,0xffe5].contains(&self.id){return None;}
        if self.modifiers&!(1|2)!=0{return Some(Edit::Reset);}
        Some(match self.id {
            0xff0d|0xff8d=>Edit::Enter,
            0xff08=>Edit::Backspace,
            _=>{
                if self.is_text==0||self.text.is_null(){return Some(Edit::Reset);}
                let text=CStr::from_ptr(self.text).to_string_lossy().into_owned();
                if text.is_empty()||text.chars().count()>16{Edit::Reset}else{Edit::Text(text)}
            },
        })
    }}
}
struct Api { library:libloading::Library }
impl Api {
    unsafe fn symbol<T:Copy>(&self,name:&[u8])->T {unsafe{*self.library.get::<T>(name).expect("validated AT-SPI symbol")}}
    fn load()->Result<Self> {unsafe{let api=Self{library:libloading::Library::new("libatspi.so.0")?};for name in ["atspi_init","atspi_event_listener_new","atspi_event_listener_register","atspi_event_listener_deregister","atspi_deregister_keystroke_listener","atspi_device_listener_new","atspi_register_keystroke_listener","atspi_accessible_get_role","atspi_accessible_get_state_set","atspi_state_set_contains","atspi_accessible_get_process_id","atspi_accessible_get_text_iface","atspi_text_get_n_selections","atspi_event_get_type","g_boxed_free","g_object_unref","g_object_ref","g_value_get_string","g_main_context_iteration","g_main_context_new","atspi_set_main_context"]{api.library.get::<unsafe extern "C" fn()>(name.as_bytes())?;}Ok(api)}}
    unsafe fn unref(&self,object:Object) {if !object.is_null(){unsafe{self.symbol::<unsafe extern "C" fn(Object)>(b"g_object_unref")(object);}}}
    unsafe fn process(&self,source:Object)->u32 {unsafe{self.symbol::<unsafe extern "C" fn(Object,*mut Object)->u32>(b"atspi_accessible_get_process_id")(source,std::ptr::null_mut())}}
    unsafe fn safe(&self,source:Object)->Option<String> {unsafe{
        if source.is_null(){return None;}
        let role=self.symbol::<unsafe extern "C" fn(Object,*mut Object)->i32>(b"atspi_accessible_get_role")(source,std::ptr::null_mut());if ![61,79].contains(&role){return None;}
        let states=self.symbol::<unsafe extern "C" fn(Object)->Object>(b"atspi_accessible_get_state_set")(source);if states.is_null(){return None;}
        let contains=self.symbol::<unsafe extern "C" fn(Object,i32)->i32>(b"atspi_state_set_contains");let safe=[7,8,12,24].into_iter().all(|flag|contains(states,flag)!=0);self.unref(states);if !safe{return None;}
        let text=self.symbol::<unsafe extern "C" fn(Object)->Object>(b"atspi_accessible_get_text_iface")(source);if text.is_null(){return None;}
        let selections=self.symbol::<unsafe extern "C" fn(Object,*mut Object)->i32>(b"atspi_text_get_n_selections")(text,std::ptr::null_mut());self.unref(text);if selections!=0{return None;}
        let pid=self.process(source);if pid==0||pid==std::process::id(){return None;}
        let path=std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;let app=path.file_name()?.to_string_lossy().into_owned();typerelay_client::observation::Settings::supported_app(&app).then_some(app)
    }}
}
struct Listener { event_listener:Object,key_listener:Object,registered:Vec<CString>,modifiers:Vec<u32>,unlocked:Arc<std::sync::atomic::AtomicBool>,api:Api,state:Arc<Observation>,field:Object,key:Option<Instant>,epoch:u64,caret:Option<i32> }
impl Drop for Listener {
    fn drop(&mut self) {unsafe {
        for kind in &self.registered {self.api.symbol::<unsafe extern "C" fn(Object,*const c_char,*mut Object)->i32>(b"atspi_event_listener_deregister")(self.event_listener,kind.as_ptr(),std::ptr::null_mut());}
        for mask in &self.modifiers {self.api.symbol::<unsafe extern "C" fn(Object,Object,u32,u32,*mut Object)->i32>(b"atspi_deregister_keystroke_listener")(self.key_listener,std::ptr::null_mut(),*mask,1,std::ptr::null_mut());}
        self.api.unref(self.event_listener);self.api.unref(self.key_listener);self.api.unref(self.field);
    }}
}
impl Listener {
    fn typing(&self)->bool {self.key.is_some_and(|at|at.elapsed()<Duration::from_millis(400))}
    fn discard(&mut self){self.key=None;self.caret=None;self.state.reset();}
    fn reset(&mut self){self.discard();unsafe{self.api.unref(self.field);}self.field=std::ptr::null_mut();self.state.reset();}
    unsafe extern "C" fn key(raw:*const KeyEvent,data:Object)->i32 {unsafe{
        let this=&mut *(data as *mut Self);let key=&*raw;
        if !this.state.enabled.load(std::sync::atomic::Ordering::SeqCst)||!this.unlocked.load(std::sync::atomic::Ordering::SeqCst){return 0;}
        let Some(app)=this.api.safe(this.field)else{this.discard();return 0;};
        let epoch=this.state.epoch.load(std::sync::atomic::Ordering::SeqCst);if epoch!=this.epoch{this.reset();this.epoch=epoch;return 0;}
        let Some(edit)=key.edit()else{return 0;};
        this.key=Some(Instant::now());this.state.safety(true);
        this.state.feed(Event{epoch,field:format!("{:p}",this.field),app,safe:true,direct:true,edit});this.state.status("Active");0
    }}
    unsafe extern "C" fn event(raw:*const AccessibleEvent,data:Object) {unsafe{
        let this=&mut *(data as *mut Self);let event=&*raw;
        this.handle(event);
        let kind=this.api.symbol::<unsafe extern "C" fn()->usize>(b"atspi_event_get_type")();this.api.symbol::<unsafe extern "C" fn(usize,Object)>(b"g_boxed_free")(kind,raw as Object);
    }}
    unsafe fn handle(&mut self,event:&AccessibleEvent) {unsafe{
        if !self.state.enabled.load(std::sync::atomic::Ordering::SeqCst)||!self.unlocked.load(std::sync::atomic::Ordering::SeqCst){self.reset();return;}
        let epoch=self.state.epoch.load(std::sync::atomic::Ordering::SeqCst);if epoch!=self.epoch{self.reset();self.epoch=epoch;}
        let kind=CStr::from_ptr(event.kind).to_string_lossy();
        if kind.starts_with("object:state-changed:focused") {
            if event.detail1==0{if event.source==self.field{self.reset();self.state.status("Waiting for a supported editable field");}return;}
            self.reset();if self.api.safe(event.source).is_some(){self.field=self.api.symbol::<unsafe extern "C" fn(Object)->Object>(b"g_object_ref")(event.source);self.state.status("Ready to observe typing");}return;
        }
        if kind.starts_with("window:"){if !self.field.is_null()&&self.api.process(event.source)==self.api.process(self.field){self.reset();}return;}
        if event.source!=self.field||self.field.is_null(){return;}
        if self.api.safe(event.source).is_none(){self.discard();return;}
        // Editable controls often emit selection/caret and full text replacement
        // events for each key (notably Electron). Direct keys are the source;
        // accessibility updates must not replay document contents or erase a burst.
        if kind.starts_with("object:text-selection-changed"){return;}
        if kind.starts_with("object:text-caret-moved") {
            if self.caret!=Some(event.detail1)&&!self.typing(){self.state.reset();}self.caret=Some(event.detail1);return;
        }
        if kind.starts_with("object:text-changed:") {
            if !self.typing(){self.discard();self.state.status("Waiting for direct keyboard input from this application");}return;
        }
        self.discard();
    }}
}
pub struct ObservationAdapter;
impl ObservationAdapter {
    fn watch_session(unlocked:Arc<std::sync::atomic::AtomicBool>) {
        loop {
            let result=(||->Result<()>{
                let bus=zbus::blocking::connection::Builder::system()?.method_timeout(Duration::from_millis(300)).build()?;
                let reply=match bus.call_method(Some("org.freedesktop.login1"),"/org/freedesktop/login1",Some("org.freedesktop.login1.Manager"),"GetSessionByPID",&(std::process::id(),)) {
                    Ok(reply)=>reply,
                    Err(error)=>{let Some(session)=std::env::var_os("XDG_SESSION_ID")else{return Err(error.into());};bus.call_method(Some("org.freedesktop.login1"),"/org/freedesktop/login1",Some("org.freedesktop.login1.Manager"),"GetSession",&(session.to_string_lossy().as_ref(),))?}
                };
                let path:zbus::zvariant::OwnedObjectPath=reply.body().deserialize()?;
                loop {
                    let reply=bus.call_method(Some("org.freedesktop.login1"),path.as_str(),Some("org.freedesktop.DBus.Properties"),"GetAll",&("org.freedesktop.login1.Session",))?;
                    let properties:std::collections::HashMap<String,zbus::zvariant::OwnedValue>=reply.body().deserialize()?;
                    let safe=properties.get("Active").and_then(|v|bool::try_from(v).ok())==Some(true)&&properties.get("LockedHint").and_then(|v|bool::try_from(v).ok())==Some(false);
                    unlocked.store(safe,std::sync::atomic::Ordering::SeqCst);std::thread::sleep(Duration::from_millis(200));
                }
            })();
            if result.is_err(){unlocked.store(false,std::sync::atomic::Ordering::SeqCst);std::thread::sleep(Duration::from_secs(2));}
        }
    }

    pub fn start(state:Arc<Observation>) {std::thread::spawn(move||{let result=Self::run(state.clone());if result.is_err(){state.reset();state.status("Unavailable: enable desktop accessibility and install AT-SPI 2, then restart Typerelay");}});}
    fn run(state:Arc<Observation>)->Result<()> {unsafe{
        let api=Api::load()?;let context=api.symbol::<unsafe extern "C" fn()->Object>(b"g_main_context_new")();api.symbol::<unsafe extern "C" fn(Object)>(b"atspi_set_main_context")(context);ensure!(api.symbol::<unsafe extern "C" fn()->i32>(b"atspi_init")()==0,"AT-SPI unavailable");
        let unlocked=Arc::new(std::sync::atomic::AtomicBool::new(false));let session=unlocked.clone();std::thread::spawn(move||Self::watch_session(session));
        let mut listener=Box::new(Listener{event_listener:std::ptr::null_mut(),key_listener:std::ptr::null_mut(),registered:vec![],modifiers:vec![],unlocked,api,state,field:std::ptr::null_mut(),key:None,epoch:0,caret:None});let pointer=(&mut *listener as *mut Listener).cast();
        let events=listener.api.symbol::<unsafe extern "C" fn(unsafe extern "C" fn(*const AccessibleEvent,Object),Object,Object)->Object>(b"atspi_event_listener_new")(Listener::event,pointer,std::ptr::null_mut());listener.event_listener=events;ensure!(!events.is_null(),"AT-SPI listener unavailable");
        for kind in [c"object:state-changed:focused",c"object:text-changed",c"object:text-selection-changed",c"object:text-caret-moved",c"window:deactivate"] {ensure!(listener.api.symbol::<unsafe extern "C" fn(Object,*const c_char,*mut Object)->i32>(b"atspi_event_listener_register")(events,kind.as_ptr(),std::ptr::null_mut())!=0,"AT-SPI registration failed");listener.registered.push(kind.to_owned());}
        let keys=listener.api.symbol::<unsafe extern "C" fn(unsafe extern "C" fn(*const KeyEvent,Object)->i32,Object,Object)->Object>(b"atspi_device_listener_new")(Listener::key,pointer,std::ptr::null_mut());listener.key_listener=keys;ensure!(!keys.is_null(),"AT-SPI keyboard listener unavailable");
        for modifiers in [0,1,2,3,4,8,64] {ensure!(listener.api.symbol::<unsafe extern "C" fn(Object,Object,u32,u32,u32,*mut Object)->i32>(b"atspi_register_keystroke_listener")(keys,std::ptr::null_mut(),modifiers,1,0,std::ptr::null_mut())!=0,"AT-SPI key provenance unavailable");listener.modifiers.push(modifiers);}
        listener.state.status("Waiting for a supported editable field");
        loop {
            while listener.api.symbol::<unsafe extern "C" fn(Object,i32)->i32>(b"g_main_context_iteration")(context,0)!=0{}
            let unlocked=listener.unlocked.load(std::sync::atomic::Ordering::SeqCst);let safe=unlocked&&listener.api.safe(listener.field).is_some();listener.state.safety(safe);
            if !unlocked{listener.state.status("Session locked or session safety unavailable");}
            if !listener.state.enabled.load(std::sync::atomic::Ordering::SeqCst)||listener.epoch!=listener.state.epoch.load(std::sync::atomic::Ordering::SeqCst)||!unlocked{listener.reset();}else if !safe{listener.discard();}
            std::thread::sleep(Duration::from_millis(20));
        }
    }}
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_keys_complete_repeated_sentences_without_text_change_payloads() {
        use typerelay_client::observation::{Detector,Settings};
        let settings=Settings{enabled:true,..Settings::default()};let mut detector=Detector::default();let mut completed=vec![];
        let mut send=|key:KeyEvent|{if let Some(edit)=unsafe{key.edit()}&&let Some(text)=detector.event(Event{epoch:1,field:"editor".into(),app:"code".into(),safe:true,direct:true,edit},&settings,1,1000){completed.push(text);}};
        for _ in 0..2 {
            for c in "Please send the purple notebook tomorrow.".chars() {
                // Shift and releases must not clear a sentence or duplicate a key.
                send(KeyEvent{kind:0,id:0xffe1,hardware:50,modifiers:0,timestamp:0,text:std::ptr::null(),is_text:0});
                let text=CString::new(c.to_string()).unwrap();
                send(KeyEvent{kind:0,id:c as u32,hardware:0,modifiers:if c.is_uppercase(){1}else{0},timestamp:0,text:text.as_ptr(),is_text:1});
                send(KeyEvent{kind:1,id:c as u32,hardware:0,modifiers:0,timestamp:0,text:text.as_ptr(),is_text:1});
            }
            send(KeyEvent{kind:0,id:0xff0d,hardware:36,modifiers:0,timestamp:0,text:std::ptr::null(),is_text:0});
        }
        assert_eq!(completed,vec!["Please send the purple notebook tomorrow.";2]);
        let shortcut=KeyEvent{kind:0,id:'v' as u32,hardware:0,modifiers:4,timestamp:0,text:c"v".as_ptr(),is_text:1};assert!(matches!(unsafe{shortcut.edit()},Some(Edit::Reset)));
    }
    #[test]
    fn atspi_abi_and_runtime_symbols_are_available() {
        assert_eq!(std::mem::size_of::<AccessibleEvent>(),56);
        assert_eq!(std::mem::size_of::<KeyEvent>(),32);
        Api::load().expect("Install the packaged AT-SPI runtime dependency");
    }
}
