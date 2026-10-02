use anyhow::{Context,Result,ensure};
use core_foundation::runloop::CFRunLoop;
use core_graphics::{event::{CallbackResult,CGEvent,CGEventFlags,CGEventTap,CGEventTapLocation,CGEventTapOptions,CGEventTapPlacement,CGEventType,EventField,KeyCode},event_source::{CGEventSource,CGEventSourceStateID},geometry::CGPoint};
use foreign_types::ForeignType;
use objc2_app_kit::{NSWorkspace,NSRunningApplication,NSApplicationActivationOptions};
use std::{ffi::{c_void,CString},mem,process::Command,sync::{Arc,Mutex,mpsc::{Receiver,SyncSender,sync_channel}},time::{Duration,Instant}};
use typerelay_client::{database::DatabaseSnapshot,settings::SettingsStore};
use typerelay_core::{Engine,Expansion,Input,FeedResult};
use typerelay_client::browser_lease::BrowserLease;
use objc2_foundation::NSObjectProtocol;
use objc2_user_notifications::UNUserNotificationCenterDelegate;
type Ref = *const c_void;
objc2::define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    struct NativeNotificationDelegate;
    unsafe impl NSObjectProtocol for NativeNotificationDelegate {}
    unsafe impl UNUserNotificationCenterDelegate for NativeNotificationDelegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn responded(&self,_center:&objc2_user_notifications::UNUserNotificationCenter,response:&objc2_user_notifications::UNNotificationResponse,completion:&block2::DynBlock<dyn Fn()>) {
            if response.notification().request().identifier().to_string().starts_with("suggestion:"){NativeNotifications::activate_suggestion();}completion.call(());
        }

        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(&self,_center:&objc2_user_notifications::UNUserNotificationCenter,_notification:&objc2_user_notifications::UNNotification,completion:&block2::DynBlock<dyn Fn(objc2_user_notifications::UNNotificationPresentationOptions)>) {
            completion.call((objc2_user_notifications::UNNotificationPresentationOptions::Banner|objc2_user_notifications::UNNotificationPresentationOptions::List,));
        }
    }
);
// The delegate has no mutable state; UserNotifications calls it on its own queue.
unsafe impl Send for NativeNotificationDelegate {}
unsafe impl Sync for NativeNotificationDelegate {}
pub struct NativeNotifications;
impl NativeNotifications {
    fn suggestion_app()->&'static std::sync::OnceLock<tauri::AppHandle> {static APP:std::sync::OnceLock<tauri::AppHandle>=std::sync::OnceLock::new();&APP}
    pub fn suggestion(app:tauri::AppHandle,message:&str)->Result<()> {let _=Self::suggestion_app().set(app);Self::deliver(message,false,true)}
    fn activate_suggestion(){if let Some(app)=Self::suggestion_app().get(){let handle=app.clone();let _=app.run_on_main_thread(move||crate::observation::Observation::open(&handle));}}

