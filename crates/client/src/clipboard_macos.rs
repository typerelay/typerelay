use anyhow::{Context,Result,ensure};
use std::{io::Write,process::{Command,Stdio}};

pub struct PasteJob;

impl PasteJob {
    pub fn copy_text(text:String)->Result<()> { let mut child=Command::new("/usr/bin/pbcopy").stdin(Stdio::piped()).spawn().context("Clipboard unavailable")?;child.stdin.take().context("Clipboard input unavailable")?.write_all(text.as_bytes())?;let status=child.wait()?;ensure!(status.success(),"Clipboard write failed");Ok(()) }
}
