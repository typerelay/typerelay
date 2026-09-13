use anyhow::{Context,Result,ensure};
use objc2_app_kit::{NSWorkspace,NSRunningApplication,NSApplicationActivationOptions};
use std::{ffi::{c_void,CString},sync::Arc};
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
