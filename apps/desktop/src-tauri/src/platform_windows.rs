use anyhow::{Context, Result, ensure};
use std::{cell::RefCell,path::PathBuf,sync::{Arc,mpsc::{Receiver,SyncSender,sync_channel}},os::windows::io::{OwnedHandle,FromRawHandle},time::Duration};
use typerelay_client::{database::DatabaseSnapshot,settings::SettingsStore};
use typerelay_core::{Engine,Expansion,Input,FeedResult};
use typerelay_client::browser_lease::BrowserLease;
use windows::Win32::System::Threading::{OpenProcess,PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::System::{Com::{DVASPECT_CONTENT,FORMATETC,IDataObject,STGMEDIUM,TYMED_HGLOBAL},Memory::{GlobalLock,GlobalSize,GlobalUnlock},Ole::{OleGetClipboard,OleInitialize,OleUninitialize,ReleaseStgMedium}};
use windows::Win32::{Foundation::{HWND,LPARAM,LRESULT,RECT,WPARAM}, UI::{WindowsAndMessaging::{CallNextHookEx,DispatchMessageW,GetForegroundWindow,GetGUIThreadInfo,GetMessageW,GetSystemMetrics,GetWindowRect,GetWindowTextW,GetClassNameW,GetWindowThreadProcessId,IsWindow,KBDLLHOOKSTRUCT,KillTimer,MSG,SendMessageTimeoutW,SetForegroundWindow,SetTimer,SetWindowsHookExW,TranslateMessage,UnhookWindowsHookEx,WH_KEYBOARD_LL,WH_MOUSE_LL,WM_KEYDOWN,WM_KEYUP,WM_SYSKEYDOWN,WM_SYSKEYUP,WM_LBUTTONDOWN,WM_RBUTTONDOWN,WM_MBUTTONDOWN,WM_XBUTTONDOWN,WM_TIMER,GUITHREADINFO,HHOOK,SMTO_ABORTIFHUNG,SM_REMOTESESSION}, Input::KeyboardAndMouse::{GetAsyncKeyState,GetKeyboardLayout,GetKeyboardState,SendInput,ToUnicodeEx,INPUT,INPUT_0,INPUT_KEYBOARD,KEYBDINPUT,KEYEVENTF_KEYUP,VIRTUAL_KEY,VK_BACK,VK_CONTROL,VK_LWIN,VK_MENU,VK_RETURN,VK_RWIN,VK_SHIFT,VK_V}}};
const TYPERELAY_EVENT_MARKER:usize=0x5452_4c59;
#[derive(Clone,Debug)]
pub struct Target { handle: isize, pid: u32, class:String, _process: Arc<OwnedHandle>, pub bounds: Option<(i32,i32,u32,u32)> }
impl Target {
    pub fn capture() -> Result<Self> { unsafe { let window = GetForegroundWindow(); let mut pid=0; GetWindowThreadProcessId(window,Some(&mut pid)); ensure!(!window.0.is_null() && pid != std::process::id(),"Choose another application first"); let mut class=[0u16;256]; let len=GetClassNameW(window,&mut class); let class=String::from_utf16_lossy(&class[..len as usize]); ensure!(!["Shell_TrayWnd","NotifyIconOverflowWindow","#32768"].contains(&class.as_str()),"Tray has focus");let mut title=[0u16;256];let length=GetWindowTextW(window,&mut title);ensure!(!String::from_utf16_lossy(&title[..length.max(0) as usize]).starts_with("TypeRelay TUI"),"Expansion is paused in TypeRelay TUI"); let mut rect=RECT::default(); GetWindowRect(window,&mut rect)?; let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)?; let process=OwnedHandle::from_raw_handle(process.0); Ok(Self { handle: window.0 as isize,pid,class,_process:Arc::new(process),bounds:Some((rect.left,rect.top,(rect.right-rect.left).max(1) as u32,(rect.bottom-rect.top).max(1) as u32)) }) } }
    fn valid(&self) -> bool { unsafe { let hwnd=HWND(self.handle as *mut _); let mut pid=0; GetWindowThreadProcessId(hwnd,Some(&mut pid)); IsWindow(Some(hwnd)).as_bool() && pid == self.pid } }
    pub fn restore(&self) -> Result<()> { ensure!(self.valid(),"Original window closed"); unsafe { let _ = SetForegroundWindow(HWND(self.handle as *mut _)); } for _ in 0..40 { if self.focused()? { return Ok(()); } std::thread::sleep(std::time::Duration::from_millis(15)); } anyhow::bail!("Windows refused focus restoration; use Copy") }
    pub fn focused(&self) -> Result<bool> { Ok(self.valid() && unsafe { GetForegroundWindow().0 as isize == self.handle }) }
    pub fn replace_text(&self,erase:usize,text:&str)->Result<bool> {
        if self.class!="Notepad"{return Ok(false);}
        ensure!(self.focused()?,"Original window lost focus");
        let window=HWND(self.handle as *mut _);let thread=unsafe{GetWindowThreadProcessId(window,None)};let mut info=GUITHREADINFO{cbSize:std::mem::size_of::<GUITHREADINFO>() as u32,..Default::default()};unsafe{GetGUIThreadInfo(thread,&mut info)?;}
        let mut class=[0u16;256];let length=unsafe{GetClassNameW(info.hwndFocus,&mut class)};let class=String::from_utf16_lossy(&class[..length.max(0) as usize]);ensure!(class=="RichEditD2DPT"||class=="Edit","Notepad text editor does not have focus");
        let mut start=0u32;let mut end=0u32;
        ensure!(unsafe{SendMessageTimeoutW(info.hwndFocus,0x00b0,WPARAM(&mut start as *mut u32 as usize),LPARAM(&mut end as *mut u32 as isize),SMTO_ABORTIFHUNG,500,None)}.0!=0,"Cannot read Notepad selection");
        ensure!(erase==0||(start==end&&start as usize>=erase),"Notepad caret changed; abbreviation kept");
        if erase>0{ensure!(unsafe{SendMessageTimeoutW(info.hwndFocus,0x00b1,WPARAM(start as usize-erase),LPARAM(end as isize),SMTO_ABORTIFHUNG,500,None)}.0!=0,"Cannot select abbreviation");}
        let text:Vec<u16>=text.replace("\r\n","\n").replace('\n',"\r\n").encode_utf16().chain(Some(0)).collect();
        ensure!(unsafe{SendMessageTimeoutW(info.hwndFocus,0x00c2,WPARAM(1),LPARAM(text.as_ptr() as isize),SMTO_ABORTIFHUNG,500,None)}.0!=0,"Notepad did not accept replacement");
        Ok(true)
    }
}
pub fn keys_down() -> bool { [0x10,0x11,0x12,0x5b,0x5c,0x0d,0x20,0xba,0xbc].iter().any(|key|unsafe { GetAsyncKeyState(*key) < 0 }) }
pub fn remote_session()->bool {unsafe{GetSystemMetrics(SM_REMOTESESSION)!=0}}
pub fn insert(target:&Target,erase:usize,paste:bool)->Result<()>{ensure!(target.focused()?,"Original window lost focus");fn key(key:VIRTUAL_KEY,up:bool)->INPUT{INPUT{r#type:INPUT_KEYBOARD,Anonymous:INPUT_0{ki:KEYBDINPUT{wVk:key,dwFlags:if up{KEYEVENTF_KEYUP}else{Default::default()},dwExtraInfo:TYPERELAY_EVENT_MARKER,..Default::default()}}}}fn send(input:&[INPUT])->Result<()>{let sent=unsafe{SendInput(input,std::mem::size_of::<INPUT>() as i32)};ensure!(sent as usize==input.len(),"Windows rejected native input");Ok(())}let mut removal=Vec::with_capacity(erase*2);for _ in 0..erase{removal.extend([key(VK_BACK,false),key(VK_BACK,true)]);}if !removal.is_empty(){send(&removal)?;std::thread::sleep(Duration::from_millis(30));}
    if paste{send(&[key(VK_CONTROL,false),key(VK_V,false),key(VK_V,true),key(VK_CONTROL,true)])}else{send(&[key(VK_RETURN,false),key(VK_RETURN,true)])}}
pub fn fallback_allowed()->bool { unsafe { let window=GetForegroundWindow();let mut pid=0;GetWindowThreadProcessId(window,Some(&mut pid));let mut class=[0u16;256];let length=GetClassNameW(window,&mut class);pid==std::process::id() || ["Shell_TrayWnd","NotifyIconOverflowWindow","#32768"].contains(&String::from_utf16_lossy(&class[..length as usize]).as_str()) } }
pub fn open_url(url:&str)->Result<()> { std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler",url]).spawn().context("Could not open link")?;Ok(()) }
pub fn open_tui()->Result<()> { let executable=std::env::current_exe()?.with_file_name("typerelay-tui.exe");ensure!(executable.is_file(),"TypeRelay TUI is missing from this installation");std::process::Command::new(executable).spawn().context("Could not open TypeRelay TUI")?;Ok(()) }

pub struct ExpansionRequest { pub target:Target, pub expansion:Expansion, pub released:Receiver<()> }
struct HookState { store:DatabaseSnapshot, settings:SettingsStore, engine:Engine, target:Option<Target>, sender:SyncSender<ExpansionRequest>, suppress_space:Option<SyncSender<()>>, suppress_right:bool, right_forwarded:bool }
thread_local! { static HOOK_STATE:RefCell<Option<HookState>>=const{RefCell::new(None)}; }
impl HookState {
    fn new(directory:PathBuf,settings_path:PathBuf,sender:SyncSender<ExpansionRequest>)->Result<Self>{let store=DatabaseSnapshot::open(&directory)?;let settings=SettingsStore::open(settings_path)?;let mut engine=Engine::new(store.snapshot.clone());engine.set_prefix(&settings.settings.trigger_prefix).map_err(anyhow::Error::msg)?;Ok(Self{store,settings,engine,target:None,sender,suppress_space:None,suppress_right:false,right_forwarded:false})}
    fn input(vk:u32,scan:u32)->Input {match vk{0x08=>Input::Backspace,0x2e=>Input::Delete,0x25=>Input::Left,0x27=>Input::Right,0x20=>Input::Space,_=>unsafe{let window=GetForegroundWindow();let thread=GetWindowThreadProcessId(window,None);let layout=GetKeyboardLayout(thread);let mut state=[0u8;256];if GetKeyboardState(&mut state).is_err(){return Input::Cancel;}
        for modifier in [0x10usize,0x11,0x12]{state[modifier]=(state[modifier]&1)|if GetAsyncKeyState(modifier as i32)<0{0x80}else{0};}if let Some(key)=state.get_mut(vk as usize){*key|=0x80;}let mut buffer=[0u16;8];let length=ToUnicodeEx(vk,scan,&state,&mut buffer,5,Some(layout));if length<=0{return Input::Cancel;}let Ok(value)=String::from_utf16(&buffer[..usize::try_from(length).unwrap_or_default().min(buffer.len())])else{return Input::Cancel;};let mut characters=value.chars();let Some(character)=characters.next()else{return Input::Cancel;};if characters.next().is_some(){Input::Cancel}else{Input::Character(character)}}}}
    fn modified()->bool {unsafe{let control=GetAsyncKeyState(VK_CONTROL.0 as i32)<0;let alt=GetAsyncKeyState(VK_MENU.0 as i32)<0;[VK_LWIN,VK_RWIN,VK_SHIFT].iter().any(|key|GetAsyncKeyState(key.0 as i32)<0)||control!=alt}}
    fn key(&mut self,vk:u32,scan:u32,down:bool)->bool {
        if !down {if vk==0x27{if self.suppress_right{self.suppress_right=false;return true;}self.right_forwarded=false;}if vk==0x20&&let Some(released)=self.suppress_space.take(){let _=released.try_send(());return true;}return false;}
		if BrowserLease::active(){self.engine.feed(Input::Cancel);self.target=None;return false;}
        if vk==0x27{if self.suppress_right{return true;}if self.right_forwarded{self.engine.feed(Input::Cancel);self.target=None;return false;}self.right_forwarded=true;}
        if Self::modified(){self.engine.feed(Input::Cancel);self.target=None;return false;}
        if self.target.as_ref().is_some_and(|target|target.focused().ok()!=Some(true)){self.engine.feed(Input::Cancel);self.target=None;}
        let input=Self::input(vk,scan);
        if matches!(input,Input::Character(character)if character==self.engine.prefix()){self.target=Target::capture().ok();}
        if self.target.is_none(){self.engine.feed(Input::Cancel);return false;}
        let result=self.engine.feed_event(input);
        if matches!(result,FeedResult::Suppress){self.right_forwarded=false;self.suppress_right=true;return true;}
        if let FeedResult::Expand(expansion)=result&&let Some(target)=self.target.take()&&target.focused().ok()==Some(true){let (release,released)=sync_channel(1);if self.sender.try_send(ExpansionRequest{target,expansion,released}).is_ok(){self.suppress_space=Some(release);return true;}}
        if matches!(input,Input::Cancel|Input::Space){self.target=None;}
        false
    }
    fn reload(&mut self){
        if let Ok(Some(snapshot))=self.store.reload(){self.engine.replace_snapshot(snapshot);self.target=None;}
        if let Ok(true)=self.settings.reload(){let _=self.engine.set_prefix(&self.settings.settings.trigger_prefix);self.target=None;}
    }
}
struct Hook(HHOOK);
impl Drop for Hook {fn drop(&mut self){unsafe{let _=UnhookWindowsHookEx(self.0);}}}
pub struct ExpansionSession;
impl ExpansionSession {
    pub fn start(directory:PathBuf,settings:PathBuf)->Result<Receiver<ExpansionRequest>>{
        let (sender,receiver)=sync_channel(1);let (ready_sender,ready_receiver)=sync_channel(1);
        std::thread::spawn(move||{let result=Self::run(directory,settings,sender,ready_sender.clone());if let Err(error)=result{let _=ready_sender.try_send(Err(error));}});
        ready_receiver.recv_timeout(Duration::from_secs(3)).context("Windows expansion hook did not start")??;Ok(receiver)
    }
    fn run(directory:PathBuf,settings:PathBuf,sender:SyncSender<ExpansionRequest>,ready:SyncSender<Result<()>>)->Result<()>{
        let state=HookState::new(directory,settings,sender)?;HOOK_STATE.with(|current|current.replace(Some(state)));
        let hook=Hook(unsafe{SetWindowsHookExW(WH_KEYBOARD_LL,Some(Self::callback),None,0)}?);
        let mouse_hook=Hook(unsafe{SetWindowsHookExW(WH_MOUSE_LL,Some(Self::mouse_callback),None,0)}?);
        let timer=unsafe{SetTimer(None,1,500,None)};ensure!(timer!=0,"Cannot start Windows expansion reload timer");
        let _=ready.send(Ok(()));let mut message=MSG::default();
        loop {let result=unsafe{GetMessageW(&mut message,None,0,0)}.0;if result==0{break;}ensure!(result>0,"Windows expansion event loop failed");if message.message==WM_TIMER{HOOK_STATE.with(|state|{if let Ok(mut state)=state.try_borrow_mut()&&let Some(state)=state.as_mut(){state.reload();}});}
            unsafe{let _=TranslateMessage(&message);DispatchMessageW(&message);}
        }
        unsafe{let _=KillTimer(None,timer);}HOOK_STATE.with(|state|state.replace(None));drop(mouse_hook);drop(hook);Ok(())
    }
    unsafe extern "system" fn callback(code:i32,wparam:WPARAM,lparam:LPARAM)->LRESULT {
        if code>=0 {let event=unsafe{&*(lparam.0 as *const KBDLLHOOKSTRUCT)};if event.dwExtraInfo!=TYPERELAY_EVENT_MARKER{let message=wparam.0 as u32;let down=message==WM_KEYDOWN||message==WM_SYSKEYDOWN;let up=message==WM_KEYUP||message==WM_SYSKEYUP;if (down||up)&&HOOK_STATE.with(|state|state.try_borrow_mut().ok().and_then(|mut state|state.as_mut().map(|state|state.key(event.vkCode,event.scanCode,down))).unwrap_or(false)){return LRESULT(1);}}}
        unsafe{CallNextHookEx(None,code,wparam,lparam)}
    }
    unsafe extern "system" fn mouse_callback(code:i32,wparam:WPARAM,lparam:LPARAM)->LRESULT {
        if code>=0&&[WM_LBUTTONDOWN,WM_RBUTTONDOWN,WM_MBUTTONDOWN,WM_XBUTTONDOWN].contains(&(wparam.0 as u32)){HOOK_STATE.with(|state|{if let Ok(mut state)=state.try_borrow_mut()&&let Some(state)=state.as_mut(){state.engine.feed(Input::Cancel);state.target=None;}});}
        unsafe{CallNextHookEx(None,code,wparam,lparam)}
    }
}

struct Ole;
impl Ole {fn enter()->Result<Self>{unsafe{OleInitialize(None).context("Cannot initialize Windows clipboard")?;}Ok(Self)}}
impl Drop for Ole {fn drop(&mut self){unsafe{OleUninitialize();}}}
struct Medium(STGMEDIUM);
impl Drop for Medium {fn drop(&mut self){unsafe{ReleaseStgMedium(&mut self.0);}}}
pub struct ClipboardLease { saved:Vec<(u32,Vec<u8>)>, marker_format:u32, marker:Vec<u8>, active:bool }
impl ClipboardLease {
    fn read(source:&IDataObject,format:u32)->Result<Vec<u8>>{let request=FORMATETC{cfFormat:u16::try_from(format)?,ptd:std::ptr::null_mut(),dwAspect:DVASPECT_CONTENT.0,lindex:-1,tymed:TYMED_HGLOBAL.0 as u32};let medium=Medium(unsafe{source.GetData(&request)}.with_context(||format!("Cannot preserve clipboard format {format}"))?);ensure!(medium.0.tymed==TYMED_HGLOBAL.0 as u32,"Clipboard format {format} is not movable memory");let handle=unsafe{medium.0.u.hGlobal};let size=unsafe{GlobalSize(handle)};ensure!(size>0,"Clipboard format {format} is empty");let pointer=unsafe{GlobalLock(handle)};ensure!(!pointer.is_null(),"Cannot lock clipboard format {format}");let bytes=unsafe{std::slice::from_raw_parts(pointer.cast::<u8>(),size)}.to_vec();let _=unsafe{GlobalUnlock(handle)};Ok(bytes)}
    fn write(saved:&[(u32,Vec<u8>)])->Result<()>{use clipboard_win::raw;for (format,bytes) in saved{raw::set_without_clear(*format,bytes).map_err(|e|anyhow::anyhow!("Clipboard restoration failed for format {format}: {e}"))?;}Ok(())}
	pub fn publish(payload:typerelay_client::clipboard_payload::ClipboardPayload)->Result<Self> {
        use clipboard_win::{Clipboard,raw,options::NoClear};
        let marker_format=clipboard_win::register_format("com.typerelay.clipboard-owner").ok_or_else(||anyhow::anyhow!("Cannot register clipboard marker"))?.get();
        let formats={let _lock=Clipboard::new_attempts(10).map_err(|e|anyhow::anyhow!("Clipboard is busy: {e}"))?;raw::EnumFormats::new().collect::<Vec<_>>()};ensure!(formats.len()<=64,"Too many clipboard formats; use Copy");
        let _ole=Ole::enter()?;let source=if formats.is_empty(){None}else{Some(unsafe{OleGetClipboard()}.context("Cannot preserve Windows clipboard")?)};let mut saved=Vec::new();let mut total=0;
        for format in formats{ensure!([1,7,8,13,15,16,17].contains(&format)||format>=0xc000,"Clipboard contains a native format that cannot be preserved; use Copy");let bytes=Self::read(source.as_ref().unwrap(),format)?;total+=bytes.len();ensure!(total<=16*1024*1024,"Clipboard too large to preserve; use Copy");saved.push((format,bytes));}
        let marker=uuid::Uuid::new_v4().to_string().into_bytes();
		let html_format=clipboard_win::register_format("HTML Format").map(|value|value.get());let rtf_format=clipboard_win::register_format("Rich Text Format").map(|value|value.get());let html=payload.html.map(typerelay_client::clipboard_payload::ClipboardPayload::cf_html);let result=(||->Result<()>{let _lock=Clipboard::new_attempts(10).map_err(|e|anyhow::anyhow!("Clipboard is busy: {e}"))?;raw::empty().map_err(|e|anyhow::anyhow!("Clipboard write failed: {e}"))?;let result=(||{raw::set_string_with(&payload.plain,NoClear)?;if let(Some(format),Some(html))=(html_format,html){let mut bytes=html.into_bytes();bytes.push(0);raw::set_without_clear(format,&bytes)?;}if let(Some(format),Some(rtf))=(rtf_format,payload.rtf){let mut bytes=rtf.into_bytes();bytes.push(0);raw::set_without_clear(format,&bytes)?;}raw::set_without_clear(marker_format,&marker)})();if let Err(error)=result{let _=raw::empty();let _=Self::write(&saved);return Err(anyhow::anyhow!("Clipboard write failed: {error}"));}Ok(())})();result?;
        Ok(Self{saved,marker_format,marker,active:true})
    }
    pub fn restore(&mut self)->Result<()> {
        use clipboard_win::{Clipboard,raw};
        if !self.active{return Ok(());}
        let owned=(||{let _lock=Clipboard::new_attempts(10).map_err(|e|anyhow::anyhow!("Cannot inspect busy clipboard: {e}"))?;let mut marker=Vec::new();Ok::<_,anyhow::Error>(raw::get_vec(self.marker_format,&mut marker).is_ok()&&marker==self.marker)})();
        let result=owned.and_then(|owned|if owned{let _lock=Clipboard::new_attempts(10).map_err(|e|anyhow::anyhow!("Cannot restore busy clipboard: {e}"))?;raw::empty().map_err(|e|anyhow::anyhow!("Cannot clear TypeRelay clipboard: {e}"))?;Self::write(&self.saved)}else{Ok(())});self.active=false;result
    }
}
impl Drop for ClipboardLease {fn drop(&mut self){let _=self.restore();}}

pub struct ObservationAdapter;
struct ObservationKey { epoch:u64,at:i64,edit:typerelay_client::observation::Edit,pid:u32 }
impl ObservationAdapter {
    fn sender()->&'static std::thread::LocalKey<RefCell<Option<(Arc<crate::observation::Observation>,SyncSender<ObservationKey>)>>> {
        thread_local!{static SENDER:RefCell<Option<(Arc<crate::observation::Observation>,SyncSender<ObservationKey>)>>=const{RefCell::new(None)};}&SENDER
    }
    unsafe extern "system" fn keyboard(code:i32,wparam:WPARAM,lparam:LPARAM)->LRESULT {
        use typerelay_client::observation::Edit;use std::sync::atomic::Ordering;
        if code>=0&&(wparam.0 as u32==WM_KEYDOWN||wparam.0 as u32==WM_SYSKEYDOWN){
            let key=unsafe{&*(lparam.0 as *const KBDLLHOOKSTRUCT)};
            Self::sender().with(|cell|if let Some((state,sender))=cell.borrow().as_ref(){
                if !state.enabled.load(Ordering::SeqCst){return;}
                let mut pid=0;unsafe{GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut pid));}
                let modified=[0x11,0x12,0x5b,0x5c].iter().any(|key|unsafe{GetAsyncKeyState(*key)<0});
                let edit=if modified||key.flags.0&0x12!=0||key.dwExtraInfo==TYPERELAY_EVENT_MARKER{Edit::Reset}else{match key.vkCode{0x0d|0x09=>Edit::Boundary,0x08=>Edit::Backspace,0x10|0x14|0xa0|0xa1=>return,_=>match HookState::input(key.vkCode,key.scanCode){Input::Character(c)=>Edit::Text(c.to_string()),Input::Space=>Edit::Text(" ".into()),_=>Edit::Reset}}};
                if sender.try_send(ObservationKey{epoch:state.epoch.load(Ordering::SeqCst),at:crate::observation::Observation::now(),edit,pid}).is_err(){state.reset();}
            });
        }
        unsafe{CallNextHookEx(None,code,wparam,lparam)}
    }
    unsafe extern "system" fn mouse(code:i32,wparam:WPARAM,lparam:LPARAM)->LRESULT {
        if code>=0&&[WM_LBUTTONDOWN,WM_RBUTTONDOWN,WM_MBUTTONDOWN,WM_XBUTTONDOWN].contains(&(wparam.0 as u32)){Self::sender().with(|cell|if let Some((state,sender))=cell.borrow().as_ref(){let epoch=state.epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1;let mut pid=0;unsafe{GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut pid));}let _=sender.try_send(ObservationKey{epoch,at:crate::observation::Observation::now(),edit:typerelay_client::observation::Edit::Reset,pid});state.reset();});}
        unsafe{CallNextHookEx(None,code,wparam,lparam)}
    }
    fn field(automation:&windows::Win32::UI::Accessibility::IUIAutomation)->Result<(windows::Win32::UI::Accessibility::IUIAutomationElement,String,u32)> {
        use windows::Win32::UI::{Accessibility::*,Input::Ime::{ImmIsIME,ImmGetContext,ImmGetCompositionStringW,ImmReleaseContext,GCS_COMPSTR}};use windows::Win32::System::Threading::{QueryFullProcessImageNameW,PROCESS_NAME_WIN32};
        unsafe {
            let thread=GetWindowThreadProcessId(GetForegroundWindow(),None);ensure!(!ImmIsIME(GetKeyboardLayout(thread)).as_bool(),"Input method provenance unavailable");
            let mut gui=GUITHREADINFO{cbSize:std::mem::size_of::<GUITHREADINFO>() as u32,..Default::default()};GetGUIThreadInfo(thread,&mut gui)?;
            let context=ImmGetContext(gui.hwndFocus);if !context.0.is_null(){let composing=ImmGetCompositionStringW(context,GCS_COMPSTR,None,0)>0;let _=ImmReleaseContext(gui.hwndFocus,context);ensure!(!composing,"Uncommitted composition");}
            let field=automation.GetFocusedElement()?;ensure!(field.CurrentHasKeyboardFocus()?.as_bool()&&field.CurrentIsEnabled()?.as_bool()&&!field.CurrentIsPassword()?.as_bool(),"Protected field");
            ensure!([UIA_EditControlTypeId,UIA_DocumentControlTypeId].contains(&field.CurrentControlType()?),"Unsupported field");
            if let Ok(value)=field.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId){ensure!(!value.CurrentIsReadOnly()?.as_bool(),"Read-only field");}
            if let Ok(text)=field.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId){let selected=text.GetSelection()?;ensure!(selected.Length()?==1,"Unknown selection");let range=selected.GetElement(0)?;ensure!(range.CompareEndpoints(TextPatternRangeEndpoint_Start,&range,TextPatternRangeEndpoint_End)?==0,"Selected text");}else{ensure!(field.CurrentControlType()?==UIA_EditControlTypeId,"Unsupported document");}
            let mut pid=0;GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut pid));ensure!(pid!=std::process::id()&&field.CurrentProcessId()?==pid as i32,"Foreground changed");
            let handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)?;let owned=OwnedHandle::from_raw_handle(handle.0);let mut buffer=[0u16;2048];let mut length=buffer.len() as u32;let result=QueryFullProcessImageNameW(handle,PROCESS_NAME_WIN32,windows::core::PWSTR(buffer.as_mut_ptr()),&mut length);drop(owned);result?;
            let path=String::from_utf16(&buffer[..length as usize])?;let app=std::path::Path::new(&path).file_name().context("Unknown application")?.to_string_lossy().to_string();ensure!(typerelay_client::observation::Settings::supported_app(&app),"Terminal application");Ok((field,app,pid))
        }
    }
    fn native_context(automation:&windows::Win32::UI::Accessibility::IUIAutomation)->Result<typerelay_client::observation::CaptureContext>{
        use typerelay_client::observation::{CaptureContext,CaptureSource,Protection};use windows::Win32::System::Threading::{QueryFullProcessImageNameW,PROCESS_NAME_WIN32};
        unsafe{let window=GetForegroundWindow();let mut pid=0;let thread=GetWindowThreadProcessId(window,Some(&mut pid));ensure!(!window.0.is_null()&&pid!=0&&pid!=std::process::id(),"Learning paused in Typerelay or an unidentified window");let handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)?;let owned=OwnedHandle::from_raw_handle(handle.0);let mut buffer=[0u16;2048];let mut length=buffer.len() as u32;let result=QueryFullProcessImageNameW(handle,PROCESS_NAME_WIN32,windows::core::PWSTR(buffer.as_mut_ptr()),&mut length);drop(owned);result?;let path=String::from_utf16(&buffer[..length as usize])?;let app=std::path::Path::new(&path).file_name().context("Unknown app")?.to_string_lossy().into_owned();ensure!(typerelay_client::observation::Settings::supported_app(&app),"Learning paused in this application");
            let mut protection=Protection::Unknown;if let Ok(field)=automation.GetFocusedElement()&&field.CurrentProcessId().ok()==Some(pid as i32){if field.CurrentIsPassword().is_ok_and(|v|v.as_bool()){protection=Protection::Protected;}else if field.CurrentHasKeyboardFocus().is_ok_and(|v|v.as_bool()){protection=Protection::Unprotected;}}
            let layout=GetKeyboardLayout(thread);let ime=windows::Win32::UI::Input::Ime::ImmIsIME(layout).as_bool();Ok(CaptureContext{app,window:format!("{pid}:{}",window.0 as usize),protection,active:true,layout:format!("{}",layout.0 as usize),ime:ime.then_some("Windows IME".into()),authority:if ime{CaptureSource::Ime}else{CaptureSource::Keyboard},..Default::default()})
        }
    }
    pub fn start(state:Arc<crate::observation::Observation>) {
        use windows::Win32::{System::Com::{CoInitializeEx,CoCreateInstance,CoUninitialize,COINIT_MULTITHREADED,CLSCTX_INPROC_SERVER},UI::Accessibility::{CUIAutomation,IUIAutomation}};
        use std::sync::atomic::Ordering;use typerelay_client::observation::Event;
        let(sender,receiver)=sync_channel::<ObservationKey>(128);let capture=state.clone();let running=Arc::new(std::sync::atomic::AtomicBool::new(false));let monitored=running.clone();
        std::thread::spawn(move||unsafe{
            let result=(||->Result<()>{CoInitializeEx(None,COINIT_MULTITHREADED).ok()?;let automation:IUIAutomation=CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER)?;let mut previous=None;let mut generation=0u64;let mut epoch=0;let mut native_previous=None::<typerelay_client::observation::CaptureContext>;let mut native_sequence=0u64;
                loop {let raw=receiver.recv_timeout(Duration::from_millis(30)).ok();if !state.enabled.load(Ordering::SeqCst){previous=None;continue;}
                    if !monitored.load(Ordering::SeqCst){previous=None;state.safety(false);state.status("Unavailable: Windows input monitoring could not start");continue;}
                    let next_epoch=state.epoch.load(Ordering::SeqCst);if next_epoch!=epoch{previous=None;epoch=next_epoch;}
                    if state.native(){
                        use typerelay_client::observation::{CaptureHealth,CaptureSource,Edit,Protection};
                        match Self::native_context(&automation){Ok(mut context)=>{
                            let changed=native_previous.as_ref().is_none_or(|old|old.app!=context.app||old.window!=context.window||old.layout!=context.layout);if changed{if let Some(old)=&native_previous{native_sequence+=1;state.native_event(old.clone(),CaptureSource::Keyboard,native_sequence,if old.layout==context.layout{Edit::Boundary}else{Edit::Reset},crate::observation::Observation::now());}generation+=1;}context.generation=generation;
                            state.native_health(CaptureHealth{desktop:"windows".into(),layout:context.layout.clone(),app:Some(context.app.clone()),ime:context.ime.clone(),source:"keyboard".into(),blocked:if context.protection==Protection::Protected{Some("Learning paused in a protected field".into())}else if context.ime.is_some(){Some("IME active: verified composition integration required".into())}else{None},at_ms:crate::observation::Observation::now(),..Default::default()});
                            if let Some(raw)=raw&&raw.epoch==epoch&&crate::observation::Observation::now()-raw.at<250{let mut pid=0;GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut pid));if raw.pid==pid{native_sequence+=1;state.native_event(context.clone(),CaptureSource::Keyboard,native_sequence,raw.edit,raw.at);}}
                            native_previous=Some(context);
                        },Err(error)=>{if let Some(old)=native_previous.take(){native_sequence+=1;state.native_event(old,CaptureSource::Keyboard,native_sequence,Edit::Reset,crate::observation::Observation::now());}state.native_health(CaptureHealth{desktop:"windows".into(),blocked:Some(error.to_string()),at_ms:crate::observation::Observation::now(),..Default::default()});}}
                        continue;
                    }
                    let current=Self::field(&automation).ok();state.safety(current.is_some());let same=previous.as_ref().zip(current.as_ref()).is_some_and(|(old,new):(&(windows::Win32::UI::Accessibility::IUIAutomationElement,String,u32),&_)|automation.CompareElements(&old.0,&new.0).is_ok_and(|value|value.as_bool())&&old.2==new.2);
                    if !same{generation+=1;state.reset();}
                    if let Some(raw)=raw&&same&&raw.epoch==epoch&&crate::observation::Observation::now()-raw.at<250 {let (_,app,pid)=current.as_ref().unwrap();if raw.pid==*pid{state.feed(Event{epoch,field:format!("{pid}:{generation}"),app:app.clone(),safe:true,direct:true,edit:raw.edit});}else{state.reset();}}
                    state.status(if current.is_some(){"Active"}else{"Waiting for a supported editable field"});previous=current;
                }
            })();if result.is_err(){state.status("Unavailable: Windows accessibility could not start");state.reset();}CoUninitialize();
        });
        std::thread::spawn(move||{
            Self::sender().with(|cell|cell.replace(Some((capture.clone(),sender))));
            let result=(||->Result<()>{let _keyboard=Hook(unsafe{SetWindowsHookExW(WH_KEYBOARD_LL,Some(Self::keyboard),None,0)}?);let _mouse=Hook(unsafe{SetWindowsHookExW(WH_MOUSE_LL,Some(Self::mouse),None,0)}?);running.store(true,Ordering::SeqCst);let mut message=MSG::default();while unsafe{GetMessageW(&mut message,None,0,0)}.as_bool(){unsafe{let _=TranslateMessage(&message);DispatchMessageW(&message);}}Ok(())})();
            running.store(false,Ordering::SeqCst);
            if result.is_err(){capture.status("Unavailable: Windows input monitoring could not start");capture.reset();}
        });
    }
}
