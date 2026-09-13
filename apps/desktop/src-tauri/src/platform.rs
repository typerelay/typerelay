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

pub fn copy(text: String) -> Result<()> {
    #[cfg(target_os = "linux")]
    { typerelay_client::clipboard::PasteJob::copy_text(text) }
    #[cfg(not(target_os = "linux"))]
    { use clipboard_rs::Clipboard; clipboard_rs::ClipboardContext::new().map_err(|e|anyhow::anyhow!("{e}"))?.set_text(text).map_err(|e|anyhow::anyhow!("{e}")) }
}

#[cfg(not(target_os = "linux"))]
pub fn paste(target: &Target, text: String) -> Result<()> {
    use enigo::{Enigo, Keyboard, Key, Direction};
    use std::time::{Duration, Instant};
    let mut enigo = Enigo::new(&enigo::Settings::default()).context("Allow TypeRelay accessibility/input permission")?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while native::keys_down() { ensure!(Instant::now() < deadline, "Release shortcut keys before inserting"); std::thread::sleep(Duration::from_millis(10)); }
    ensure!(target.focused()?, "Original window lost focus; nothing inserted");
    let mut clipboard = native::ClipboardLease::publish(text)?;
    let insertion: Result<()> = (|| {
        ensure!(target.focused()?, "Original window lost focus; nothing inserted");
        let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
        enigo.key(modifier,Direction::Press)?;
        let result = enigo.key(Key::Unicode('v'),Direction::Click);
        let released = enigo.key(modifier,Direction::Release);
        result?; released?;
        std::thread::sleep(Duration::from_millis(350)); Ok(())
    })();
    clipboard.restore()?;
    insertion
}
