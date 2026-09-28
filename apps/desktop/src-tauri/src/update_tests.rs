use super::*;
use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};

struct Fixture { root: PathBuf, package: Package, pubkey: String }
impl Fixture {
    fn new() -> Self {
        // Public minisign-verify test vector: signed bytes are "test", not a production update/key.
        let key="untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature="untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        Self { root:std::env::temp_dir().join(format!("typerelay-update-test-{}",uuid::Uuid::new_v4())), package:Package { version:"9.0.0".into(),target:"linux-x86_64".into(),url:"https://example.invalid/update".into(),signature:STANDARD.encode(signature) }, pubkey:STANDARD.encode(key) }
    }
    fn prepare(&self, calls: &AtomicUsize, fail: bool) -> Result<Vec<u8>> {
        tauri::async_runtime::block_on(self.package.prepare(&self.root,&self.pubkey,async { calls.fetch_add(1,Ordering::SeqCst); anyhow::ensure!(!fail,"Download failed"); Ok(b"test".to_vec()) }))
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _=fs::remove_dir_all(&self.root); } }

#[test]
fn download_then_one_prompt_later_manual_and_next_launch() {
    let fixture=Fixture::new(); let calls=AtomicUsize::new(0); let mut status=Status::default();
    assert!(status.begin()); assert!(!status.offer(false));
    status.phase=Phase::Downloading; assert_eq!(status.menu(),("Downloading update…",false));
    fixture.prepare(&calls,false).unwrap(); status.version=Some(fixture.package.version.clone()); status.phase=Phase::Ready;
    assert!(status.offer(false)); assert_eq!(status.phase,Phase::Prompting); status.finish(true);
    assert_eq!(status.menu(),("Install update…",true));
    assert!(status.begin()); fixture.prepare(&calls,true).unwrap(); status.phase=Phase::Ready; assert!(!status.offer(false)); status.finish(true);
    assert!(status.begin()); fixture.prepare(&calls,true).unwrap(); status.phase=Phase::Ready; assert!(status.offer(true)); status.finish(true);
    let mut next_launch=Status::default(); assert!(next_launch.begin()); fixture.prepare(&calls,true).unwrap(); next_launch.version=Some(fixture.package.version.clone()); next_launch.phase=Phase::Ready; assert!(next_launch.offer(false));
    assert_eq!(calls.load(Ordering::SeqCst),1,"Later, manual retry and next launch must reuse the signed package");
}

#[test]
fn concurrent_checks_and_menu_clicks_acquire_one_operation() {
    let state=Arc::new(UpdateState::default()); let barrier=Arc::new(Barrier::new(12));
    let handles:Vec<_>=(0..12).map(|_| { let state=state.clone(); let barrier=barrier.clone(); std::thread::spawn(move|| { barrier.wait(); state.status.lock().unwrap().begin() }) }).collect();
    assert_eq!(handles.into_iter().filter_map(|thread|thread.join().ok()).filter(|started|*started).count(),1);
    for phase in [Phase::Checking,Phase::Downloading,Phase::Prompting,Phase::Installing] { let mut status=state.status.lock().unwrap(); status.phase=phase; assert!(!status.begin()); assert!(!status.menu().1); }
    state.status.lock().unwrap().finish(false); assert!(state.status.lock().unwrap().begin());
}

#[test]
fn failed_download_never_caches_or_offers_and_can_retry() {
    let fixture=Fixture::new(); let calls=AtomicUsize::new(0); let mut status=Status::default();
    assert!(status.begin()); assert!(fixture.prepare(&calls,true).is_err()); status.finish(false);
    assert_eq!(status.phase,Phase::Idle); assert!(!fixture.root.join("ready").exists()); assert!(!status.offer(false));
    assert!(status.begin()); assert_eq!(fixture.prepare(&calls,false).unwrap(),b"test"); status.version=Some(fixture.package.version.clone()); status.phase=Phase::Ready; assert!(status.offer(false)); assert_eq!(calls.load(Ordering::SeqCst),2);
}

#[test]
fn invalid_download_signature_never_becomes_ready() {
    let fixture=Fixture::new();
    let result=tauri::async_runtime::block_on(fixture.package.prepare(&fixture.root,&fixture.pubkey,async { Ok(b"tampered".to_vec()) }));
    assert!(result.is_err()); assert!(!fixture.root.join("ready").exists());
    assert!(fixture.package.verify(b"test","invalid key").is_err());
}

#[test]
fn corrupt_or_partial_cache_is_removed_and_downloaded_again() {
    let fixture=Fixture::new(); let calls=AtomicUsize::new(0); fixture.prepare(&calls,false).unwrap();
    let mut data=fs::read(fixture.root.join("ready")).unwrap(); *data.last_mut().unwrap()=0; fs::write(fixture.root.join("ready"),data).unwrap();
    assert_eq!(fixture.prepare(&calls,false).unwrap(),b"test"); assert_eq!(calls.load(Ordering::SeqCst),2);
    fs::write(fixture.root.join("ready"),b"partial metadata").unwrap();
    assert!(fixture.prepare(&calls,true).is_err()); assert!(!fixture.root.join("ready").exists());
}

#[test]
fn changed_feed_identity_discards_cached_package() {
    let fixture=Fixture::new();
    for field in ["version","target","url","signature"] {
        fixture.package.save(&fixture.root,b"test",&fixture.pubkey).unwrap();
        let mut changed=fixture.package.clone(); match field { "version"=>changed.version="9.0.1".into(), "target"=>changed.target="darwin-aarch64".into(), "url"=>changed.url.push_str("?changed"), _=>changed.signature="invalid".into() }
        assert!(changed.load(&fixture.root,&fixture.pubkey).unwrap().is_none()); assert!(!fixture.root.join("ready").exists());
    }
}

#[test]
fn successful_cache_write_is_complete_and_clear_removes_installed_update() {
    let fixture=Fixture::new(); fixture.package.save(&fixture.root,b"test",&fixture.pubkey).unwrap(); fixture.package.save(&fixture.root,b"test",&fixture.pubkey).unwrap();
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(),1); assert_eq!(fixture.package.load(&fixture.root,&fixture.pubkey).unwrap().unwrap(),b"test");
    Package::clear(&fixture.root).unwrap(); Package::clear(&fixture.root).unwrap(); assert!(fixture.package.load(&fixture.root,&fixture.pubkey).unwrap().is_none());
}

#[test]
fn failed_install_keeps_package_for_manual_retry_without_auto_nag() {
    let fixture=Fixture::new(); let calls=AtomicUsize::new(0); fixture.prepare(&calls,false).unwrap();
    let mut status=Status { version:Some(fixture.package.version.clone()),..Status::default() }; assert!(status.begin()); status.phase=Phase::Ready; assert!(status.offer(false)); status.phase=Phase::Installing;
    status.finish(true); assert_eq!(status.menu(),("Install update…",true)); assert!(!status.offer(false));
    assert!(status.begin()); status.phase=Phase::Ready; assert!(status.offer(true)); fixture.prepare(&calls,true).unwrap(); assert_eq!(calls.load(Ordering::SeqCst),1);
}

#[test]
fn state_payload_keeps_legacy_fields_and_reports_phase() {
    let state=UpdateState::default(); assert_eq!(state.value(),json!({"checking":false,"installing":false,"version":null,"phase":"idle"}));
    {let mut status=state.status.lock().unwrap(); status.begin(); status.phase=Phase::Installing; status.version=Some("9.0.0".into());}
    assert_eq!(state.value(),json!({"checking":true,"installing":true,"version":"9.0.0","phase":"installing"}));
}
