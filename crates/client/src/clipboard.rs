//! Temporary Wayland clipboard ownership, kept off the keyboard event loop.
use anyhow::{Context, Result, bail};
use std::{collections::BTreeMap, io::{Read, Write, BufRead}, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, Sender}}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use wl_clipboard_rs::{copy::{self, MimeSource, MimeType, Options, Source}, paste::{self, ClipboardType, Seat}};

pub enum Progress { Ready, Finished }

pub struct PasteJob {
    pub progress: Receiver<Result<Progress>>,
    pasted: Sender<()>,
    cancelled: Arc<AtomicBool>,
    started: Instant,
}

struct ClipboardLease {
    previous: BTreeMap<String, Vec<u8>>,
    marker: String,
    published: bool,
}

impl ClipboardLease {
    fn capture(cancelled: &AtomicBool) -> Result<Self> {
        let mut previous = BTreeMap::new();
        let types = match paste::get_mime_types(ClipboardType::Regular, Seat::Unspecified) {
            Ok(types) => types,
            Err(paste::Error::ClipboardEmpty) => Default::default(),
            Err(error) => return Err(error.into()),
        };
        if types.len() > 64 { bail!("Too many clipboard formats to preserve"); }
        let mut total = 0;
        for mime in types {
            if cancelled.load(Ordering::SeqCst) { bail!("Paste cancelled"); }
            let (pipe, _) = paste::get_contents(ClipboardType::Regular, Seat::Unspecified, paste::MimeType::Specific(&mime))?;
            let mut bytes = Vec::new();
            pipe.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            total += bytes.len();
            if total > 16 * 1024 * 1024 { bail!("Clipboard exceeds preservation limit; left unchanged"); }
            previous.insert(mime, bytes);
        }
        let marker = format!("application/x-typerelay-paste-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos());
        Ok(Self { previous, marker, published: false })
    }

    fn publish(&mut self, text: String) -> Result<()> {
        Options::new().copy_multi(vec![MimeSource { source: Source::Bytes(text.into_bytes().into()), mime_type: MimeType::Text }, MimeSource { source: Source::Bytes(Box::new([])), mime_type: MimeType::Specific(self.marker.clone()) }])?;
        self.published = true;
        Ok(())
    }

    fn restore(&mut self) -> Result<()> {
        if !self.published { return Ok(()); }
        let types = match paste::get_mime_types(ClipboardType::Regular, Seat::Unspecified) {
            Ok(types) => types,
            Err(paste::Error::ClipboardEmpty) => Default::default(),
            Err(error) => return Err(error.into()),
        };
        // A newer user copy wins. Never overwrite it with our saved clipboard.
        if types.contains(&self.marker) {
            if self.previous.is_empty() {
                copy::clear(copy::ClipboardType::Regular, copy::Seat::All)?;
            } else {
                // The clipboard owner must survive the client exiting.
                PasteJob::publish_snapshot(&self.previous, std::env::current_exe()?)?;
            }
        }
        self.published = false;
        Ok(())
    }
}

impl Drop for ClipboardLease {
    fn drop(&mut self) { if self.restore().is_err() { eprintln!("Could not restore clipboard"); } }
}

impl PasteJob {
    pub fn copy_text(text: String) -> Result<()> {
        let current = std::env::current_exe()?;
        let sibling = current.with_file_name("typerelay");
        let executable = if sibling.exists() { sibling } else if current.file_stem().is_some_and(|name|name == "typerelay-panel") { current } else { anyhow::bail!("Install the matching typerelay binary before copying"); };
        Self::publish_snapshot(&BTreeMap::from([("text/plain;charset=utf-8".into(), text.into_bytes())]), executable)
    }
    fn publish_snapshot(snapshot: &BTreeMap<String, Vec<u8>>, executable: std::path::PathBuf) -> Result<()> {
                let mut child = Command::new(executable).arg("clipboard-serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
                let mut input = child.stdin.take().context("Missing clipboard helper stdin")?;
                serde_json::to_writer(&mut input, snapshot)?;
                drop(input);
                let mut response = String::new();
                std::io::BufReader::new(child.stdout.take().context("Missing clipboard helper stdout")?).read_line(&mut response)?;
                if response.trim() != "ready" { let _ = child.kill(); let _ = child.wait(); bail!("Clipboard restore helper failed"); }
                thread::spawn(move || { let _ = child.wait(); });
        Ok(())
    }

    pub fn serve_restored() -> Result<()> {
        let snapshot: BTreeMap<String, Vec<u8>> = serde_json::from_reader(std::io::stdin().take(128 * 1024 * 1024))?;
        let sources = snapshot.into_iter().map(|(mime, bytes)| MimeSource { source: Source::Bytes(bytes.into()), mime_type: MimeType::Specific(mime) }).collect();
        let mut options = Options::new();
        options.foreground(true).omit_additional_text_mime_types(true);
        let prepared = options.prepare_copy_multi(sources)?;
        println!("ready");
        std::io::stdout().flush()?;
        prepared.serve()?;
        Ok(())
    }

    pub fn start(text: String) -> Self {
        let (progress_tx, progress) = mpsc::channel();
        let (pasted, pasted_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        thread::spawn(move || {
            let result = Self::serve(text, &cancellation, &progress_tx, pasted_rx);
            if let Err(error) = result { let _ = progress_tx.send(Err(error)); }
        });
        Self { progress, pasted, cancelled, started: Instant::now() }
    }

    fn serve(text: String, cancelled: &AtomicBool, progress: &Sender<Result<Progress>>, pasted: Receiver<()>) -> Result<()> {
        let mut lease = ClipboardLease::capture(cancelled)?;
        if cancelled.load(Ordering::SeqCst) { return Ok(()); }
        lease.publish(text)?;
        progress.send(Ok(Progress::Ready)).context("Paste coordinator stopped")?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while !cancelled.load(Ordering::SeqCst) {
            match pasted.recv_timeout(Duration::from_millis(20)) {
                Ok(()) => {
                    // Keep the offer alive while the target processes its paste shortcut.
                    thread::sleep(Duration::from_millis(300));
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline => break,
                Err(_) => (),
            }
        }
        lease.restore()?;
        progress.send(Ok(Progress::Finished)).context("Paste coordinator stopped")?;
        Ok(())
    }

    pub fn pasted(&self) { let _ = self.pasted.send(()); }
    pub fn cancel(&self) { self.cancelled.store(true, Ordering::SeqCst); }
    pub fn timed_out(&self) -> bool { self.started.elapsed() > Duration::from_secs(5) }
}

impl Drop for PasteJob {
    fn drop(&mut self) {
        self.cancel();
        let deadline = Instant::now() + Duration::from_millis(500);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match self.progress.recv_timeout(left) {
                Ok(Ok(Progress::Ready)) => continue,
                _ => break,
            }
        }
    }
}
