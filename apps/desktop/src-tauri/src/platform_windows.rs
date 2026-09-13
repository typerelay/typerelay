use anyhow::{Result, ensure};
use std::{sync::Arc,os::windows::io::{OwnedHandle,FromRawHandle}};
use windows::Win32::System::Threading::{OpenProcess,PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::{Foundation::{HWND,RECT}, UI::{WindowsAndMessaging::{GetForegroundWindow,GetWindowRect,GetClassNameW,GetWindowThreadProcessId,SetForegroundWindow,IsWindow}, Input::KeyboardAndMouse::GetAsyncKeyState}};
#[derive(Clone,Debug)]
pub struct Target { handle: isize, pid: u32, _process: Arc<OwnedHandle>, pub bounds: Option<(i32,i32,u32,u32)> }
impl Target {
    pub fn capture() -> Result<Self> { unsafe { let window = GetForegroundWindow(); let mut pid=0; GetWindowThreadProcessId(window,Some(&mut pid)); ensure!(!window.0.is_null() && pid != std::process::id(),"Choose another application first"); let mut class=[0u16;256]; let len=GetClassNameW(window,&mut class); let class=String::from_utf16_lossy(&class[..len as usize]); ensure!(!["Shell_TrayWnd","NotifyIconOverflowWindow","#32768"].contains(&class.as_str()),"Tray has focus"); let mut rect=RECT::default(); GetWindowRect(window,&mut rect)?; let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)?; let process=OwnedHandle::from_raw_handle(process.0); Ok(Self { handle: window.0 as isize,pid,_process:Arc::new(process),bounds:Some((rect.left,rect.top,(rect.right-rect.left).max(1) as u32,(rect.bottom-rect.top).max(1) as u32)) }) } }
    fn valid(&self) -> bool { unsafe { let hwnd=HWND(self.handle as *mut _); let mut pid=0; GetWindowThreadProcessId(hwnd,Some(&mut pid)); IsWindow(Some(hwnd)).as_bool() && pid == self.pid } }
    pub fn restore(&self) -> Result<()> { ensure!(self.valid(),"Original window closed"); unsafe { let _ = SetForegroundWindow(HWND(self.handle as *mut _)); } for _ in 0..40 { if self.focused()? { return Ok(()); } std::thread::sleep(std::time::Duration::from_millis(15)); } anyhow::bail!("Windows refused focus restoration; use Copy") }
    pub fn focused(&self) -> Result<bool> { Ok(self.valid() && unsafe { GetForegroundWindow().0 as isize == self.handle }) }
}
pub fn keys_down() -> bool { [0x10,0x11,0x12,0x5b,0x5c,0x0d,0xbc].iter().any(|key|unsafe { GetAsyncKeyState(*key) < 0 }) }
pub fn fallback_allowed()->bool { unsafe { let window=GetForegroundWindow();let mut pid=0;GetWindowThreadProcessId(window,Some(&mut pid));let mut class=[0u16;256];let length=GetClassNameW(window,&mut class);pid==std::process::id() || ["Shell_TrayWnd","NotifyIconOverflowWindow","#32768"].contains(&String::from_utf16_lossy(&class[..length as usize]).as_str()) } }

pub struct ClipboardLease { saved:Vec<(u32,Vec<u8>)>, marker_format:u32, marker:Vec<u8>, active:bool }
impl ClipboardLease {
    pub fn publish(text:String)->Result<Self> {
        use clipboard_win::{Clipboard,raw,options::NoClear};
        let _lock=Clipboard::new_attempts(10).map_err(|e|anyhow::anyhow!("Clipboard is busy: {e}"))?;
        let formats:Vec<_>=raw::EnumFormats::new().collect();
        ensure!(formats.len()<=64,"Too many clipboard formats; use Copy");
        let mut saved=Vec::new();let mut total=0;
        for format in formats {
            ensure!([1,7,8,13,15,16,17].contains(&format) || format>=0xc000,"Clipboard contains a native format that cannot be preserved; use Copy");
            total+=raw::size(format).map(|size|size.get()).unwrap_or(0);ensure!(total<=16*1024*1024,"Clipboard too large to preserve; use Copy");
            let mut bytes=Vec::new();raw::get_vec(format,&mut bytes).map_err(|e|anyhow::anyhow!("Cannot preserve clipboard format {format}: {e}"))?;
            saved.push((format,bytes));
        }
        let marker_format=clipboard_win::register_format("com.typerelay.clipboard-owner").ok_or_else(||anyhow::anyhow!("Cannot register clipboard marker"))?.get();
        let marker=uuid::Uuid::new_v4().to_string().into_bytes();
        let result=(||{raw::empty()?;raw::set_string_with(&text,NoClear)?;raw::set_without_clear(marker_format,&marker)})();
        if let Err(error)=result {let _=raw::empty();for (format,bytes) in &saved{let _=raw::set_without_clear(*format,bytes);}return Err(anyhow::anyhow!("Clipboard write failed: {error}"));}
        Ok(Self{saved,marker_format,marker,active:true})
    }
    pub fn restore(&mut self)->Result<()> {
        use clipboard_win::{Clipboard,raw};
        if !self.active{return Ok(());}
        let _lock=Clipboard::new_attempts(10).map_err(|e|anyhow::anyhow!("Cannot restore busy clipboard: {e}"))?;
        let mut marker=Vec::new();
        if raw::get_vec(self.marker_format,&mut marker).is_ok() && marker==self.marker {raw::empty().map_err(|e|anyhow::anyhow!("{e}"))?;for (format,bytes) in &self.saved{raw::set_without_clear(*format,bytes).map_err(|e|anyhow::anyhow!("Clipboard restoration failed: {e}"))?;}}
        self.active=false;Ok(())
    }
}
impl Drop for ClipboardLease {fn drop(&mut self){let _=self.restore();}}
