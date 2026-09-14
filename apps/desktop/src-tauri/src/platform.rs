use anyhow::Result;
#[cfg(not(target_os="linux"))]
use anyhow::{Context, ensure};
#[cfg(target_os = "linux")]
#[path = "platform_linux.rs"] mod native;
#[cfg(target_os = "macos")]
#[path = "platform_macos.rs"] mod native;
#[cfg(target_os = "windows")]
#[path = "platform_windows.rs"] mod native;
pub use native::{Target,fallback_allowed};
#[cfg(target_os = "windows")]
pub use native::{ExpansionRequest, ExpansionSession};

pub fn copy(text: String) -> Result<()> {
    #[cfg(target_os = "linux")]
    { typerelay_client::clipboard::PasteJob::copy_text(text) }
    #[cfg(not(target_os = "linux"))]
    { use clipboard_rs::Clipboard; clipboard_rs::ClipboardContext::new().map_err(|e|anyhow::anyhow!("{e}"))?.set_text(text).map_err(|e|anyhow::anyhow!("{e}")) }
}

#[cfg(not(target_os = "linux"))]
pub fn paste(target: &Target, erase: usize, text: Option<String>) -> Result<()> {
    use enigo::{Enigo, Keyboard, Key, Direction};
    use std::time::{Duration, Instant};
    let mut enigo = Enigo::new(&enigo::Settings::default()).context("Allow TypeRelay accessibility/input permission")?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while native::keys_down() { ensure!(Instant::now() < deadline, "Release shortcut keys before inserting"); std::thread::sleep(Duration::from_millis(10)); }
    ensure!(target.focused()?, "Original window lost focus; nothing inserted");
    let mut clipboard=None;let has_text=text.is_some();
    if let Some(text)=text {match native::ClipboardLease::publish(text.clone()){Ok(lease)=>clipboard=Some(lease),Err(_error)=>{
        #[cfg(target_os="windows")]
        {copy(text)?;}
        #[cfg(not(target_os="windows"))]
        {return Err(_error);}
    }}}
    let insertion: Result<()> = (|| {
        ensure!(target.focused()?, "Original window lost focus; nothing inserted");
        for _ in 0..erase { enigo.key(Key::Backspace,Direction::Click)?; }
        if !has_text { enigo.key(Key::Return,Direction::Click)?; std::thread::sleep(Duration::from_millis(100)); return Ok(()); }
        let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
        #[cfg(target_os="windows")]
        let paste_key=Key::V;
        #[cfg(target_os="macos")]
        let paste_key=Key::Unicode('v');
        enigo.key(modifier,Direction::Press)?;
        let result = enigo.key(paste_key,Direction::Click);
        let released = enigo.key(modifier,Direction::Release);
        result?; released?;
        std::thread::sleep(Duration::from_millis(350)); Ok(())
    })();
    if let Some(clipboard)=&mut clipboard { clipboard.restore()?; }
    insertion
}
