//! Observe committed AT-SPI edits; keyboard callbacks are optional cancellation hints.
use std::{ffi::{c_char,c_void,CStr,CString},sync::Arc,time::Duration};
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
// Keep replacement payloads only long enough to reduce an editor refresh to
// the newly committed characters. Never query or persist a document snapshot.
#[derive(Default)]
struct TextEdits { deleted:Option<(i32,String,i64)>, cursor:Option<i32>, changed:i64 }
impl TextEdits {
    fn reset(&mut self){*self=Self::default();}
    fn flush(&mut self,now:i64)->Vec<Edit> {
        if self.deleted.as_ref().is_none_or(|(_,_,at)|now-at<75){return vec![];}
        let (offset,text,_)=self.deleted.take().unwrap();self.apply(offset,text.chars().count(),"")
    }
    fn change(&mut self,insert:bool,offset:i32,text:&str,now:i64)->Vec<Edit> {
        let mut edits=self.flush(now);self.changed=now;
        if offset<0||text.chars().count()>4096 {self.reset();return vec![Edit::Reset];}
        if !insert {
            if self.deleted.is_some(){self.reset();edits.push(Edit::Reset);}
            self.deleted=Some((offset,text.into(),now));return edits;
        }
        if let Some((before,old,_))=self.deleted.take() {
            if before==offset {
                let old:Vec<char>=old.chars().collect();let new:Vec<char>=text.chars().collect();
                let prefix=old.iter().zip(&new).take_while(|(a,b)|a==b).count();
                let suffix=old[prefix..].iter().rev().zip(new[prefix..].iter().rev()).take_while(|(a,b)|a==b).count();
                edits.extend(self.apply(offset+prefix as i32,old.len()-prefix-suffix,&new[prefix..new.len()-suffix].iter().collect::<String>()));return edits;
            }
            edits.extend(self.apply(before,old.chars().count(),""));
        }
        edits.extend(self.apply(offset,0,text));edits
    }
    fn apply(&mut self,offset:i32,removed:usize,text:&str)->Vec<Edit> {
        let mut edits=vec![];let length=text.chars().count();
        // Bulk paste, document loading, and large rewrites are never learned.
        if removed>16||length>16 {self.cursor=None;return vec![Edit::Reset];}
        if removed==0&&length==0{return edits;}
        if self.cursor.is_some_and(|cursor|cursor!=offset+removed as i32){edits.push(Edit::Reset);}
        edits.extend((0..removed).map(|_|Edit::Backspace));
        for part in text.split_inclusive('\n') {
            let text=part.trim_end_matches(['\r','\n']);if !text.is_empty(){edits.push(Edit::Text(text.into()));}
            if part.ends_with('\n'){edits.push(Edit::Enter);}
        }
        self.cursor=Some(offset+length as i32);edits
    }
    fn moved(&self,offset:i32,now:i64)->bool {self.cursor.is_some_and(|cursor|cursor!=offset)&&now-self.changed>=400&&self.deleted.is_none()}
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
struct Listener { event_listener:Object,key_listener:Object,registered:Vec<CString>,modifiers:Vec<u32>,unlocked:Arc<std::sync::atomic::AtomicBool>,api:Api,state:Arc<Observation>,field:Object,edits:TextEdits,epoch:u64 }
impl Drop for Listener {
    fn drop(&mut self) {unsafe {
        for kind in &self.registered {self.api.symbol::<unsafe extern "C" fn(Object,*const c_char,*mut Object)->i32>(b"atspi_event_listener_deregister")(self.event_listener,kind.as_ptr(),std::ptr::null_mut());}
        for mask in &self.modifiers {self.api.symbol::<unsafe extern "C" fn(Object,Object,u32,u32,*mut Object)->i32>(b"atspi_deregister_keystroke_listener")(self.key_listener,std::ptr::null_mut(),*mask,1,std::ptr::null_mut());}
        self.api.unref(self.event_listener);self.api.unref(self.key_listener);self.api.unref(self.field);
    }}
}
impl Listener {
    fn discard(&mut self){self.edits.reset();self.state.reset();}
    fn reset(&mut self){self.discard();unsafe{self.api.unref(self.field);}self.field=std::ptr::null_mut();self.state.reset();}
    fn feed(&self,app:&str,edits:Vec<Edit>){for edit in edits{self.state.feed(Event{epoch:self.epoch,field:format!("{:p}",self.field),app:app.into(),safe:true,direct:true,edit});}}
    unsafe extern "C" fn key(raw:*const KeyEvent,data:Object)->i32 {unsafe{
        let this=&mut *(data as *mut Self);let key=&*raw;
        if key.kind==0&&(key.modifiers&!(1|2)!=0||matches!(key.id,0xff09|0xff1b|0xff50..=0xff58|0xffff)){this.discard();}
        0
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
        let Some(app)=self.api.safe(event.source)else{self.discard();return;};let now=Observation::now();self.state.safety(true);
        if kind.starts_with("object:text-selection-changed"){return;}
        if kind.starts_with("object:text-caret-moved") {if self.edits.moved(event.detail1,now){self.discard();}return;}
        if kind.starts_with("object:text-changed:") {
            if kind.contains("system")||event.data.kind!=64{self.discard();return;}
            let raw=self.api.symbol::<unsafe extern "C" fn(*const Value)->*const c_char>(b"g_value_get_string")(&event.data);if raw.is_null(){self.discard();return;}
            let text=CStr::from_ptr(raw).to_string_lossy();if text.chars().count()!=event.detail2 as usize{self.discard();return;}
            let edits=self.edits.change(kind.starts_with("object:text-changed:insert"),event.detail1,&text,now);self.feed(&app,edits);self.state.status("Active");return;
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
        let api=Api::load()?;ensure!([0,1].contains(&api.symbol::<unsafe extern "C" fn()->i32>(b"atspi_init")()),"AT-SPI unavailable");let context=api.symbol::<unsafe extern "C" fn()->Object>(b"g_main_context_new")();api.symbol::<unsafe extern "C" fn(Object)>(b"atspi_set_main_context")(context);
        let unlocked=Arc::new(std::sync::atomic::AtomicBool::new(false));let session=unlocked.clone();std::thread::spawn(move||Self::watch_session(session));
        let mut listener=Box::new(Listener{event_listener:std::ptr::null_mut(),key_listener:std::ptr::null_mut(),registered:vec![],modifiers:vec![],unlocked,api,state,field:std::ptr::null_mut(),edits:TextEdits::default(),epoch:0});let pointer=(&mut *listener as *mut Listener).cast();
        let events=listener.api.symbol::<unsafe extern "C" fn(unsafe extern "C" fn(*const AccessibleEvent,Object),Object,Object)->Object>(b"atspi_event_listener_new")(Listener::event,pointer,std::ptr::null_mut());listener.event_listener=events;ensure!(!events.is_null(),"AT-SPI listener unavailable");
        for kind in [c"object:state-changed:focused",c"object:text-changed",c"object:text-selection-changed",c"object:text-caret-moved",c"window:deactivate"] {ensure!(listener.api.symbol::<unsafe extern "C" fn(Object,*const c_char,*mut Object)->i32>(b"atspi_event_listener_register")(events,kind.as_ptr(),std::ptr::null_mut())!=0,"AT-SPI registration failed");listener.registered.push(kind.to_owned());}
        let keys=listener.api.symbol::<unsafe extern "C" fn(unsafe extern "C" fn(*const KeyEvent,Object)->i32,Object,Object)->Object>(b"atspi_device_listener_new")(Listener::key,pointer,std::ptr::null_mut());listener.key_listener=keys;
        for modifiers in [0,1,2,3,4,8,64] {if !keys.is_null()&&listener.api.symbol::<unsafe extern "C" fn(Object,Object,u32,u32,u32,*mut Object)->i32>(b"atspi_register_keystroke_listener")(keys,std::ptr::null_mut(),modifiers,1,0,std::ptr::null_mut())!=0{listener.modifiers.push(modifiers);}}
        listener.state.status("Waiting for a supported editable field");
        loop {
            while listener.api.symbol::<unsafe extern "C" fn(Object,i32)->i32>(b"g_main_context_iteration")(context,0)!=0{}
            let unlocked=listener.unlocked.load(std::sync::atomic::Ordering::SeqCst);let safe=unlocked&&listener.api.safe(listener.field).is_some();listener.state.safety(safe);
            if !unlocked{listener.state.status("Session locked or session safety unavailable");}
            if !listener.state.enabled.load(std::sync::atomic::Ordering::SeqCst)||listener.epoch!=listener.state.epoch.load(std::sync::atomic::Ordering::SeqCst)||!unlocked{listener.reset();}else if !safe{listener.discard();}else if let Some(app)=listener.api.safe(listener.field){let edits=listener.edits.flush(Observation::now());listener.feed(&app,edits);}
            std::thread::sleep(Duration::from_millis(20));
        }
    }}
}


#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { edits:TextEdits,detector:typerelay_client::observation::Detector,completed:Vec<String>,now:i64 }
    impl Fixture {
        fn new()->Self {Self{edits:TextEdits::default(),detector:Default::default(),completed:vec![],now:1000}}
        fn change(&mut self,insert:bool,offset:i32,text:&str) {
            self.now+=10;let settings=typerelay_client::observation::Settings{enabled:true,..Default::default()};
            for edit in self.edits.change(insert,offset,text,self.now){if let Some(text)=self.detector.event(Event{epoch:1,field:"editor".into(),app:"code".into(),safe:true,direct:true,edit},&settings,1,self.now){self.completed.push(text);}}
        }
    }
    #[test]
    fn committed_inserts_complete_sentences_without_keyboard_events() {
        let mut f=Fixture::new();let mut offset=30;
        for _ in 0..2 {for c in "Please send the purple notebook tomorrow.\n".chars(){f.change(true,offset,&c.to_string());offset+=1;}}
        assert_eq!(f.completed,vec!["Please send the purple notebook tomorrow.";2]);
    }
    #[test]
    fn electron_replacements_learn_only_new_characters_not_existing_document_text() {
        let mut f=Fixture::new();let mut document="Existing private document contents.\n".to_owned();
        for _ in 0..2 {
            for c in "Please send the purple notebook tomorrow.\n".chars(){
                f.change(false,0,&document);assert!(!f.edits.moved(0,f.now));document.push(c);f.change(true,0,&document);
                // A duplicate accessibility refresh is not another occurrence.
                f.change(false,0,&document);f.change(true,0,&document);
            }
        }
        assert_eq!(f.completed,vec!["Please send the purple notebook tomorrow.";2]);
    }
    #[test]
    fn committed_unicode_edits_and_bulk_insertions_are_bounded() {
        let mut f=Fixture::new();let text="Café and a purple notebook";
        for (i,c) in text.chars().enumerate(){f.change(true,i as i32,&c.to_string());}
        let offset=text.chars().count() as i32;f.change(true,offset,"x");f.change(false,offset,"x");f.change(true,offset,".\n");
        assert_eq!(f.completed,vec!["Café and a purple notebook."]);
        f.change(true,0,"A whole pasted sentence must never be learned.\n");assert_eq!(f.completed.len(),1);
        f.change(false,0,"A whole old sentence.");f.change(true,0,"An entirely new pasted sentence.\n");assert_eq!(f.completed.len(),1);
        assert!(matches!(f.edits.change(true,0,&"x".repeat(4097),f.now+1).as_slice(),[Edit::Reset]));
    }
    #[test]
    fn unpaired_deletion_and_caret_move_reset_unfinished_input() {
        let mut edits=TextEdits::default();edits.change(true,12,"text",1000);assert!(!edits.moved(0,1100));assert!(edits.moved(0,1400));
        edits.change(false,15,"t",1500);assert!(edits.flush(1574).is_empty());assert!(matches!(edits.flush(1575).as_slice(),[Edit::Backspace]));
        edits.reset();assert!(edits.flush(2000).is_empty());
    }
    #[test]
    fn atspi_abi_and_runtime_symbols_are_available() {
        assert_eq!(std::mem::size_of::<AccessibleEvent>(),56);
        assert_eq!(std::mem::size_of::<KeyEvent>(),32);
        Api::load().expect("Install the packaged AT-SPI runtime dependency");
    }
}