    pub fn allowed()->Option<bool> {
        use objc2_user_notifications::{UNAuthorizationStatus,UNNotificationSetting,UNNotificationSettings,UNUserNotificationCenter};
        let(sender,receiver)=std::sync::mpsc::sync_channel(1);
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block2::RcBlock::new(move|settings:std::ptr::NonNull<UNNotificationSettings>|{let settings=unsafe{settings.as_ref()};let _=sender.send(settings.authorizationStatus()==UNAuthorizationStatus::Authorized&&settings.alertSetting()==UNNotificationSetting::Enabled);}));
        receiver.recv_timeout(Duration::from_secs(2)).ok()
    }
    pub fn open_settings()->Result<()> {let status=Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.notifications").status()?;ensure!(status.success(),"Could not open Notifications settings");Ok(())}
    pub fn show(message:&str,error:bool)->Result<()> {Self::deliver(message,error,false)}
    fn deliver(message:&str,error:bool,suggestion:bool)->Result<()> {
        use objc2::{AnyThread,runtime::ProtocolObject};
        use objc2_foundation::{NSError,NSString};
        use objc2_user_notifications::{UNAuthorizationOptions,UNMutableNotificationContent,UNNotificationRequest,UNUserNotificationCenter};
        static DELEGATE:std::sync::OnceLock<objc2::rc::Retained<NativeNotificationDelegate>>=std::sync::OnceLock::new();
        let delegate=DELEGATE.get_or_init(||unsafe{objc2::msg_send![NativeNotificationDelegate::alloc(),init]});
        let center=UNUserNotificationCenter::currentNotificationCenter();center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
        let(sender,receiver)=std::sync::mpsc::sync_channel(1);
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert,&block2::RcBlock::new(move|granted:objc2::runtime::Bool,error:*mut NSError|{let result=if error.is_null(){Ok(granted.as_bool())}else{Err(unsafe{&*error}.localizedDescription().to_string())};let _=sender.send(result);}));
        let granted=receiver.recv_timeout(Duration::from_secs(60)).context("Notification permission request timed out")?.map_err(anyhow::Error::msg)?;
        ensure!(granted,"Enable TypeRelay notifications in System Settings → Notifications");
        let content=UNMutableNotificationContent::new();content.setTitle(&NSString::from_str(if error{"TypeRelay — Error"}else{"TypeRelay"}));content.setBody(&NSString::from_str(message));
        let request=UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&format!("{}{}",if suggestion{"suggestion:"}else{""},uuid::Uuid::new_v4())),&content,None);
        let(sender,receiver)=std::sync::mpsc::sync_channel(1);
        center.addNotificationRequest_withCompletionHandler(&request,Some(&block2::RcBlock::new(move|error:*mut NSError|{let result=if error.is_null(){Ok(())}else{Err(unsafe{&*error}.localizedDescription().to_string())};let _=sender.send(result);} )));
        receiver.recv_timeout(Duration::from_secs(10)).context("Notification delivery timed out")?.map_err(anyhow::Error::msg)
    }
}
#[link(name="ApplicationServices",kind="framework")]
unsafe extern "C" { fn AXIsProcessTrusted() -> bool; fn AXUIElementCreateApplication(pid:i32)->Ref; fn AXUIElementCopyAttributeValue(element:Ref,attribute:Ref,value:*mut Ref)->i32; fn AXUIElementPerformAction(element:Ref,action:Ref)->i32; fn AXValueGetValue(value:Ref,kind:i32,result:*mut c_void)->bool; fn CGEventSourceKeyState(source:i32,key:u16)->bool; fn CGEventKeyboardGetUnicodeString(event:core_graphics::sys::CGEventRef,max:usize,actual:*mut usize,buffer:*mut u16); }
#[link(name="IOKit",kind="framework")]
unsafe extern "C" { fn IOHIDCheckAccess(request:i32)->i32; }
#[link(name="CoreFoundation",kind="framework")]
unsafe extern "C" { fn CFStringCreateWithCString(allocator:Ref,text:*const i8,encoding:u32)->Ref; fn CFRelease(value:Ref); fn CFEqual(a:Ref,b:Ref)->bool; }
#[derive(Debug)]
struct Window(usize);
impl Drop for Window { fn drop(&mut self) { unsafe { CFRelease(self.0 as Ref); } } }
#[derive(Clone,Debug)]
pub struct Target { pid:i32, window:Arc<Window>, pub bounds:Option<(i32,i32,u32,u32)> }
impl Target {
    fn attribute(app:Ref,name:&str)->Result<Ref> { unsafe { let c=CString::new(name)?; let key=CFStringCreateWithCString(std::ptr::null(),c.as_ptr(),0x08000100); let mut value=std::ptr::null(); let result=AXUIElementCopyAttributeValue(app,key,&mut value); CFRelease(key); ensure!(result==0 && !value.is_null(),"Cannot identify original window; allow TypeRelay Accessibility permission"); Ok(value) } }
    pub fn capture()->Result<Self> { unsafe { ensure!(AXIsProcessTrusted(),"Allow TypeRelay in System Settings → Privacy & Security → Accessibility"); let application=NSWorkspace::sharedWorkspace().frontmostApplication().context("No active application")?; let pid=application.processIdentifier(); ensure!(pid != std::process::id() as i32,"Choose another application first"); let app=AXUIElementCreateApplication(pid); let window=Self::attribute(app,"AXFocusedWindow"); CFRelease(app); let window=window?;
        let mut position=[0f64;2];let mut size=[0f64;2];
        let bounds=if let (Ok(p),Ok(s))=(Self::attribute(window,"AXPosition"),Self::attribute(window,"AXSize")){let valid=AXValueGetValue(p,1,position.as_mut_ptr().cast()) && AXValueGetValue(s,2,size.as_mut_ptr().cast());CFRelease(p);CFRelease(s);if valid{Some((position[0] as i32,position[1] as i32,size[0] as u32,size[1] as u32))}else{None}}else{None};
        Ok(Self{pid,window:Arc::new(Window(window as usize)),bounds}) } }
    pub fn restore(&self)->Result<()> { unsafe { let application=NSRunningApplication::runningApplicationWithProcessIdentifier(self.pid).context("Original application closed")?; let name=CString::new("AXRaise")?; let action=CFStringCreateWithCString(std::ptr::null(),name.as_ptr(),0x08000100); let result=AXUIElementPerformAction(self.window.0 as Ref,action); CFRelease(action); ensure!(result==0,"Original window is unavailable"); #[allow(deprecated)] let _=application.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps); } for _ in 0..40 { if self.focused()? { return Ok(()); } std::thread::sleep(std::time::Duration::from_millis(15)); } anyhow::bail!("Could not restore original window; use Copy") }
    pub fn focused(&self)->Result<bool> { unsafe { if NSWorkspace::sharedWorkspace().frontmostApplication().map(|app|app.processIdentifier()) != Some(self.pid) {return Ok(false);} let app=AXUIElementCreateApplication(self.pid); let current=Self::attribute(app,"AXFocusedWindow"); CFRelease(app); let current=current?; let equal=CFEqual(current,self.window.0 as Ref); CFRelease(current); Ok(equal) } }
}
pub fn keys_down()->bool { [56,60,59,62,58,61,55,54,36,43].iter().any(|key|unsafe{CGEventSourceKeyState(1,*key)}) }
pub fn fallback_allowed()->bool { NSWorkspace::sharedWorkspace().frontmostApplication().is_some_and(|app|app.processIdentifier()==std::process::id() as i32) }
pub fn accessibility(prompt:bool)->bool { let trusted=unsafe{AXIsProcessTrusted()};if !trusted&&prompt{let _=enigo::Enigo::new(&enigo::Settings::default());}trusted }
pub fn input_monitoring(prompt:bool)->bool { let _=prompt;unsafe{IOHIDCheckAccess(1)==0} }
pub fn open_accessibility_settings()->Result<()> { let status=Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status()?;ensure!(status.success(),"Could not open Accessibility settings");Ok(()) }
pub fn open_input_monitoring_settings()->Result<()> { let status=Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent").status()?;ensure!(status.success(),"Could not open Input Monitoring settings");Ok(()) }
pub fn open_url(url:&str)->Result<()> { let status=Command::new("/usr/bin/open").arg(url).status()?;ensure!(status.success(),"Could not open link");Ok(()) }
pub fn open_tui()->Result<()> { let executable=std::env::current_exe()?.with_file_name("typerelay-tui");ensure!(executable.is_file(),"TypeRelay TUI is missing from this application");let status=Command::new("/usr/bin/open").arg(executable).status()?;ensure!(status.success(),"Could not open TypeRelay TUI");Ok(()) }
pub fn insert(target:&Target,erase:usize,has_text:bool)->Result<()> { let source=CGEventSource::new(CGEventSourceStateID::Private).map_err(|_|anyhow::anyhow!("Cannot create keyboard event source; allow TypeRelay Accessibility permission"))?;let event=|key,down,flags|->Result<CGEvent>{let event=CGEvent::new_keyboard_event(source.clone(),key,down).map_err(|_|anyhow::anyhow!("Cannot create keyboard event"))?;event.set_flags(flags|CGEventFlags::CGEventFlagNonCoalesced);event.set_location(CGPoint::new(-27469.,0.));Ok(event)};let mut events=Vec::new();for _ in 0..erase{events.push(event(KeyCode::DELETE,true,CGEventFlags::empty())?);events.push(event(KeyCode::DELETE,false,CGEventFlags::empty())?);}if !has_text{events.push(event(KeyCode::RETURN,true,CGEventFlags::empty())?);events.push(event(KeyCode::RETURN,false,CGEventFlags::empty())?);}else{let command=CGEventFlags::CGEventFlagCommand;events.push(event(KeyCode::COMMAND,true,command)?);events.push(event(KeyCode::ANSI_V,true,command)?);events.push(event(KeyCode::ANSI_V,false,command)?);events.push(event(KeyCode::COMMAND,false,CGEventFlags::empty())?);}for event in events{event.post_to_pid(target.pid);std::thread::sleep(Duration::from_millis(2));}Ok(()) }
pub fn release_modifiers()->Result<()> { let source=CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_|anyhow::anyhow!("Cannot create keyboard event source"))?;for key in [KeyCode::COMMAND,KeyCode::RIGHT_COMMAND,KeyCode::SHIFT,KeyCode::RIGHT_SHIFT,KeyCode::CONTROL,KeyCode::RIGHT_CONTROL,KeyCode::OPTION,KeyCode::RIGHT_OPTION]{let event=CGEvent::new_keyboard_event(source.clone(),key,false).map_err(|_|anyhow::anyhow!("Cannot create keyboard event"))?;event.set_flags(CGEventFlags::empty());event.post(CGEventTapLocation::HID);}Ok(()) }

struct DeferredEvent { key:u16,down:bool,flags:CGEventFlags,text:Vec<u16>,repeat:i64,keyboard:i64 }
enum DeferredPhase { Capturing,Replaying,Finished }
struct DeferredState { events:Vec<DeferredEvent>,cancelled:bool,phase:DeferredPhase }
#[derive(Clone)]
pub struct DeferredInput(Arc<Mutex<DeferredState>>);
impl DeferredInput {
    fn new()->Self {Self(Arc::new(Mutex::new(DeferredState{events:Vec::new(),cancelled:false,phase:DeferredPhase::Capturing})))}
    fn finished(&self)->bool {matches!(self.0.lock().unwrap().phase,DeferredPhase::Finished)}
    fn cancel(&self){self.0.lock().unwrap().cancelled=true;}
    pub fn cancelled(&self)->bool {self.0.lock().unwrap().cancelled}
    fn capture(&self,event_type:CGEventType,event:&CGEvent)->bool {
        let mut state=self.0.lock().unwrap();if matches!(state.phase,DeferredPhase::Finished){return false;}
        let down=matches!(event_type,CGEventType::KeyDown);if !down&&!matches!(event_type,CGEventType::KeyUp){state.cancelled=true;return false;}
        let key=event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;let mut text=[0u16;8];let mut length=0;unsafe{CGEventKeyboardGetUnicodeString(event.as_ptr(),text.len(),&mut length,text.as_mut_ptr());}
        state.events.push(DeferredEvent{key,down,flags:event.get_flags(),text:text[..length.min(text.len())].to_vec(),repeat:event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT),keyboard:event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYBOARD_TYPE)});true
    }
    pub fn finish(&self,target:&Target)->Result<usize>{
        let result=(||->Result<usize>{let source=CGEventSource::new(CGEventSourceStateID::Private).map_err(|_|anyhow::anyhow!("Cannot create keyboard event source"))?;let mut replayed=0;loop {let events={let mut state=self.0.lock().unwrap();state.phase=DeferredPhase::Replaying;if state.events.is_empty(){state.phase=DeferredPhase::Finished;return Ok(replayed);}mem::take(&mut state.events)};for deferred in events {let event=CGEvent::new_keyboard_event(source.clone(),deferred.key,deferred.down).map_err(|_|anyhow::anyhow!("Cannot replay buffered keyboard input"))?;event.set_flags(deferred.flags|CGEventFlags::CGEventFlagNonCoalesced);event.set_string_from_utf16_unchecked(&deferred.text);event.set_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT,deferred.repeat);event.set_integer_value_field(EventField::KEYBOARD_EVENT_KEYBOARD_TYPE,deferred.keyboard);event.set_location(CGPoint::new(-27469.,0.));event.post_to_pid(target.pid);replayed+=usize::from(deferred.down);std::thread::sleep(Duration::from_millis(2));}}})();
        if result.is_err(){self.0.lock().unwrap().phase=DeferredPhase::Finished;}result
    }
}
pub struct ExpansionRequest { pub target:Target,pub expansion:Expansion,pub released:Receiver<()>,pub deferred:DeferredInput }
struct ExpansionState { store:DatabaseSnapshot,settings:SettingsStore,engine:Engine,target:Option<Target>,sender:SyncSender<ExpansionRequest>,release:Option<SyncSender<()>>,deferred:Option<DeferredInput>,suppress_right_up:bool,reloaded:Instant }
impl ExpansionState {
    fn new(directory:&std::path::Path,settings_path:std::path::PathBuf,sender:SyncSender<ExpansionRequest>)->Result<Self>{let store=DatabaseSnapshot::open(directory)?;let settings=SettingsStore::open(settings_path)?;let mut engine=Engine::new(store.snapshot.clone());engine.set_prefix(&settings.settings.trigger_prefix).map_err(anyhow::Error::msg)?;Ok(Self{store,settings,engine,target:None,sender,release:None,deferred:None,suppress_right_up:false,reloaded:Instant::now()})}
    fn reload(&mut self){
        if self.reloaded.elapsed()<Duration::from_millis(500){return;}
        self.reloaded=Instant::now();
        if let Ok(Some(snapshot))=self.store.reload(){self.engine.replace_snapshot(snapshot);self.target=None;}
        if let Ok(true)=self.settings.reload(){let _=self.engine.set_prefix(&self.settings.settings.trigger_prefix);self.target=None;}
    }
    fn character(key:u16)->Option<char>{match key{0=>Some('a'),1=>Some('s'),2=>Some('d'),3=>Some('f'),4=>Some('h'),5=>Some('g'),6=>Some('z'),7=>Some('x'),8=>Some('c'),9=>Some('v'),11=>Some('b'),12=>Some('q'),13=>Some('w'),14=>Some('e'),15=>Some('r'),16=>Some('y'),17=>Some('t'),18=>Some('1'),19=>Some('2'),20=>Some('3'),21=>Some('4'),22=>Some('6'),23=>Some('5'),24=>Some('='),25=>Some('9'),26=>Some('7'),27=>Some('-'),28=>Some('8'),29=>Some('0'),30=>Some(']'),31=>Some('o'),32=>Some('u'),33=>Some('['),34=>Some('i'),35=>Some('p'),37=>Some('l'),38=>Some('j'),39=>Some('\''),40=>Some('k'),41=>Some(';'),42=>Some('\\'),43=>Some(','),44=>Some('/'),45=>Some('n'),46=>Some('m'),47=>Some('.'),50=>Some('`'),_=>None}}
    fn input(event:&CGEvent,key:u16)->Input{match key{51=>Input::Backspace,117=>Input::Delete,123=>Input::Left,124=>Input::Right,49=>Input::Space,_=>{let mut buffer=[0u16;8];let mut length=0;unsafe{CGEventKeyboardGetUnicodeString(event.as_ptr(),buffer.len(),&mut length,buffer.as_mut_ptr());}let value=String::from_utf16_lossy(&buffer[..length.min(buffer.len())]);let mut characters=value.chars();let character=characters.next().or_else(||Self::character(key));let Some(character)=character else{return Input::Cancel;};if characters.next().is_some(){Input::Cancel}else{Input::Character(character)}}}}
    fn event(&mut self,event_type:CGEventType,event:&CGEvent)->bool {
        if (event.location().x+27469.).abs()<0.001{return false;}
        if self.deferred.as_ref().is_some_and(DeferredInput::finished){self.deferred=None;}
        let key=event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
        if matches!(event_type,CGEventType::KeyUp){
            if key==124&&self.suppress_right_up{self.suppress_right_up=false;return true;}
            if key==KeyCode::SPACE&&let Some(release)=self.release.take(){let _=release.try_send(());return false;}
            if let Some(deferred)=&self.deferred{return deferred.capture(event_type,event);}
            return false;
        }
        if key==124&&self.suppress_right_up{return true;}
        if let Some(deferred)=&self.deferred {if matches!(event_type,CGEventType::KeyDown){return deferred.capture(event_type,event);}deferred.cancel();}
        if !matches!(event_type,CGEventType::KeyDown){self.engine.feed(Input::Cancel);self.target=None;return false;}
		if BrowserLease::active(){self.engine.feed(Input::Cancel);self.target=None;return false;}
        self.reload();
        if key==124&&event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT)!=0{self.engine.feed(Input::Cancel);self.target=None;return false;}
        let modifiers=event.get_flags();
        if modifiers.intersects(CGEventFlags::CGEventFlagCommand|CGEventFlags::CGEventFlagControl|CGEventFlags::CGEventFlagAlternate|CGEventFlags::CGEventFlagShift|CGEventFlags::CGEventFlagAlphaShift){self.engine.feed(Input::Cancel);self.target=None;return false;}
        let input=Self::input(event,key);
        if matches!(input,Input::Character(character)if character==self.engine.prefix()){self.target=Target::capture().ok();}
        if self.target.is_none(){self.engine.feed(Input::Cancel);return false;}
        let result=self.engine.feed_event(input);
        if matches!(result,FeedResult::Suppress){self.suppress_right_up=true;return true;}
        if let FeedResult::Expand(mut expansion)=result&&let Some(target)=self.target.take()&&target.focused().ok()==Some(true){expansion.erase+=1;let (release,released)=sync_channel(1);let deferred=DeferredInput::new();if self.sender.try_send(ExpansionRequest{target,expansion,released,deferred:deferred.clone()}).is_ok(){self.release=Some(release);self.deferred=Some(deferred);}}
        if matches!(input,Input::Cancel|Input::Space){self.target=None;}
        false
    }
}
pub struct ExpansionSession;
impl ExpansionSession { pub fn start(directory:std::path::PathBuf,settings:std::path::PathBuf)->Result<Receiver<ExpansionRequest>>{let (sender,receiver)=sync_channel(1);let state=Arc::new(Mutex::new(ExpansionState::new(&directory,settings,sender)?));let (ready_sender,ready_receiver)=sync_channel(1);std::thread::spawn(move||{let failed=ready_sender.clone();let result=CGEventTap::with_enabled(CGEventTapLocation::HID,CGEventTapPlacement::TailAppendEventTap,CGEventTapOptions::Default,vec![CGEventType::KeyDown,CGEventType::KeyUp,CGEventType::LeftMouseDown,CGEventType::RightMouseDown,CGEventType::OtherMouseDown],move|_,event_type,event|{if let Ok(mut state)=state.try_lock()&&state.event(event_type,event){return CallbackResult::Drop;}CallbackResult::Keep},move||{let _=ready_sender.send(Ok(()));CFRunLoop::run_current()});if result.is_err(){let _=failed.try_send(Err(anyhow::anyhow!("Cannot monitor keyboard events; allow TypeRelay Accessibility permission")));}});ready_receiver.recv_timeout(Duration::from_secs(3)).context("macOS expansion listener did not start")??;Ok(receiver)} }

