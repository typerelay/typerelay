//! Temporary Wayland clipboard ownership, kept off the keyboard event loop.
use anyhow::{Context, Result, bail};
use std::{collections::{BTreeMap, HashSet}, io::{Read, Write, BufRead}, os::fd::AsRawFd, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, Sender}}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use wl_clipboard_rs::{copy::{self, MimeSource, MimeType, Options, Source}, paste::{self, ClipboardType, Seat}};
use crate::clipboard_payload::ClipboardPayload;

pub enum Progress { Ready, Finished }
enum ClipboardAction { Pasted, Cancelled }

pub struct PasteJob {
    pub progress: Receiver<Result<Progress>>,
    action: Sender<ClipboardAction>,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

struct ClipboardLease {
    previous: BTreeMap<String, Vec<u8>>,
    marker: String,
    published: bool,
}

impl ClipboardLease {
    const MAX_BYTES: usize = 16 * 1024 * 1024;

    fn capture(cancelled: &AtomicBool, deadline: Instant) -> Result<Self> {
        let types = match paste::get_mime_types(ClipboardType::Regular, Seat::Unspecified) {
            Ok(types) => types,
            Err(paste::Error::ClipboardEmpty) => Default::default(),
            Err(error) => return Err(error.into()),
        };
        let previous = Self::capture_formats(types, cancelled, deadline, |mime| {
            Ok(paste::get_contents(ClipboardType::Regular, Seat::Unspecified, paste::MimeType::Specific(mime))?.0)
        })?;
        let marker = format!("application/x-typerelay-paste-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos());
        Ok(Self { previous, marker, published: false })
    }

    fn capture_formats<R: Read + AsRawFd>(types: HashSet<String>, cancelled: &AtomicBool, deadline: Instant, mut contents: impl FnMut(&str) -> Result<R>) -> Result<BTreeMap<String, Vec<u8>>> {
        let has_utf8 = types.contains("text/plain;charset=utf-8") || types.contains("UTF8_STRING");
        // XWayland can advertise a selection-management target and a redundant legacy conversion that never complete.
        let formats: Vec<_> = types.into_iter().filter(|mime| mime != "SAVE_TARGETS" && !(has_utf8 && mime == "COMPOUND_TEXT")).collect();
        if formats.len() > 64 { bail!("Too many clipboard formats to preserve"); }
        let mut previous = BTreeMap::new();
        let mut total = 0;
        let mut chunk = [0; 32768];
        for mime in formats {
            if cancelled.load(Ordering::SeqCst) { bail!("Paste cancelled"); }
            if Instant::now() >= deadline { bail!("Clipboard preservation timed out; left unchanged"); }
            let mut pipe = contents(&mime)?;
            let mut descriptor = libc::pollfd { fd: pipe.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let mut bytes = Vec::new();
            loop {
                if cancelled.load(Ordering::SeqCst) { bail!("Paste cancelled"); }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() { bail!("Clipboard preservation timed out; left unchanged"); }
                let ready = unsafe { libc::poll(&mut descriptor, 1, left.as_millis().clamp(1, 20) as i32) };
                if ready == 0 { continue; }
                let count = if ready < 0 { Err(std::io::Error::last_os_error()) } else { pipe.read(&mut chunk) };
                let count = match count {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    result => result?,
                };
                if count == 0 { break; }
                total += count;
                if total > Self::MAX_BYTES { bail!("Clipboard exceeds preservation limit; left unchanged"); }
                bytes.extend_from_slice(&chunk[..count]);
            }
            previous.insert(mime, bytes);
        }
        Ok(previous)
    }

	fn publish(&mut self,payload:ClipboardPayload)->Result<()> {
		let mut sources=vec![MimeSource{source:Source::Bytes(payload.plain.into_bytes().into()),mime_type:MimeType::Text}];
		if let Some(html)=payload.html{sources.push(MimeSource{source:Source::Bytes(html.into_bytes().into()),mime_type:MimeType::Specific("text/html".into())});}
		if let Some(rtf)=payload.rtf{sources.push(MimeSource{source:Source::Bytes(rtf.into_bytes().into()),mime_type:MimeType::Specific("text/rtf".into())});}
		sources.push(MimeSource{source:Source::Bytes(Box::new([])),mime_type:MimeType::Specific(self.marker.clone())});Options::new().copy_multi(sources)?;
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
		Self::copy_payload(ClipboardPayload::text(text))
	}
	pub fn copy_payload(payload:ClipboardPayload)->Result<()> {
        let current = std::env::current_exe()?;
        let sibling = current.with_file_name("typerelay");
        let executable = if sibling.exists() { sibling } else if current.file_stem().is_some_and(|name|name == "typerelay-panel") { current } else { anyhow::bail!("Install the matching typerelay binary before copying"); };
		let mut snapshot=BTreeMap::from([("text/plain;charset=utf-8".into(),payload.plain.into_bytes())]);if let Some(html)=payload.html{snapshot.insert("text/html".into(),html.into_bytes());}if let Some(rtf)=payload.rtf{snapshot.insert("text/rtf".into(),rtf.into_bytes());}Self::publish_snapshot(&snapshot,executable)
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
        Self::start_payload(ClipboardPayload::text(text), Instant::now() + Duration::from_secs(5))
    }
    pub fn start_payload(payload: ClipboardPayload, deadline: Instant) -> Self {
        let (progress_tx, progress) = mpsc::channel();
        let (action, action_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        let preparation_deadline = deadline.min(Instant::now() + Duration::from_secs(2));
        thread::spawn(move || {
            let result = Self::serve(payload, &cancellation, &progress_tx, action_rx, preparation_deadline);
            if let Err(error) = result { let _ = progress_tx.send(Err(error)); }
        });
        Self { progress, action, cancelled, deadline }
    }

    fn serve(payload: ClipboardPayload, cancelled: &AtomicBool, progress: &Sender<Result<Progress>>, action: Receiver<ClipboardAction>, preparation_deadline: Instant) -> Result<()> {
        let mut lease = ClipboardLease::capture(cancelled, preparation_deadline)?;
        if cancelled.load(Ordering::SeqCst) { return Ok(()); }
        if Instant::now() >= preparation_deadline { bail!("Clipboard preservation timed out; left unchanged"); }
        lease.publish(payload)?;
        if cancelled.load(Ordering::SeqCst) { return Ok(()); }
        if Instant::now() >= preparation_deadline { bail!("Clipboard preparation timed out"); }
        progress.send(Ok(Progress::Ready)).context("Paste coordinator stopped")?;
        Self::wait_for_paste(action);
        lease.restore()?;
        progress.send(Ok(Progress::Finished)).context("Paste coordinator stopped")?;
        Ok(())
    }

    fn wait_for_paste(action: Receiver<ClipboardAction>) {
        if matches!(action.recv(), Ok(ClipboardAction::Pasted)) {
            // Keep the offer alive while the target processes its paste shortcut.
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
    use std::os::unix::net::UnixStream;

    fn offered_contents(bytes: &[u8]) -> UnixStream {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(bytes).unwrap();
        reader
    }

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
    fn xwayland_browser_clipboard_preserves_usable_formats_and_skips_stalled_targets() {
        let expected = BTreeMap::from([
            ("text/plain;charset=utf-8".to_owned(), "café".as_bytes().to_vec()),
            ("text/html".to_owned(), b"<b>cafe</b>".to_vec()),
            ("text/_moz_htmlcontext".to_owned(), b"<body></body>".to_vec()),
        ]);
        let types = expected.keys().cloned().chain(["COMPOUND_TEXT".into(), "SAVE_TARGETS".into()]).collect();
        let deadline = Instant::now() + Duration::from_secs(1);
        let (_writer, stalled) = UnixStream::pair().unwrap();
        let snapshot = ClipboardLease::capture_formats(types, &AtomicBool::new(false), deadline, |mime| {
            match expected.get(mime) { Some(bytes) => Ok(offered_contents(bytes)), None => Ok(stalled.try_clone()?) }
        }).unwrap();
        assert_eq!(snapshot, expected);
    }

    #[test]
    fn a_stalled_required_format_aborts_instead_of_saving_partial_clipboard_data() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"partial").unwrap();
        let deadline = Instant::now() + Duration::from_millis(50);
        let error = ClipboardLease::capture_formats(HashSet::from(["text/html".into()]), &AtomicBool::new(false), deadline, |_| Ok(reader.try_clone()?)).unwrap_err();
        assert_eq!(error.to_string(), "Clipboard preservation timed out; left unchanged");
    }

    #[test]
    fn cancelled_clipboard_transfer_stops_before_reading_the_offer() {
        let cancelled = AtomicBool::new(false);
        let (_writer, reader) = UnixStream::pair().unwrap();
        let error = ClipboardLease::capture_formats(HashSet::from(["text/html".into()]), &cancelled, Instant::now() + Duration::from_secs(1), |_| {
            cancelled.store(true, Ordering::SeqCst);
            Ok(reader.try_clone()?)
        }).unwrap_err();
        assert_eq!(error.to_string(), "Paste cancelled");
    }

    #[test]
    fn clipboard_preservation_keeps_format_and_byte_limits() {
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(2);
        let formats = (0..65).map(|index| format!("application/test-{index}")).collect();
        let result = ClipboardLease::capture_formats::<UnixStream>(formats, &cancelled, deadline, |_| panic!("Too many formats"));
        assert_eq!(result.unwrap_err().to_string(), "Too many clipboard formats to preserve");

        let oversized = tempfile::tempfile().unwrap();
        oversized.set_len((ClipboardLease::MAX_BYTES + 1) as u64).unwrap();
        let result = ClipboardLease::capture_formats(HashSet::from(["text/html".into()]), &cancelled, deadline, |_| Ok(oversized.try_clone()?));
        assert_eq!(result.unwrap_err().to_string(), "Clipboard exceeds preservation limit; left unchanged");
    }

    #[test]
    fn compound_text_is_preserved_when_it_is_the_only_text_format() {
        let types = HashSet::from(["COMPOUND_TEXT".into(), "SAVE_TARGETS".into()]);
        let deadline = Instant::now() + Duration::from_secs(1);
        let snapshot = ClipboardLease::capture_formats(types, &AtomicBool::new(false), deadline, |mime| {
            assert_eq!(mime, "COMPOUND_TEXT");
            Ok(offered_contents(b"legacy"))
        }).unwrap();
        assert_eq!(snapshot, BTreeMap::from([("COMPOUND_TEXT".into(), b"legacy".to_vec())]));
    }
}
