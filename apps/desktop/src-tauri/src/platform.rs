use anyhow::Result;
#[cfg(not(target_os="linux"))]
use anyhow::ensure;
#[cfg(target_os="macos")]
use anyhow::Context;
#[cfg(target_os = "linux")]
#[path = "platform_linux.rs"] mod native;
#[cfg(target_os = "macos")]
#[path = "platform_macos.rs"] mod native;
#[cfg(target_os = "windows")]
#[path = "platform_windows.rs"] mod native;
pub use native::{Target,fallback_allowed};
#[cfg(target_os = "windows")]
pub use native::{ExpansionRequest, ExpansionSession};

pub fn accessibility(prompt:bool)->bool { #[cfg(target_os="macos")] {native::accessibility(prompt)} #[cfg(not(target_os="macos"))] {let _=prompt;true} }
pub fn open_accessibility_settings()->Result<()> { #[cfg(target_os="macos")] {native::open_accessibility_settings()} #[cfg(not(target_os="macos"))] {anyhow::bail!("Accessibility settings are available on macOS")} }
pub fn open_tui()->Result<()> { #[cfg(target_os="macos")] {native::open_tui()} #[cfg(not(target_os="macos"))] {anyhow::bail!("Open TypeRelay TUI from your application launcher")} }

pub fn copy(text: String) -> Result<()> {
    #[cfg(target_os = "linux")]
    { typerelay_client::clipboard::PasteJob::copy_text(text) }
    #[cfg(not(target_os = "linux"))]
    { use clipboard_rs::Clipboard; clipboard_rs::ClipboardContext::new().map_err(|e|anyhow::anyhow!("{e}"))?.set_text(text).map_err(|e|anyhow::anyhow!("{e}")) }
}

#[cfg(not(target_os = "linux"))]
pub fn paste(target: &Target, erase: usize, text: Option<String>) -> Result<()> {
    #[cfg(target_os="macos")]
    use enigo::{Enigo, Keyboard, Key, Direction};
    use std::time::{Duration, Instant};
    #[cfg(target_os="macos")]
    let mut enigo = Enigo::new(&enigo::Settings::default()).context("Allow TypeRelay accessibility/input permission")?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while native::keys_down() { ensure!(Instant::now() < deadline, "Release shortcut keys before inserting"); std::thread::sleep(Duration::from_millis(10)); }
    ensure!(target.focused()?, "Original window lost focus; nothing inserted");
    #[cfg(target_os="windows")]
    if target.replace_text(erase,text.as_deref().unwrap_or("\n"))?{return Ok(());}
    let mut clipboard=None;let has_text=text.is_some();
    if let Some(text)=text {
        #[cfg(target_os="windows")]
        let preserve=!native::remote_session();
        #[cfg(target_os="macos")]
        let preserve=true;
        if !preserve{copy(text)?;}else{match native::ClipboardLease::publish(text.clone()){Ok(lease)=>clipboard=Some(lease),Err(_error)=>{
        #[cfg(target_os="windows")]
        {copy(text)?;}
        #[cfg(not(target_os="windows"))]
        {return Err(_error);}
    }}}
    }
    let insertion: Result<()> = (|| {
        ensure!(target.focused()?, "Original window lost focus; nothing inserted");
        #[cfg(target_os="windows")]
        {native::insert(target,erase,has_text)?;std::thread::sleep(Duration::from_millis(if has_text{350}else{100}));Ok(())}
        #[cfg(target_os="macos")]
        {
        for _ in 0..erase { enigo.key(Key::Backspace,Direction::Click)?; }
        if !has_text { enigo.key(Key::Return,Direction::Click)?; std::thread::sleep(Duration::from_millis(100)); return Ok(()); }
        enigo.key(Key::Meta,Direction::Press)?;
        let result = enigo.key(Key::Unicode('v'),Direction::Click);
        let released = enigo.key(Key::Meta,Direction::Release);
        result?; released?;
        std::thread::sleep(Duration::from_millis(350)); Ok(())
        }
    })();
    if let Some(clipboard)=&mut clipboard { clipboard.restore()?; }
    insertion
}
