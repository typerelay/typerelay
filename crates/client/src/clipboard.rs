//! Wayland clipboard publication, kept off the keyboard event loop.
use anyhow::{Context, Result, bail};
use std::{collections::BTreeMap, io::{Read, Write, BufRead}, os::unix::process::CommandExt, path::PathBuf, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, Sender}}, thread, time::{Duration, Instant}};
use wl_clipboard_rs::copy::{MimeSource, MimeType, Options, Source};
use crate::clipboard_payload::ClipboardPayload;

pub enum Progress { Ready, Finished }
enum ClipboardAction { Pasted, Cancelled }

pub struct PasteJob {
    pub progress: Receiver<Result<Progress>>,
    action: Sender<ClipboardAction>,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl PasteJob {
    pub fn copy_text(text: String) -> Result<()> {
        Self::copy_payload(ClipboardPayload::text(text))
    }

    pub fn copy_payload(payload: ClipboardPayload) -> Result<()> {
        let current = std::env::current_exe()?;
        let sibling = current.with_file_name("typerelay");
        let executable = if sibling.exists() { sibling } else if current.file_stem().is_some_and(|name| name == "typerelay-panel") { current } else { bail!("Install the matching typerelay binary before copying"); };
        Self::publish_payload(payload, executable)
    }

    fn payload_formats(payload: ClipboardPayload) -> BTreeMap<String, Vec<u8>> {
        let mut formats = BTreeMap::from([("text/plain;charset=utf-8".into(), payload.plain.into_bytes())]);
        if let Some(html) = payload.html { formats.insert("text/html".into(), html.into_bytes()); }
        if let Some(rtf) = payload.rtf { formats.insert("text/rtf".into(), rtf.into_bytes()); }
        formats
    }

    fn publish_payload(payload: ClipboardPayload, executable: PathBuf) -> Result<()> {
        let mut child = Command::new(executable).arg("clipboard-serve").process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let published = (|| -> Result<()> {
            let mut input = child.stdin.take().context("Missing clipboard helper stdin")?;
            serde_json::to_writer(&mut input, &Self::payload_formats(payload))?;
            drop(input);
            let mut response = String::new();
            std::io::BufReader::new(child.stdout.take().context("Missing clipboard helper stdout")?).read_line(&mut response)?;
            if response.trim() != "ready" { bail!("Clipboard helper failed"); }
            Ok(())
        })();
        if let Err(error) = published {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        thread::spawn(move || { let _ = child.wait(); });
        Ok(())
    }

    pub fn serve_clipboard() -> Result<()> {
        let mut formats: BTreeMap<String, Vec<u8>> = serde_json::from_reader(std::io::stdin().take(128 * 1024 * 1024))?;
        let plain = formats.remove("text/plain;charset=utf-8").context("Missing clipboard text")?;
        // wl-clipboard-rs generates its text aliases from the first text format.
        let mut sources = vec![MimeSource { source: Source::Bytes(plain.into()), mime_type: MimeType::Text }];
        sources.extend(formats.into_iter().map(|(mime, bytes)| MimeSource { source: Source::Bytes(bytes.into()), mime_type: MimeType::Specific(mime) }));
        let mut options = Options::new();
        options.foreground(true);
        let prepared = options.prepare_copy_multi(sources)?;
        println!("ready");
        std::io::stdout().flush()?;
        prepared.serve()?;
        Ok(())
    }

    pub fn start(text: String) -> Self {
        Self::start_payload(ClipboardPayload::text(text), Instant::now() + Duration::from_secs(5))
    }
    pub fn start_payload(payload: ClipboardPayload, deadline: Instant) -> Self {
        Self::start_with_publisher(deadline, move || Self::publish_payload(payload, std::env::current_exe()?))
    }

    fn start_with_publisher(deadline: Instant, publish: impl FnOnce() -> Result<()> + Send + 'static) -> Self {
        let (progress_tx, progress) = mpsc::channel();
        let (action, action_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        let preparation_deadline = deadline.min(Instant::now() + Duration::from_secs(2));
        thread::spawn(move || {
            let result = Self::serve(&cancellation, &progress_tx, action_rx, preparation_deadline, publish);
            if let Err(error) = result { let _ = progress_tx.send(Err(error)); }
        });
        Self { progress, action, cancelled, deadline }
    }

    fn serve(cancelled: &AtomicBool, progress: &Sender<Result<Progress>>, action: Receiver<ClipboardAction>, preparation_deadline: Instant, publish: impl FnOnce() -> Result<()>) -> Result<()> {
        let can_publish = || !cancelled.load(Ordering::SeqCst) && Instant::now() < preparation_deadline;
        if !can_publish() { bail!("Clipboard preparation cancelled or timed out"); }
        publish()?;
        if !can_publish() { bail!("Clipboard preparation cancelled or timed out"); }
        progress.send(Ok(Progress::Ready)).context("Paste coordinator stopped")?;
        Self::wait_for_paste(action);
        progress.send(Ok(Progress::Finished)).context("Paste coordinator stopped")?;
        Ok(())
    }

    fn wait_for_paste(action: Receiver<ClipboardAction>) {
        if matches!(action.recv(), Ok(ClipboardAction::Pasted)) {
            // Wait for the target to read this payload before a template can publish the next one.
            thread::sleep(Duration::from_millis(300));
        }
    }

    pub fn pasted(&self) { let _ = self.action.send(ClipboardAction::Pasted); }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.action.send(ClipboardAction::Cancelled);
    }
    pub fn timed_out(&self) -> bool { self.expired_at(Instant::now()) }
    fn expired_at(&self, now: Instant) -> bool { now >= self.deadline }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn waits_for_relay_acknowledgement_beyond_the_old_clipboard_timeout() {
        let (action, receive) = mpsc::channel();
        let (waiting, ready) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let worker = thread::spawn(move || {
            waiting.send(()).unwrap();
            PasteJob::wait_for_paste(receive);
            done.send(()).unwrap();
        });
        ready.recv().unwrap();
        assert_eq!(finished.recv_timeout(Duration::from_millis(3100)), Err(mpsc::RecvTimeoutError::Timeout));
        action.send(ClipboardAction::Pasted).unwrap();
        finished.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn cancellation_and_disconnection_release_the_clipboard_wait() {
        let (action, receive) = mpsc::channel();
        action.send(ClipboardAction::Cancelled).unwrap();
        PasteJob::wait_for_paste(receive);
        let (action, receive) = mpsc::channel();
        drop(action);
        PasteJob::wait_for_paste(receive);
    }

    #[test]
    fn queued_acknowledgement_keeps_grace_period_even_after_cancellation() {
        let (action, receive) = mpsc::channel();
        action.send(ClipboardAction::Pasted).unwrap();
        action.send(ClipboardAction::Cancelled).unwrap();
        let start = Instant::now();
        PasteJob::wait_for_paste(receive);
        assert!(start.elapsed() >= Duration::from_millis(300));
    }

    #[test]
    fn paste_expires_at_the_original_request_cutoff() {
        let queued = Instant::now();
        let deadline = queued + Duration::from_secs(5);
        let (finished, progress) = mpsc::channel();
        drop(finished);
        let (action, _) = mpsc::channel();
        let job = PasteJob { progress, action, cancelled: Arc::new(AtomicBool::new(false)), deadline };
        assert!(!job.expired_at(queued + Duration::from_millis(4999)));
        assert!(job.expired_at(deadline));
    }

    #[test]
    fn completion_cancellation_and_drop_never_write_the_clipboard_again() {
        for action in [Some(ClipboardAction::Pasted), Some(ClipboardAction::Cancelled), None] {
            let clipboard = Arc::new(Mutex::new(vec!["original"]));
            let writer = clipboard.clone();
            let job = PasteJob::start_with_publisher(Instant::now() + Duration::from_secs(5), move || {
                writer.lock().unwrap().push("snippet");
                Ok(())
            });
            assert!(matches!(job.progress.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(), Progress::Ready));
            assert_eq!(*clipboard.lock().unwrap(), ["original", "snippet"]);
            clipboard.lock().unwrap().push("newer copy");
            if let Some(action) = action {
                match action {
                    ClipboardAction::Pasted => job.pasted(),
                    ClipboardAction::Cancelled => job.cancel(),
                }
                assert!(matches!(job.progress.recv_timeout(Duration::from_secs(1)).unwrap().unwrap(), Progress::Finished));
            }
            drop(job);
            assert_eq!(*clipboard.lock().unwrap(), ["original", "snippet", "newer copy"]);
        }
    }

    #[test]
    fn expired_or_late_publication_never_signals_the_relay_to_paste() {
        let (progress, result) = mpsc::channel();
        let (_, action) = mpsc::channel();
        let cancelled = AtomicBool::new(false);
        assert!(PasteJob::serve(&cancelled, &progress, action, Instant::now(), || panic!("Expired request published")).is_err());
        let (_, action) = mpsc::channel();
        assert!(PasteJob::serve(&cancelled, &progress, action, Instant::now() + Duration::from_secs(1), || {
            cancelled.store(true, Ordering::SeqCst);
            Ok(())
        }).is_err());
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }

    #[test]
    fn clipboard_formats_keep_plain_text_and_rich_payloads_distinct() {
        let plain = "café";
        let formats = PasteJob::payload_formats(ClipboardPayload::text(plain.into()));
        assert_eq!(formats, BTreeMap::from([("text/plain;charset=utf-8".into(), plain.as_bytes().to_vec())]));
        let mut payload = ClipboardPayload::text(plain.into());
        payload.html = Some("<b>café</b>".into());
        payload.rtf = Some("{\\rtf1 café}".into());
        let formats = PasteJob::payload_formats(payload);
        assert_eq!(formats["text/plain;charset=utf-8"], plain.as_bytes());
        assert_eq!(formats["text/html"], "<b>café</b>".as_bytes());
        assert_eq!(formats["text/rtf"], "{\\rtf1 café}".as_bytes());
    }
}
