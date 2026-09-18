use anyhow::{Context,Result,ensure};
use core_foundation::runloop::CFRunLoop;
use core_graphics::{event::{CallbackResult,CGEvent,CGEventFlags,CGEventTap,CGEventTapLocation,CGEventTapOptions,CGEventTapPlacement,CGEventType,EventField,KeyCode},event_source::{CGEventSource,CGEventSourceStateID},geometry::CGPoint};
use foreign_types::ForeignType;
use objc2_app_kit::{NSWorkspace,NSRunningApplication,NSApplicationActivationOptions};
use std::{ffi::{c_void,CString},mem,process::Command,sync::{Arc,Mutex,mpsc::{Receiver,SyncSender,sync_channel}},time::{Duration,Instant}};
use typerelay_client::{database::DatabaseSnapshot,settings::SettingsStore};
use typerelay_core::{Engine,Expansion,Input};
use objc2_foundation::NSObjectProtocol;
use objc2_user_notifications::UNUserNotificationCenterDelegate;
type Ref = *const c_void;
objc2::define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    struct NativeNotificationDelegate;
    unsafe impl NSObjectProtocol for NativeNotificationDelegate {}
    unsafe impl UNUserNotificationCenterDelegate for NativeNotificationDelegate {
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
    pub fn allowed()->Option<bool> {
        use objc2_user_notifications::{UNAuthorizationStatus,UNNotificationSetting,UNNotificationSettings,UNUserNotificationCenter};
        let(sender,receiver)=std::sync::mpsc::sync_channel(1);
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block2::RcBlock::new(move|settings:std::ptr::NonNull<UNNotificationSettings>|{let settings=unsafe{settings.as_ref()};let _=sender.send(settings.authorizationStatus()==UNAuthorizationStatus::Authorized&&settings.alertSetting()==UNNotificationSetting::Enabled);}));
        receiver.recv_timeout(Duration::from_secs(2)).ok()
    }
    pub fn open_settings()->Result<()> {let status=Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.notifications").status()?;ensure!(status.success(),"Could not open Notifications settings");Ok(())}
    pub fn show(message:&str,error:bool)->Result<()> {
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
        let request=UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&uuid::Uuid::new_v4().to_string()),&content,None);
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
pub fn open_url(url:&str)->Result<()> { let status=Command::new("/usr/bin/open").arg(url).status()?;ensure!(status.success(),"Could not open the TypeRelay web app");Ok(()) }
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
struct ExpansionState { store:DatabaseSnapshot,settings:SettingsStore,engine:Engine,target:Option<Target>,sender:SyncSender<ExpansionRequest>,release:Option<SyncSender<()>>,deferred:Option<DeferredInput>,reloaded:Instant }
impl ExpansionState {
    fn new(directory:&std::path::Path,settings_path:std::path::PathBuf,sender:SyncSender<ExpansionRequest>)->Result<Self>{let store=DatabaseSnapshot::open(directory)?;let settings=SettingsStore::open(settings_path)?;let mut engine=Engine::new(store.snapshot.clone());engine.set_prefix(&settings.settings.trigger_prefix).map_err(anyhow::Error::msg)?;Ok(Self{store,settings,engine,target:None,sender,release:None,deferred:None,reloaded:Instant::now()})}
    fn reload(&mut self){
        if self.reloaded.elapsed()<Duration::from_millis(500){return;}
        self.reloaded=Instant::now();
        if let Ok(Some(snapshot))=self.store.reload(){self.engine.replace_snapshot(snapshot);self.target=None;}
        if let Ok(true)=self.settings.reload(){let _=self.engine.set_prefix(&self.settings.settings.trigger_prefix);self.target=None;}
    }
    fn character(key:u16)->Option<char>{match key{0=>Some('a'),1=>Some('s'),2=>Some('d'),3=>Some('f'),4=>Some('h'),5=>Some('g'),6=>Some('z'),7=>Some('x'),8=>Some('c'),9=>Some('v'),11=>Some('b'),12=>Some('q'),13=>Some('w'),14=>Some('e'),15=>Some('r'),16=>Some('y'),17=>Some('t'),18=>Some('1'),19=>Some('2'),20=>Some('3'),21=>Some('4'),22=>Some('6'),23=>Some('5'),24=>Some('='),25=>Some('9'),26=>Some('7'),27=>Some('-'),28=>Some('8'),29=>Some('0'),30=>Some(']'),31=>Some('o'),32=>Some('u'),33=>Some('['),34=>Some('i'),35=>Some('p'),37=>Some('l'),38=>Some('j'),39=>Some('\''),40=>Some('k'),41=>Some(';'),42=>Some('\\'),43=>Some(','),44=>Some('/'),45=>Some('n'),46=>Some('m'),47=>Some('.'),50=>Some('`'),_=>None}}
    fn input(event:&CGEvent,key:u16)->Input{match key{51=>Input::Backspace,49=>Input::Space,_=>{let mut buffer=[0u16;8];let mut length=0;unsafe{CGEventKeyboardGetUnicodeString(event.as_ptr(),buffer.len(),&mut length,buffer.as_mut_ptr());}let value=String::from_utf16_lossy(&buffer[..length.min(buffer.len())]);let mut characters=value.chars();let character=characters.next().or_else(||Self::character(key));let Some(character)=character else{return Input::Cancel;};if characters.next().is_some(){Input::Cancel}else{Input::Character(character)}}}}
    fn event(&mut self,event_type:CGEventType,event:&CGEvent)->bool {
        if (event.location().x+27469.).abs()<0.001{return false;}
        if self.deferred.as_ref().is_some_and(DeferredInput::finished){self.deferred=None;}
        let key=event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
        if matches!(event_type,CGEventType::KeyUp){
            if key==KeyCode::SPACE&&let Some(release)=self.release.take(){let _=release.try_send(());return false;}
            if let Some(deferred)=&self.deferred{return deferred.capture(event_type,event);}
            return false;
        }
        if let Some(deferred)=&self.deferred {if matches!(event_type,CGEventType::KeyDown){return deferred.capture(event_type,event);}deferred.cancel();}
        if !matches!(event_type,CGEventType::KeyDown){self.engine.feed(Input::Cancel);self.target=None;return false;}
        self.reload();
        let modifiers=event.get_flags();
        if modifiers.intersects(CGEventFlags::CGEventFlagCommand|CGEventFlags::CGEventFlagControl|CGEventFlags::CGEventFlagAlternate|CGEventFlags::CGEventFlagShift|CGEventFlags::CGEventFlagAlphaShift){self.engine.feed(Input::Cancel);self.target=None;return false;}
        let input=Self::input(event,key);
        if matches!(input,Input::Character(character)if character==self.engine.prefix()){self.target=Target::capture().ok();}
        if self.target.is_none(){self.engine.feed(Input::Cancel);return false;}
        if let Some(mut expansion)=self.engine.feed(input)&&let Some(target)=self.target.take()&&target.focused().ok()==Some(true){expansion.erase+=1;let (release,released)=sync_channel(1);let deferred=DeferredInput::new();if self.sender.try_send(ExpansionRequest{target,expansion,released,deferred:deferred.clone()}).is_ok(){self.release=Some(release);self.deferred=Some(deferred);}}
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
