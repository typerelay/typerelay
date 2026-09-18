use anyhow::Result;
use crate::clipboard_payload::ClipboardPayload;

pub struct PasteJob;

impl PasteJob {
    pub fn copy_text(text: String) -> Result<()> {
		Self::copy_payload(ClipboardPayload::text(text))
    }
	pub fn copy_payload(payload:ClipboardPayload)->Result<()> {use clipboard_win::{Clipboard,raw,options::NoClear};let html=payload.html.map(crate::clipboard_payload::ClipboardPayload::cf_html);let html_format=clipboard_win::register_format("HTML Format").map(|value|value.get());let rtf_format=clipboard_win::register_format("Rich Text Format").map(|value|value.get());let _lock=Clipboard::new_attempts(10).map_err(|error|anyhow::anyhow!("Clipboard unavailable: {error}"))?;raw::empty().map_err(|error|anyhow::anyhow!("Clipboard write failed: {error}"))?;raw::set_string_with(&payload.plain,NoClear).map_err(|error|anyhow::anyhow!("Clipboard text failed: {error}"))?;if let(Some(format),Some(html))=(html_format,html){let mut bytes=html.into_bytes();bytes.push(0);raw::set_without_clear(format,&bytes).map_err(|error|anyhow::anyhow!("Clipboard HTML failed: {error}"))?;}if let(Some(format),Some(rtf))=(rtf_format,payload.rtf){let mut bytes=rtf.into_bytes();bytes.push(0);raw::set_without_clear(format,&bytes).map_err(|error|anyhow::anyhow!("Clipboard RTF failed: {error}"))?;}Ok(())}
}
