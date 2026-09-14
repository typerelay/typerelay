use anyhow::{Context,Result,ensure};
use objc2_app_kit::{NSWorkspace,NSRunningApplication,NSApplicationActivationOptions};
use std::{ffi::{c_void,CString},process::Command,sync::Arc};
type Ref = *const c_void;
#[link(name="ApplicationServices",kind="framework")]
unsafe extern "C" { fn AXIsProcessTrusted() -> bool; fn AXUIElementCreateApplication(pid:i32)->Ref; fn AXUIElementCopyAttributeValue(element:Ref,attribute:Ref,value:*mut Ref)->i32; fn AXUIElementPerformAction(element:Ref,action:Ref)->i32; fn AXValueGetValue(value:Ref,kind:i32,result:*mut c_void)->bool; fn CGEventSourceKeyState(source:i32,key:u16)->bool; }
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
pub fn open_accessibility_settings()->Result<()> { let status=Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status()?;ensure!(status.success(),"Could not open Accessibility settings");Ok(()) }
pub fn open_tui()->Result<()> { let executable=std::env::current_exe()?.with_file_name("typerelay-tui");ensure!(executable.is_file(),"TypeRelay TUI is missing from this application");let status=Command::new("/usr/bin/open").arg(executable).status()?;ensure!(status.success(),"Could not open TypeRelay TUI");Ok(()) }

pub struct ClipboardLease { context:clipboard_rs::ClipboardContext, saved:Vec<clipboard_rs::ClipboardContent>, marker:Vec<u8>, active:bool }
impl ClipboardLease {
    pub fn publish(text:String)->Result<Self> {
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
        if let Err(error)=lease.context.set(vec![ClipboardContent::Text(text),ClipboardContent::Other("com.typerelay.clipboard-owner".into(),lease.marker.clone())]) {let saved=std::mem::take(&mut lease.saved);let _=lease.context.set(saved);lease.active=false;return Err(anyhow::anyhow!("Clipboard write failed: {error}"));}
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
