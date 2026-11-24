//! Run only in the isolated test environment created by scripts/tests/test_panel_ipc.py.
#[cfg(target_os="linux")]
fn main()->anyhow::Result<()> {
    use typerelay_client::{database::Database,editor::Paths,panel::Panel,panel_ipc::{PanelIpc,Request}};
    use std::{sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
    anyhow::ensure!(std::env::var("TYPERELAY_PANEL_PROBE").as_deref()==Ok("1"),"Run through the isolated Python regression test");
    let root=Paths::config_dir()?;let directory=root.join("snippets");let db=Database::open(&directory)?;db.import("Probe","matches: [{trigger: test, replace: Safe}]")?;
    let hit=Panel::search(&directory,"test", None)?.remove(0);
    let running=Arc::new(AtomicBool::new(true));let (receiver,_)=PanelIpc::engine(running.clone())?;
    assert!(PanelIpc::insert(Request{clock:None,generation:None,values:Default::default(),erase:0,prepare:false,confirm_enter:false,hit:hit.clone(),target:"probe".into(),created_ms:0}).is_err());assert!(receiver.try_recv().is_err());
    let selected=hit.clone();let client=std::thread::spawn(move||PanelIpc::insert(Request{clock:None,generation:None,values:Default::default(),erase:0,prepare:false,confirm_enter:false,hit:selected,target:"probe".into(),created_ms:SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}));
	let request=receiver.recv_timeout(Duration::from_secs(2))?;assert_eq!(request.step,typerelay_client::clipboard_payload::ClipboardStep::Payload(typerelay_client::clipboard_payload::ClipboardPayload::text("Safe".into())));assert_eq!(request.target,"probe");request.reply.send(Ok(0))?;client.join().unwrap()?;
    for (prepare,confirm_enter,fail) in [(false,true,false),(false,true,true),(true,true,false)] {
        let selected=hit.clone();let client=std::thread::spawn(move||PanelIpc::insert(Request{clock:None,generation:None,values:Default::default(),erase:0,prepare,confirm_enter,hit:selected,target:"probe".into(),created_ms:SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}));
        let request=receiver.recv_timeout(Duration::from_secs(2))?;assert!(matches!(request.step,typerelay_client::clipboard_payload::ClipboardStep::Payload(_)));
        request.reply.send(if fail{Err("cancelled".into())}else{Ok(1)})?;
        if !prepare&&!fail {let request=receiver.recv_timeout(Duration::from_secs(2))?;assert_eq!(request.step,typerelay_client::clipboard_payload::ClipboardStep::Enter);assert_eq!(request.generation,Some(1));request.reply.send(Ok(2))?;}
        assert_eq!(client.join().unwrap().is_err(),fail);assert!(receiver.try_recv().is_err());
    }
    use typerelay_client::clipboard_payload::{ClipboardPayload,ClipboardStep};
    db.import("Tabs","matches:\n- trigger: form\n  type: template\n  replace: '{{name}}{{key:tab}}second{{key:enter}}last'\n")?;
    let hit=Panel::search(&directory,"form",None)?.remove(0);
    for interrupt_after_tab in [false,true] {
        let selected=hit.clone();
        let client=std::thread::spawn(move||PanelIpc::insert(Request{
            clock:None,generation:Some(10),values:[("name".into(),"first".into())].into(),erase:4,prepare:false,confirm_enter:true,
            hit:selected,target:"probe".into(),created_ms:SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),
        }));
        let steps=[
            ClipboardStep::Payload(ClipboardPayload::text("first".into())),
            ClipboardStep::Tab,
            ClipboardStep::Payload(ClipboardPayload::text("second".into())),
            ClipboardStep::Enter,
            ClipboardStep::Payload(ClipboardPayload::text("last".into())),
        ];
        for (index,step) in steps.into_iter().enumerate() {
            let request=receiver.recv_timeout(Duration::from_secs(2))?;
            assert_eq!(request.step,step);
            assert_eq!(request.target,"probe");
            assert_eq!(request.erase,if index==0 {4}else{0});
            assert_eq!(request.generation,Some(10+index as u64));
            if index==2&&interrupt_after_tab {
                request.reply.send(Err("Original window lost focus".into()))?;
                break;
            }
            request.reply.send(Ok(11+index as u64))?;
        }
        assert_eq!(client.join().unwrap().is_err(),interrupt_after_tab);
        assert!(receiver.try_recv().is_err());
    }
    let _presence=PanelIpc::register()?;assert!(PanelIpc::owns_window(std::process::id()));assert!(!PanelIpc::notify());
    let root=PanelIpc::directory()?;let _socket=std::os::unix::net::UnixDatagram::bind(root.join("events.sock"))?;std::fs::write(root.join("ready"),std::process::id().to_string())?;
    let start=std::time::Instant::now();for _ in 0..100 {let _=PanelIpc::notify();}assert!(start.elapsed()<Duration::from_secs(1),"Notifier blocked on a full socket");
    running.store(false,Ordering::SeqCst);Ok(())
}
#[cfg(not(target_os="linux"))]
fn main() {}
