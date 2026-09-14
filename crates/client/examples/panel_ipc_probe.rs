//! Run only in the isolated test environment created by scripts/tests/test_panel_ipc.py.
#[cfg(target_os="linux")]
fn main()->anyhow::Result<()> {
    use typerelay_client::{database::Database,editor::Paths,panel::Panel,panel_ipc::{PanelIpc,Request}};
    use std::{sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
    anyhow::ensure!(std::env::var("TYPERELAY_PANEL_PROBE").as_deref()==Ok("1"),"Run through the isolated Python regression test");
    let root=Paths::config_dir()?;let directory=root.join("snippets");let db=Database::open(&directory)?;db.import("Probe","matches: [{trigger: test, replace: Safe}]")?;
    let hit=Panel::search(&directory,"test")?.remove(0);
    let running=Arc::new(AtomicBool::new(true));let (receiver,_)=PanelIpc::engine(running.clone())?;
    assert!(PanelIpc::insert(Request{clock:None,generation:None,values:Default::default(),erase:0,prepare:false,hit:hit.clone(),target:"probe".into(),created_ms:0}).is_err());assert!(receiver.try_recv().is_err());
    let client=std::thread::spawn(move||PanelIpc::insert(Request{clock:None,generation:None,values:Default::default(),erase:0,prepare:false,hit,target:"probe".into(),created_ms:SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}));
    let request=receiver.recv_timeout(Duration::from_secs(2))?;assert_eq!(request.step,typerelay_core::template::Step::Text{text:"Safe".into()});assert_eq!(request.target,"probe");request.reply.send(Ok(0))?;client.join().unwrap()?;
    let _presence=PanelIpc::register()?;assert!(PanelIpc::owns_window(std::process::id()));assert!(!PanelIpc::notify());
    let root=PanelIpc::directory()?;let _socket=std::os::unix::net::UnixDatagram::bind(root.join("events.sock"))?;std::fs::write(root.join("ready"),std::process::id().to_string())?;
    let start=std::time::Instant::now();for _ in 0..100 {let _=PanelIpc::notify();}assert!(start.elapsed()<Duration::from_secs(1),"Notifier blocked on a full socket");
    running.store(false,Ordering::SeqCst);Ok(())
}
#[cfg(not(target_os="linux"))]
fn main() {}