pub struct ClipboardLease { context:clipboard_rs::ClipboardContext, saved:Vec<clipboard_rs::ClipboardContent>, marker:Vec<u8>, active:bool }
impl ClipboardLease {
	pub fn publish(payload:typerelay_client::clipboard_payload::ClipboardPayload)->Result<Self> {
        use clipboard_rs::{Clipboard,ClipboardContent,ClipboardContext};
        let board=objc2_app_kit::NSPasteboard::generalPasteboard();
        let count=board.pasteboardItems().map(|items|items.count()).unwrap_or(0);
        ensure!(count<=1,"Clipboard contains multiple items; use Copy to leave them untouched until you choose to copy");
        let context=ClipboardContext::new().map_err(|e|anyhow::anyhow!("{e}"))?;
        let formats=if count==0{Vec::new()}else{context.available_formats().map_err(|e|anyhow::anyhow!("{e}"))?};
        ensure!(formats.len()<=64,"Too many clipboard formats; use Copy");
        let mut saved=Vec::new();let mut total=0;
        for format in formats {let bytes=context.get_buffer(&format).map_err(|e|anyhow::anyhow!("Cannot preserve clipboard: {e}"))?;total+=bytes.len();ensure!(total<=16*1024*1024,"Clipboard too large to preserve; use Copy");saved.push(ClipboardContent::Other(format,bytes));}
        let marker=uuid::Uuid::new_v4().to_string().into_bytes();
        let mut lease=Self{context,saved,marker,active:true};
		let mut contents=vec![ClipboardContent::Text(payload.plain),ClipboardContent::Other("com.typerelay.clipboard-owner".into(),lease.marker.clone())];if let Some(html)=payload.html{contents.push(ClipboardContent::Html(html));}if let Some(rtf)=payload.rtf{contents.push(ClipboardContent::Rtf(rtf));}if let Err(error)=lease.context.set(contents){let saved=std::mem::take(&mut lease.saved);let _=lease.context.set(saved);lease.active=false;return Err(anyhow::anyhow!("Clipboard write failed: {error}"));}
        Ok(lease)
    }
    pub fn restore(&mut self)->Result<()> {
        use clipboard_rs::Clipboard;
        if !self.active{return Ok(());}
        if self.context.get_buffer("com.typerelay.clipboard-owner").ok().as_deref()==Some(self.marker.as_slice()){self.context.set(std::mem::take(&mut self.saved)).map_err(|e|anyhow::anyhow!("Cannot restore clipboard: {e}"))?;}
        self.active=false;Ok(())
    }
}
impl Drop for ClipboardLease {fn drop(&mut self){let _=self.restore();}}

