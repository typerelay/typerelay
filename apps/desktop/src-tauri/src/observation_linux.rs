//! Observe committed AT-SPI edits; keyboard callbacks are optional cancellation hints.
use std::{collections::VecDeque,ffi::{c_char,c_void,CStr,CString},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::Duration};
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
// AT-SPI pumps callbacks inside synchronous queries. Callbacks may only queue
// owned events; mutating Listener there can free the field a query is using.
struct OwnedEvent { raw:*const AccessibleEvent,kind:usize,free:unsafe extern "C" fn(usize,Object) }
impl Drop for OwnedEvent {fn drop(&mut self){unsafe{(self.free)(self.kind,self.raw as Object);}}}
enum Pending { Accessible(OwnedEvent),Cancel }
struct EventQueue { pending:Mutex<VecDeque<Pending>>,overflow:AtomicBool,kind:usize,free:unsafe extern "C" fn(usize,Object) }
impl EventQueue {
    fn new(kind:usize,free:unsafe extern "C" fn(usize,Object))->Self {Self{pending:Mutex::new(VecDeque::new()),overflow:AtomicBool::new(false),kind,free}}
    fn push(&self,event:Pending){let mut pending=self.pending.lock().unwrap();if pending.len()>=256{self.overflow.store(true,Ordering::SeqCst);drop(pending);drop(event);}else{pending.push_back(event);}}
    fn pop(&self)->Option<Pending>{self.pending.lock().unwrap().pop_front()}
    fn clear(&self){let pending=std::mem::take(&mut *self.pending.lock().unwrap());drop(pending);}
}
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
#[derive(Default)]
struct Focus { blurred:Option<i64>,popup:bool }
impl Focus {
    fn missing(&mut self,now:i64){if !self.popup&&self.blurred.is_none(){self.blurred=Some(now);}}
    fn lost(&mut self,now:i64){self.blurred=Some(now);self.popup=false;}
    fn gained(&mut self,same_editor:bool,completion:bool)->bool {self.blurred=None;self.popup=completion;!same_editor&&!completion}
    fn permits_unfocused(&self,now:i64)->bool {self.popup||self.blurred.is_some_and(|at|(0..200).contains(&(now-at)))}
}
struct Api { library:libloading::Library }
impl Api {
    unsafe fn symbol<T:Copy>(&self,name:&[u8])->T {unsafe{*self.library.get::<T>(name).expect("validated AT-SPI symbol")}}
    fn load()->Result<Self> {unsafe{let api=Self{library:libloading::Library::new("libatspi.so.0")?};for name in ["atspi_init","atspi_set_timeout","atspi_event_listener_new","atspi_event_listener_register","atspi_event_listener_deregister","atspi_deregister_keystroke_listener","atspi_device_listener_new","atspi_register_keystroke_listener","atspi_accessible_get_role","atspi_accessible_get_state_set","atspi_state_set_contains","atspi_accessible_get_process_id","atspi_accessible_get_text_iface","atspi_text_get_n_selections","atspi_event_get_type","g_boxed_free","g_object_unref","g_object_ref","g_value_get_string"]{api.library.get::<unsafe extern "C" fn()>(name.as_bytes())?;}Ok(api)}}
    fn initialize()->Result<Self> {unsafe{
        ensure!(glib::MainContext::default().is_owner(),"AT-SPI must run on the desktop event loop");
        let api=Self::load()?;ensure!([0,1].contains(&api.symbol::<unsafe extern "C" fn()->i32>(b"atspi_init")()),"AT-SPI unavailable");api.symbol::<unsafe extern "C" fn(i32,i32)>(b"atspi_set_timeout")(25,25);Ok(api)
    }}
    unsafe fn unref(&self,object:Object) {if !object.is_null(){unsafe{self.symbol::<unsafe extern "C" fn(Object)>(b"g_object_unref")(object);}}}
    unsafe fn process(&self,source:Object)->u32 {unsafe{self.symbol::<unsafe extern "C" fn(Object,*mut Object)->u32>(b"atspi_accessible_get_process_id")(source,std::ptr::null_mut())}}
    unsafe fn safe(&self,source:Object,allow_completion:bool)->Option<String> {unsafe{
        if source.is_null(){return None;}
        let role=self.symbol::<unsafe extern "C" fn(Object,*mut Object)->i32>(b"atspi_accessible_get_role")(source,std::ptr::null_mut());if ![61,79].contains(&role){return None;}
        let states=self.symbol::<unsafe extern "C" fn(Object)->Object>(b"atspi_accessible_get_state_set")(source);if states.is_null(){return None;}
        let contains=self.symbol::<unsafe extern "C" fn(Object,i32)->i32>(b"atspi_state_set_contains");let safe=[7,8,24].into_iter().all(|flag|contains(states,flag)!=0)&&(contains(states,12)!=0||allow_completion&&contains(states,37)!=0);self.unref(states);if !safe{return None;}
        let text=self.symbol::<unsafe extern "C" fn(Object)->Object>(b"atspi_accessible_get_text_iface")(source);if text.is_null(){return None;}
        let selections=self.symbol::<unsafe extern "C" fn(Object,*mut Object)->i32>(b"atspi_text_get_n_selections")(text,std::ptr::null_mut());self.unref(text);if selections!=0{return None;}
        let pid=self.process(source);if pid==0||pid==std::process::id(){return None;}
        let path=std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;let app=path.file_name()?.to_string_lossy().into_owned();typerelay_client::observation::Settings::supported_app(&app).then_some(app)
    }}
}
struct Listener { event_listener:Object,key_listener:Object,registered:Vec<CString>,modifiers:Vec<u32>,unlocked:Arc<std::sync::atomic::AtomicBool>,api:Api,state:Arc<Observation>,field:Object,edits:TextEdits,focus:Focus,epoch:u64,queue:Box<EventQueue> }
impl Drop for Listener {
    fn drop(&mut self) {unsafe {
        for kind in &self.registered {self.api.symbol::<unsafe extern "C" fn(Object,*const c_char,*mut Object)->i32>(b"atspi_event_listener_deregister")(self.event_listener,kind.as_ptr(),std::ptr::null_mut());}
        for mask in &self.modifiers {self.api.symbol::<unsafe extern "C" fn(Object,Object,u32,u32,*mut Object)->i32>(b"atspi_deregister_keystroke_listener")(self.key_listener,std::ptr::null_mut(),*mask,1,std::ptr::null_mut());}
        self.api.unref(self.event_listener);self.api.unref(self.key_listener);self.api.unref(self.field);self.queue.clear();
    }}
}
impl Listener {
    fn safe_field(&mut self)->Option<String> {unsafe{
        if let Some(app)=self.api.safe(self.field,false){self.focus.blurred=None;return Some(app);}
        let app=self.api.safe(self.field,true)?;let now=Observation::now();self.focus.missing(now);
        self.focus.permits_unfocused(now).then_some(app)
    }}
    fn discard(&mut self){self.edits.reset();self.state.reset();}
    fn reset(&mut self){self.discard();self.focus=Focus::default();unsafe{self.api.unref(self.field);}self.field=std::ptr::null_mut();self.state.reset();}
    fn feed(&self,app:&str,edits:Vec<Edit>){for edit in edits{self.state.feed(Event{epoch:self.epoch,field:format!("{:p}",self.field),app:app.into(),safe:true,direct:true,edit});}}
    unsafe extern "C" fn key(raw:*const KeyEvent,data:Object)->i32 {unsafe{
        let queue=&*(data as *const EventQueue);let key=&*raw;
        if key.kind==0&&(key.modifiers&!(1|2)!=0||matches!(key.id,0xff09|0xff1b|0xff50..=0xff58|0xffff)){queue.push(Pending::Cancel);}
        0
    }}
    unsafe extern "C" fn event(raw:*const AccessibleEvent,data:Object) {unsafe{
        let queue=&*(data as *const EventQueue);queue.push(Pending::Accessible(OwnedEvent{raw,kind:queue.kind,free:queue.free}));
    }}
    fn drain(&mut self){
        let started=std::time::Instant::now();
        for _ in 0..256 {
            if started.elapsed()>=Duration::from_millis(5){break;}
            if self.queue.overflow.swap(false,Ordering::SeqCst){self.queue.clear();self.reset();return;}
            let Some(event)=self.queue.pop()else{return;};
            match event {Pending::Accessible(event)=>unsafe{self.handle(&*event.raw);},Pending::Cancel=>self.discard()}
        }
    }
    unsafe fn handle(&mut self,event:&AccessibleEvent) {unsafe{
        if !self.state.enabled.load(std::sync::atomic::Ordering::SeqCst)||!self.unlocked.load(std::sync::atomic::Ordering::SeqCst){self.reset();return;}
        let epoch=self.state.epoch.load(std::sync::atomic::Ordering::SeqCst);if epoch!=self.epoch{self.reset();self.epoch=epoch;}
        let kind=CStr::from_ptr(event.kind).to_string_lossy();
        if kind.starts_with("object:state-changed:focused") {
            if event.detail1!=0{let role=self.api.symbol::<unsafe extern "C" fn(Object,*mut Object)->i32>(b"atspi_accessible_get_role")(event.source,std::ptr::null_mut());let app=std::fs::read_link(format!("/proc/{}/exe",self.api.process(event.source))).ok().and_then(|path|path.file_name().map(|name|name.to_string_lossy().into_owned()));self.state.protect(if role==40{app}else{None});}
            if event.detail1==0{if event.source==self.field{self.focus.lost(Observation::now());}return;}
            let same=event.source==self.field&&!self.field.is_null();
            let role=self.api.symbol::<unsafe extern "C" fn(Object,*mut Object)->i32>(b"atspi_accessible_get_role")(event.source,std::ptr::null_mut());
            let completion=!self.field.is_null()&&role==32&&self.api.process(event.source)==self.api.process(self.field)&&self.api.safe(self.field,true).is_some();
            if self.focus.gained(same,completion){self.reset();}
            if self.field.is_null()&&self.api.safe(event.source,false).is_some(){self.field=self.api.symbol::<unsafe extern "C" fn(Object)->Object>(b"g_object_ref")(event.source);self.state.status("Ready to observe typing");}return;
        }
        if kind.starts_with("window:"){if !self.field.is_null()&&self.api.process(event.source)==self.api.process(self.field){self.reset();}return;}
        if self.state.native(){return;}
        if event.source!=self.field||self.field.is_null(){
            // Some editors replace their accessible entry without a focus event.
            if !kind.starts_with("object:text-changed:")||self.api.safe(event.source,false).is_none(){return;}
            self.reset();self.field=self.api.symbol::<unsafe extern "C" fn(Object)->Object>(b"g_object_ref")(event.source);
        }
        let Some(app)=self.safe_field()else{self.discard();return;};let now=Observation::now();self.state.safety(true);
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

    pub fn start(state:Arc<Observation>) {
        let observer=state.clone();let result=state.app.run_on_main_thread(move||{if Self::run(observer.clone()).is_err(){observer.reset();observer.status("Unavailable: enable desktop accessibility and install AT-SPI 2, then restart Typerelay");}});
        if result.is_err(){state.reset();state.status("Unavailable: desktop event loop stopped");}
    }
    fn run(state:Arc<Observation>)->Result<()> {unsafe{
        // AT-SPI attaches newly discovered application buses to the default context,
        // even after atspi_set_main_context. Its global deferred-message queue is
        // not thread-safe: initialize, query and dispatch only on GTK's thread.
        let api=Api::initialize()?;
        let unlocked=Arc::new(std::sync::atomic::AtomicBool::new(false));let session=unlocked.clone();std::thread::spawn(move||Self::watch_session(session));
        let kind=api.symbol::<unsafe extern "C" fn()->usize>(b"atspi_event_get_type")();let free=api.symbol::<unsafe extern "C" fn(usize,Object)>(b"g_boxed_free");
        let mut queue=Box::new(EventQueue::new(kind,free));let pointer=(&mut *queue as *mut EventQueue).cast();
        let mut listener=Listener{event_listener:std::ptr::null_mut(),key_listener:std::ptr::null_mut(),registered:vec![],modifiers:vec![],unlocked,api,state,field:std::ptr::null_mut(),edits:TextEdits::default(),focus:Focus::default(),epoch:0,queue};
        let events=listener.api.symbol::<unsafe extern "C" fn(unsafe extern "C" fn(*const AccessibleEvent,Object),Object,Object)->Object>(b"atspi_event_listener_new")(Listener::event,pointer,std::ptr::null_mut());listener.event_listener=events;ensure!(!events.is_null(),"AT-SPI listener unavailable");
        for kind in [c"object:state-changed:focused",c"object:text-changed",c"object:text-selection-changed",c"object:text-caret-moved",c"window:deactivate"] {ensure!(listener.api.symbol::<unsafe extern "C" fn(Object,*const c_char,*mut Object)->i32>(b"atspi_event_listener_register")(events,kind.as_ptr(),std::ptr::null_mut())!=0,"AT-SPI registration failed");listener.registered.push(kind.to_owned());}
        let keys=listener.api.symbol::<unsafe extern "C" fn(unsafe extern "C" fn(*const KeyEvent,Object)->i32,Object,Object)->Object>(b"atspi_device_listener_new")(Listener::key,pointer,std::ptr::null_mut());listener.key_listener=keys;
        for modifiers in [0,1,2,3,4,8,64] {if !keys.is_null()&&listener.api.symbol::<unsafe extern "C" fn(Object,Object,u32,u32,u32,*mut Object)->i32>(b"atspi_register_keystroke_listener")(keys,std::ptr::null_mut(),modifiers,1,0,std::ptr::null_mut())!=0{listener.modifiers.push(modifiers);}}
        listener.state.status("Waiting for a supported editable field");
        glib::timeout_add_local_full(Duration::from_millis(20),glib::Priority::DEFAULT_IDLE,move||{
            listener.drain();
            let unlocked=listener.unlocked.load(std::sync::atomic::Ordering::SeqCst);
            if !unlocked{listener.state.status("Session locked or session safety unavailable");}
            if !listener.state.enabled.load(std::sync::atomic::Ordering::SeqCst)||listener.epoch!=listener.state.epoch.load(std::sync::atomic::Ordering::SeqCst)||!unlocked{listener.reset();listener.state.safety(false);}else{let app=listener.safe_field();listener.state.safety(app.is_some());if let Some(app)=app{let edits=listener.edits.flush(Observation::now());listener.feed(&app,edits);}else{listener.discard();}}
            glib::ControlFlow::Continue
        });
        Ok(())
    }}
}


#[cfg(test)]
mod tests {
    use super::*;
    struct CallbackFixture;
    impl CallbackFixture {
        unsafe extern "C" fn free(kind:usize,raw:Object){unsafe{drop(Box::from_raw(raw as *mut AccessibleEvent));(*(kind as *const std::sync::atomic::AtomicUsize)).fetch_add(1,Ordering::SeqCst);}}
        fn event()->*const AccessibleEvent {Box::into_raw(Box::new(AccessibleEvent{kind:c"object:state-changed:focused".as_ptr(),source:std::ptr::null_mut(),detail1:0,detail2:0,data:Value{kind:0,data:[0,0]},sender:std::ptr::null_mut()}))}
    }
    #[test]
    fn reentrant_callbacks_only_queue_and_keep_in_flight_events_alive() {
        let freed=std::sync::atomic::AtomicUsize::new(0);let mut queue=Box::new(EventQueue::new(&freed as *const _ as usize,CallbackFixture::free));let data=(&mut *queue as *mut EventQueue).cast();
        unsafe{Listener::event(CallbackFixture::event(),data);}
        let active=queue.pop().unwrap();
        // Simulate a focus-change callback delivered inside an accessibility query.
        unsafe{Listener::event(CallbackFixture::event(),data);Listener::key(&KeyEvent{kind:0,id:0xff09,hardware:0,modifiers:0,timestamp:0,text:std::ptr::null(),is_text:0},data);}
        assert_eq!(freed.load(Ordering::SeqCst),0);assert_eq!(queue.pending.lock().unwrap().len(),2);
        drop(active);assert_eq!(freed.load(Ordering::SeqCst),1);
        assert!(matches!(queue.pop(),Some(Pending::Accessible(_))));assert_eq!(freed.load(Ordering::SeqCst),2);assert!(matches!(queue.pop(),Some(Pending::Cancel)));assert!(queue.pop().is_none());
    }
    #[test]
    fn callback_overflow_is_bounded_and_releases_every_owned_event() {
        let freed=std::sync::atomic::AtomicUsize::new(0);let mut queue=Box::new(EventQueue::new(&freed as *const _ as usize,CallbackFixture::free));let data=(&mut *queue as *mut EventQueue).cast();
        for _ in 0..257{unsafe{Listener::event(CallbackFixture::event(),data);}}
        assert!(queue.overflow.swap(false,Ordering::SeqCst));assert_eq!(queue.pending.lock().unwrap().len(),256);assert_eq!(freed.load(Ordering::SeqCst),1);
        queue.clear();assert_eq!(freed.load(Ordering::SeqCst),257);assert!(queue.pop().is_none());
    }
    struct Fixture { edits:TextEdits,detector:typerelay_client::observation::Detector,completed:Vec<String>,now:i64 }
    impl Fixture {
        fn new()->Self {Self{edits:TextEdits::default(),detector:Default::default(),completed:vec![],now:1000}}
        fn change(&mut self,insert:bool,offset:i32,text:&str) {
            self.now+=10;let settings=typerelay_client::observation::Settings{enabled:true,..Default::default()};
            for edit in self.edits.change(insert,offset,text,self.now){if let Some(text)=self.detector.event(Event{epoch:1,field:"editor".into(),app:"code".into(),safe:true,direct:true,edit},&settings,1,self.now){self.completed.push(text);}}
        }
    }
    #[test]
    fn autocomplete_focus_roundtrips_preserve_complete_email_occurrences() {
        let mut f=Fixture::new();let mut focus=Focus::default();let mut offset=423;
        for _ in 0..2 {
            for c in "me@".chars(){f.change(true,offset,&c.to_string());offset+=1;}
            // Chromium updates the field state before emitting its blur/popup events.
            focus.missing(f.now);assert!(focus.permits_unfocused(f.now));
            f.change(true,offset,"e");offset+=1;
            focus.lost(f.now);assert!(focus.permits_unfocused(f.now+100));
            assert!(!focus.gained(false,true));assert!(focus.permits_unfocused(f.now+1000));
            for c in "mail.com".chars(){f.change(true,offset,&c.to_string());offset+=1;}
            assert!(!focus.gained(true,false));assert!(!focus.permits_unfocused(f.now));
            f.change(true,offset,"\n");offset+=1;
        }
        assert_eq!(f.completed,vec!["me@email.com";2]);
        focus.lost(f.now);assert!(focus.permits_unfocused(f.now+199));assert!(!focus.permits_unfocused(f.now+200));
        assert!(focus.gained(false,false));assert!(!focus.permits_unfocused(f.now));
        focus.missing(f.now);focus.missing(f.now+150);assert!(!focus.permits_unfocused(f.now+200));
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
    fn accessibility_worker_cannot_initialize_beside_desktop_dispatch() {
        let context=glib::MainContext::default();let _owner=context.acquire().unwrap();
        let error=std::thread::spawn(||Api::initialize().err().expect("Worker must not initialize AT-SPI").to_string()).join().unwrap();
        assert_eq!(error,"AT-SPI must run on the desktop event loop");
    }
    #[test]
    fn atspi_abi_and_runtime_symbols_are_available() {
        assert_eq!(std::mem::size_of::<AccessibleEvent>(),56);
        assert_eq!(std::mem::size_of::<KeyEvent>(),32);
        Api::load().expect("Install the packaged AT-SPI runtime dependency");
    }
}
