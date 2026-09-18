use anyhow::{Context,Result,ensure};
use crate::clipboard_payload::ClipboardPayload;
use std::{io::Write,process::{Command,Stdio}};

pub struct PasteJob;

impl PasteJob {
	pub fn copy_text(text:String)->Result<()> {Self::copy_payload(ClipboardPayload::text(text))}
	pub fn copy_payload(payload:ClipboardPayload)->Result<()> {let rich=payload.rtf;let mut command=Command::new("/usr/bin/pbcopy");if rich.is_some(){command.args(["-Prefer","rtf"]);}let mut child=command.stdin(Stdio::piped()).spawn().context("Clipboard unavailable")?;child.stdin.take().context("Clipboard input unavailable")?.write_all(rich.as_deref().unwrap_or(&payload.plain).as_bytes())?;let status=child.wait()?;ensure!(status.success(),"Clipboard write failed");Ok(())}
}
