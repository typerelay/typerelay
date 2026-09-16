use anyhow::Result;
#[cfg(not(target_os="linux"))]
use anyhow::ensure;
#[cfg(target_os = "linux")]
#[path = "platform_linux.rs"] mod native;
#[cfg(target_os = "macos")]
#[path = "platform_macos.rs"] mod native;
#[cfg(target_os = "windows")]
#[path = "platform_windows.rs"] mod native;
pub use native::{Target,fallback_allowed};
#[cfg(target_os="macos")]
pub use native::NativeNotifications;
#[cfg(any(target_os = "windows",target_os = "macos"))]
pub use native::{ExpansionRequest, ExpansionSession};

pub fn accessibility(prompt:bool)->bool { #[cfg(target_os="macos")] {native::accessibility(prompt)} #[cfg(not(target_os="macos"))] {let _=prompt;true} }
pub fn input_monitoring(prompt:bool)->bool { #[cfg(target_os="macos")] {native::input_monitoring(prompt)} #[cfg(not(target_os="macos"))] {let _=prompt;true} }
pub fn open_accessibility_settings()->Result<()> { #[cfg(target_os="macos")] {native::open_accessibility_settings()} #[cfg(not(target_os="macos"))] {anyhow::bail!("Accessibility settings are available on macOS")} }
pub fn open_input_monitoring_settings()->Result<()> { #[cfg(target_os="macos")] {native::open_input_monitoring_settings()} #[cfg(not(target_os="macos"))] {anyhow::bail!("Input Monitoring settings are available on macOS")} }
pub fn open_tui()->Result<()> {native::open_tui()}
pub fn open_web_app()->Result<()> {native::open_url("https://app.typerelay.com")}
#[cfg(target_os="macos")]
pub fn release_modifiers()->Result<()> {native::release_modifiers()}

pub fn copy(text: String) -> Result<()> {
	copy_payload(typerelay_client::clipboard_payload::ClipboardPayload::text(text))
}
pub fn copy_payload(payload:typerelay_client::clipboard_payload::ClipboardPayload)->Result<()> {
    #[cfg(target_os = "linux")]
	{ typerelay_client::clipboard::PasteJob::copy_payload(payload) }
    #[cfg(not(target_os = "linux"))]
	{ use clipboard_rs::{Clipboard,ClipboardContent};let context=clipboard_rs::ClipboardContext::new().map_err(|e|anyhow::anyhow!("{e}"))?;let mut contents=vec![ClipboardContent::Text(payload.plain)];if let Some(html)=payload.html{contents.push(ClipboardContent::Html(html));}if let Some(rtf)=payload.rtf{contents.push(ClipboardContent::Rtf(rtf));}context.set(contents).map_err(|e|anyhow::anyhow!("{e}")) }
}

#[cfg(not(target_os = "linux"))]
pub fn paste(target: &Target, erase: usize, payload: Option<typerelay_client::clipboard_payload::ClipboardPayload>) -> Result<()> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(2);
    while native::keys_down() { ensure!(Instant::now() < deadline, "Release shortcut keys before inserting"); std::thread::sleep(Duration::from_millis(10)); }
    ensure!(target.focused()?, "Original window lost focus; nothing inserted");
    #[cfg(target_os="windows")]
	if payload.as_ref().is_none_or(|value|value.html.is_none()&&value.rtf.is_none())&&target.replace_text(erase,payload.as_ref().map(|value|value.plain.as_str()).unwrap_or("\n"))?{return Ok(());}
	let mut clipboard=None;let has_text=payload.is_some();
	if let Some(payload)=payload {
        #[cfg(target_os="windows")]
        let preserve=!native::remote_session();
        #[cfg(target_os="macos")]
        let preserve=true;
		if !preserve{copy_payload(payload.clone())?;}else{match native::ClipboardLease::publish(payload.clone()){Ok(lease)=>clipboard=Some(lease),Err(_error)=>{
        #[cfg(target_os="windows")]
		{copy_payload(payload)?;}
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
        native::insert(target,erase,has_text)?;std::thread::sleep(Duration::from_millis(if has_text{350}else{100}));Ok(())
        }
    })();
    if let Some(clipboard)=&mut clipboard { clipboard.restore()?; }
    insertion
}
