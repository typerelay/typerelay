use anyhow::Result;
#[cfg(not(target_os="linux"))]
use anyhow::ensure;
#[cfg(target_os = "linux")]
#[path = "platform_linux.rs"] mod native;
#[cfg(target_os = "macos")]
#[path = "platform_macos.rs"] mod native;
#[cfg(target_os = "windows")]
#[path = "platform_windows.rs"] mod native;
pub use native::Target;
#[cfg(target_os="windows")]
pub use native::keys_down;
#[cfg(not(target_os="linux"))]
impl Target {
	pub fn for_panel(captured:Result<Self>,last:Option<Self>)->Result<Option<Self>> {match captured {Ok(target)=>Ok(Some(target)),Err(_) if native::fallback_allowed()=>Ok(last),Err(error)=>Err(error)}}
}
#[cfg(target_os="macos")]
pub use native::{NativeNotifications,DeferredInput};
#[cfg(any(target_os = "windows",target_os = "macos"))]
pub use native::{ExpansionRequest, ExpansionSession};

pub fn accessibility(prompt:bool)->bool { #[cfg(target_os="macos")] {native::accessibility(prompt)} #[cfg(not(target_os="macos"))] {let _=prompt;true} }
pub fn input_monitoring(prompt:bool)->bool { #[cfg(target_os="macos")] {native::input_monitoring(prompt)} #[cfg(not(target_os="macos"))] {let _=prompt;true} }
pub fn open_accessibility_settings()->Result<()> { #[cfg(target_os="macos")] {native::open_accessibility_settings()} #[cfg(not(target_os="macos"))] {anyhow::bail!("Accessibility settings are available on macOS")} }
pub fn open_input_monitoring_settings()->Result<()> { #[cfg(target_os="macos")] {native::open_input_monitoring_settings()} #[cfg(not(target_os="macos"))] {anyhow::bail!("Input Monitoring settings are available on macOS")} }
pub fn open_tui()->Result<()> {native::open_tui()}
pub fn open_web_app(url:Option<&str>)->Result<()> {if url==Some("#statistics"){let root=typerelay_client::editor::Paths::config_dir()?;let identity=typerelay_client::database::Database::open(&root.join("snippets"))?.meta("statistics_identity")?.unwrap_or_default();let server=identity["server"].as_str().unwrap_or("https://app.typerelay.com");let mut url=tauri::Url::parse(server)?;anyhow::ensure!(["http","https"].contains(&url.scheme()),"Invalid server URL");url.set_path("/");if let Some(account)=identity["account"].as_str(){url.query_pairs_mut().append_pair("account",account);}url.set_fragment(Some("statistics"));return native::open_url(url.as_str());}let url=url.unwrap_or("https://app.typerelay.com");anyhow::ensure!(["https://app.typerelay.com","https://feedback.typerelay.com","https://docs.typerelay.com","https://typerelay.com","mailto:hi@typerelay.com","https://razuna.com","https://streamient.com","https://managani.com","https://helpmonks.com","https://mailtwine.com"].contains(&url),"Unsupported TypeRelay link");native::open_url(url)}
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
pub fn paste(target: &Target, erase: usize, payload: Option<typerelay_client::clipboard_payload::ClipboardPayload>, current:impl Fn()->bool) -> Result<()> {
    use std::time::{Duration, Instant};
    #[cfg(target_os="macos")]
    if payload.as_ref().is_some_and(|payload|payload.cursor.is_some()){ensure!(native::input_monitoring(false)&&Target::input_ready().load(std::sync::atomic::Ordering::SeqCst),"Cursor positioning requires active keyboard monitoring. Allow Input Monitoring and restart TypeRelay, or use Copy; nothing inserted");}
    let marked=payload.as_ref().is_some_and(|payload|payload.cursor.is_some());let epoch=Target::input_epoch().load(std::sync::atomic::Ordering::SeqCst);let guarded=||current()&&(!marked||Target::input_epoch().load(std::sync::atomic::Ordering::SeqCst)==epoch);
    let deadline = Instant::now() + Duration::from_secs(2);
    while native::keys_down() { ensure!(Instant::now() < deadline, "Release shortcut keys before inserting"); std::thread::sleep(Duration::from_millis(10)); }
    ensure!(guarded(), "Expansion cancelled; nothing inserted");
    ensure!(target.focused()?, "Original window lost focus; nothing inserted");
    #[cfg(target_os="windows")]
	if let Some(payload)=payload.as_ref()&&payload.html.is_none()&&payload.rtf.is_none()&&target.replace_text(erase,&payload.plain,payload.cursor.as_ref())?{return Ok(());}
	if let Some(cursor)=payload.as_ref().and_then(|payload|payload.cursor.as_ref()){ensure!(Target::input_ready().load(std::sync::atomic::Ordering::SeqCst),"Cursor positioning requires active keyboard monitoring. Restart TypeRelay or use Copy; nothing inserted");ensure!(cursor.backward_graphemes<=512,"This editor supports cursor positioning up to 512 characters from the end. Use Copy; nothing inserted");}
	let mut clipboard=None;let has_text=payload.is_some();let cursor=payload.as_ref().and_then(|payload|payload.cursor.clone());
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
        ensure!(guarded(), "Expansion cancelled; nothing inserted");
        ensure!(target.focused()?, "Original window lost focus; nothing inserted");
        #[cfg(target_os="windows")]
        {native::insert(target,erase,has_text)?;std::thread::sleep(Duration::from_millis(if has_text{350}else{100}));Ok(())}
        #[cfg(target_os="macos")]
        {
        native::insert(target,erase,has_text)?;std::thread::sleep(Duration::from_millis(if has_text{350}else{100}));Ok(())
        }
    })();
    if let Some(clipboard)=&mut clipboard { clipboard.restore()?; }
    insertion?;
    if let Some(cursor)=cursor { ensure!(guarded(), "Text inserted; cursor positioning interrupted. Nothing retried"); ensure!(target.focused()?, "Text inserted; original window lost focus. Cursor positioning cancelled; nothing retried"); target.position_cursor(cursor.backward_graphemes,&guarded)?; }
    Ok(())
}

pub fn start_observation(state:std::sync::Arc<crate::observation::Observation>) {native::ObservationAdapter::start(state);}