// Observation uses its own listen-only tap; accessibility calls never delay expansion.
pub struct ObservationAdapter;
impl ObservationAdapter {
    fn string(value:Ref)->String {use core_foundation::{base::TCFType,string::CFString};unsafe{CFString::wrap_under_get_rule(value.cast()).to_string()}}
    fn field()->Option<(String,String,isize)> {
        use core_foundation::{base::{CFHash,TCFType},boolean::CFBoolean};
        unsafe {
            if !AXIsProcessTrusted()||!input_monitoring(false)||IsSecureEventInputEnabled(){return None;}
            let application=NSWorkspace::sharedWorkspace().frontmostApplication()?;let pid=application.processIdentifier();if pid==std::process::id() as i32{return None;}
            let name=application.bundleIdentifier()?.to_string();if !typerelay_client::observation::Settings::supported_app(&name){return None;}let app=AXUIElementCreateApplication(pid);let field=Target::attribute(app,"AXFocusedUIElement");CFRelease(app);let field=field.ok()?;
            let result=(||->Result<_>{
                let role=Target::attribute(field,"AXRole")?;let role_name=Self::string(role);CFRelease(role);ensure!(["AXTextField","AXTextArea"].contains(&role_name.as_str()),"Unsupported field");
                if let Ok(subrole)=Target::attribute(field,"AXSubrole"){let subtype=Self::string(subrole);CFRelease(subrole);ensure!(!subtype.contains("Secure"),"Protected field");}else{ensure!(role_name=="AXTextArea","Unknown protection state");}
                let enabled=Target::attribute(field,"AXEnabled")?;let valid=bool::from(CFBoolean::wrap_under_get_rule(enabled.cast()));CFRelease(enabled);ensure!(valid,"Disabled field");
                let focus=Target::attribute(field,"AXFocused")?;let valid=bool::from(CFBoolean::wrap_under_get_rule(focus.cast()));CFRelease(focus);ensure!(valid,"Unfocused field");
                let range=Target::attribute(field,"AXSelectedTextRange")?;let mut selected=[0isize;2];let valid=AXValueGetValue(range,4,selected.as_mut_ptr().cast());CFRelease(range);ensure!(valid&&selected[1]==0,"Unknown caret");
                // Electron/contenteditable fields accept typing without exposing a writable AXValue.
                Ok((format!("{pid}:{}",CFHash(field.cast())),name,selected[0]))
            })().ok();CFRelease(field);result
        }
    }
    fn native_context(app_handle:&tauri::AppHandle)->Option<typerelay_client::observation::CaptureContext>{
        use typerelay_client::observation::{CaptureContext,CaptureSource,Protection};use core_foundation::base::CFHash;
        unsafe{
            if !AXIsProcessTrusted()||!input_monitoring(false){return None;}
            let application=NSWorkspace::sharedWorkspace().frontmostApplication()?;let pid=application.processIdentifier();if pid==std::process::id() as i32{return None;}
            let app_name=application.bundleIdentifier()?.to_string();if !typerelay_client::observation::Settings::supported_app(&app_name)||app_name=="com.apple.loginwindow"{return None;}
            let app=AXUIElementCreateApplication(pid);let window=Target::attribute(app,"AXFocusedWindow").ok();let field=Target::attribute(app,"AXFocusedUIElement").ok();CFRelease(app);
            let window_id=window.map(|window|{let id=CFHash(window.cast());CFRelease(window);id.to_string()}).or_else(||Self::native_window(pid).map(|id|id.to_string()))?;
            let mut protection=if IsSecureEventInputEnabled(){Protection::Protected}else{Protection::Unknown};
            if let Some(field)=field{if let Ok(role)=Target::attribute(field,"AXSubrole"){if Self::string(role).contains("Secure"){protection=Protection::Protected;}CFRelease(role);}CFRelease(field);}
            // Carbon input-source properties assert the main queue on macOS 27.
            // Wait for this one request so a busy main thread cannot accumulate callbacks.
            let(sender,receiver)=sync_channel(1);
            app_handle.run_on_main_thread(move||{
                let source=TISCopyCurrentKeyboardInputSource();if source.is_null(){let _=sender.send(None);return;}let id=TISGetInputSourceProperty(source,kTISPropertyInputSourceID);let kind=TISGetInputSourceProperty(source,kTISPropertyInputSourceType);let layout=if id.is_null(){String::new()}else{Self::string(id)};let ime=!kind.is_null()&&Self::string(kind).contains("InputMode");CFRelease(source);
                let _=sender.send(Some((layout,ime)));
            }).ok()?;
            let(layout,ime)=receiver.recv().ok()??;
            Some(CaptureContext{app:app_name,window:format!("{pid}:{window_id}"),protection,active:!IsSecureEventInputEnabled(),layout,ime:ime.then_some("macOS input method".into()),authority:if ime{CaptureSource::Ime}else{CaptureSource::Keyboard},..Default::default()})
        }
    }
    fn native_window(pid:i32)->Option<i32>{
        use core_foundation::{base::TCFType,string::CFString};unsafe{let list=CGWindowListCopyWindowInfo(17,0);if list.is_null(){return None;}let owner=CFString::new("kCGWindowOwnerPID");let number=CFString::new("kCGWindowNumber");let layer=CFString::new("kCGWindowLayer");let mut found=None;
            for index in 0..CFArrayGetCount(list).min(256){let dictionary=CFArrayGetValueAtIndex(list,index);let owner_value=CFDictionaryGetValue(dictionary,owner.as_concrete_TypeRef().cast());let layer_value=CFDictionaryGetValue(dictionary,layer.as_concrete_TypeRef().cast());let number_value=CFDictionaryGetValue(dictionary,number.as_concrete_TypeRef().cast());let(mut candidate,mut level,mut id)=(0i32,0i32,0i32);if !owner_value.is_null()&&!layer_value.is_null()&&!number_value.is_null()&&CFNumberGetValue(owner_value,3,(&mut candidate as *mut i32).cast())&&candidate==pid&&CFNumberGetValue(layer_value,3,(&mut level as *mut i32).cast())&&level==0&&CFNumberGetValue(number_value,3,(&mut id as *mut i32).cast()){found=Some(id);break;}}
            CFRelease(list);found}
    }
    pub fn start(state:Arc<crate::observation::Observation>) {
        use typerelay_client::observation::{Edit,Event};use std::sync::atomic::Ordering;
        let(sender,receiver)=sync_channel(128);let capture=state.clone();let running=Arc::new(std::sync::atomic::AtomicBool::new(false));let monitored=running.clone();
        std::thread::spawn(move||{
            let mut previous=None;let mut epoch=0;let mut native_previous=None::<typerelay_client::observation::CaptureContext>;let mut native_generation=0;let mut native_sequence=0;
            loop {
                let raw=receiver.recv_timeout(Duration::from_millis(25)).ok();
                if !state.enabled.load(Ordering::SeqCst){previous=None;continue;}
                if !monitored.load(Ordering::SeqCst){previous=None;state.safety(false);state.status("Permission needed: Input Monitoring; restart Typerelay after granting access");continue;}
                let current_epoch=state.epoch.load(Ordering::SeqCst);if epoch!=current_epoch{previous=None;epoch=current_epoch;}
                if state.native(){
                    use typerelay_client::observation::{CaptureHealth,CaptureSource,Edit,Protection};
                    if let Some(mut context)=Self::native_context(&state.app){
                        if native_previous.as_ref().is_none_or(|old|old.app!=context.app||old.window!=context.window||old.layout!=context.layout){if let Some(old)=&native_previous{native_sequence+=1;state.native_event(old.clone(),CaptureSource::Keyboard,native_sequence,if old.layout==context.layout{Edit::Boundary}else{Edit::Reset},crate::observation::Observation::now());}native_generation+=1;}context.generation=native_generation;
                        state.native_health(CaptureHealth{desktop:"macos".into(),layout:context.layout.clone(),ime:context.ime.clone(),app:Some(context.app.clone()),source:"keyboard".into(),blocked:if context.protection==Protection::Protected{Some("Learning paused in secure input".into())}else if context.ime.is_some(){Some("IME active: verified composition integration required".into())}else{None},at_ms:crate::observation::Observation::now(),..Default::default()});
                        if let Some((event_epoch,at,edit))=raw&&event_epoch==epoch&&crate::observation::Observation::now()-at<250{native_sequence+=1;state.native_event(context.clone(),CaptureSource::Keyboard,native_sequence,edit,at);}native_previous=Some(context);
                    }else{if let Some(old)=native_previous.take(){native_sequence+=1;state.native_event(old,CaptureSource::Keyboard,native_sequence,Edit::Reset,crate::observation::Observation::now());}state.native_health(CaptureHealth{desktop:"macos".into(),blocked:Some("Allow Accessibility and Input Monitoring, then focus an allowed app".into()),at_ms:crate::observation::Observation::now(),..Default::default()});}
                    continue;
                }
                if raw.is_some(){std::thread::sleep(Duration::from_millis(12));}
                let current=Self::field();state.safety(current.is_some());
                if let Some((event_epoch,at,edit))=raw {
                    let stable=previous.as_ref().zip(current.as_ref()).is_some_and(|(old,new):(&(String,String,isize),&(String,String,isize))|old.0==new.0&&old.1==new.1);
                    if stable&&event_epoch==epoch&&crate::observation::Observation::now()-at<250 {
                        let (field,app,_)=current.clone().unwrap();state.feed(Event{epoch,field,app,safe:true,direct:true,edit});
                    }else{state.reset();}
                }else if previous.as_ref().zip(current.as_ref()).is_none_or(|(old,new)|old.0!=new.0||old.1!=new.1){state.reset();}
                state.status(if current.is_some(){"Active"}else if !accessibility(false)||!input_monitoring(false){"Permission needed: Accessibility and Input Monitoring"}else{"Waiting for a supported editable field"});previous=current;
            }
        });
        std::thread::spawn(move||{
            let failure=capture.clone();let active=running.clone();
            let result=CGEventTap::with_enabled(CGEventTapLocation::HID,CGEventTapPlacement::HeadInsertEventTap,CGEventTapOptions::ListenOnly,vec![CGEventType::KeyDown,CGEventType::LeftMouseDown,CGEventType::RightMouseDown,CGEventType::OtherMouseDown],move|_,kind,event|{
                if !capture.enabled.load(Ordering::SeqCst){return CallbackResult::Keep;}
                let epoch=capture.epoch.load(Ordering::SeqCst);let flags=event.get_flags();let key=event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                let direct=matches!(kind,CGEventType::KeyDown)&&event.get_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID)==0&&event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT)==0&&!flags.intersects(CGEventFlags::CGEventFlagCommand|CGEventFlags::CGEventFlagControl);
                let edit=if !direct{Edit::Reset}else{match key{36|76=>Edit::Enter,48=>Edit::Boundary,51=>Edit::Backspace,123..=126|117|53=>Edit::Reset,_=>{let mut buffer=[0u16;16];let mut length=0;unsafe{CGEventKeyboardGetUnicodeString(event.as_ptr(),buffer.len(),&mut length,buffer.as_mut_ptr());}match String::from_utf16(&buffer[..length.min(buffer.len())]){Ok(text)if !text.is_empty()=>Edit::Text(text),_=>Edit::Reset}}}};
                if sender.try_send((epoch,crate::observation::Observation::now(),edit)).is_err(){capture.reset();}CallbackResult::Keep
            },move||{active.store(true,Ordering::SeqCst);CFRunLoop::run_current()});
            running.store(false,Ordering::SeqCst);
            if result.is_err(){failure.status("Permission needed: Input Monitoring; restart Typerelay after granting access");failure.reset();}
        });
    }
}
#[link(name="Carbon",kind="framework")]
unsafe extern "C" {fn IsSecureEventInputEnabled()->bool;}

#[link(name="Carbon",kind="framework")]
unsafe extern "C" {fn TISCopyCurrentKeyboardInputSource()->Ref;fn TISGetInputSourceProperty(source:Ref,key:Ref)->Ref;static kTISPropertyInputSourceID:Ref;static kTISPropertyInputSourceType:Ref;}
#[link(name="CoreGraphics",kind="framework")]
unsafe extern "C" {fn CGWindowListCopyWindowInfo(options:u32,relative:u32)->Ref;}
#[link(name="CoreFoundation",kind="framework")]
unsafe extern "C" {fn CFArrayGetCount(array:Ref)->isize;fn CFArrayGetValueAtIndex(array:Ref,index:isize)->Ref;fn CFDictionaryGetValue(dictionary:Ref,key:Ref)->Ref;fn CFNumberGetValue(number:Ref,kind:i32,value:*mut c_void)->bool;}
