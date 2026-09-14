use anyhow::Result;

pub struct PasteJob;

impl PasteJob {
    pub fn copy_text(text: String) -> Result<()> {
        clipboard_win::set_clipboard_string(&text).map_err(|error| anyhow::anyhow!("Clipboard write failed: {error}"))?;
        Ok(())
    }
}
