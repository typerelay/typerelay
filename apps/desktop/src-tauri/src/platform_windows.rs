use anyhow::{Result, ensure};
use windows::Win32::{Foundation::{HWND,RECT}, UI::{WindowsAndMessaging::{GetForegroundWindow,GetWindowRect,GetClassNameW,GetWindowThreadProcessId,SetForegroundWindow,IsWindow}, Input::KeyboardAndMouse::GetAsyncKeyState}};
#[derive(Clone,Debug)]
pub struct Target { handle: isize, pid: u32, pub bounds: Option<(i32,i32,u32,u32)> }
impl Target {
    pub fn capture() -> Result<Self> { unsafe { let window = GetForegroundWindow(); let mut pid=0; GetWindowThreadProcessId(window,Some(&mut pid)); ensure!(!window.0.is_null() && pid != std::process::id(),"Choose another application first"); let mut class=[0u16;256]; let len=GetClassNameW(window,&mut class); let class=String::from_utf16_lossy(&class[..len as usize]); ensure!(!["Shell_TrayWnd","NotifyIconOverflowWindow","#32768"].contains(&class.as_str()),"Tray has focus"); let mut rect=RECT::default(); GetWindowRect(window,&mut rect)?; Ok(Self { handle: window.0 as isize,pid,bounds:Some((rect.left,rect.top,(rect.right-rect.left).max(1) as u32,(rect.bottom-rect.top).max(1) as u32)) }) } }
    fn valid(&self) -> bool { unsafe { let hwnd=HWND(self.handle as *mut _); let mut pid=0; GetWindowThreadProcessId(hwnd,Some(&mut pid)); IsWindow(Some(hwnd)).as_bool() && pid == self.pid } }
    pub fn restore(&self) -> Result<()> { ensure!(self.valid(),"Original window closed"); unsafe { let _ = SetForegroundWindow(HWND(self.handle as *mut _)); } for _ in 0..40 { if self.focused()? { return Ok(()); } std::thread::sleep(std::time::Duration::from_millis(15)); } anyhow::bail!("Windows refused focus restoration; use Copy") }
    pub fn focused(&self) -> Result<bool> { Ok(self.valid() && unsafe { GetForegroundWindow().0 as isize == self.handle }) }
}
pub fn keys_down() -> bool { [0x10,0x11,0x12,0x5b,0x5c,0x0d,0xbc].iter().any(|key|unsafe { GetAsyncKeyState(*key) < 0 }) }
