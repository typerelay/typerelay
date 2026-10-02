//! Private per-user IPC between the Omarchy keyboard service and search panel.
use crate::{editor::Paths, panel::{Hit, Panel}};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{io::{Read,Write}, collections::BTreeMap};
use crate::clipboard_payload::ClipboardStep;
use std::{fs, os::unix::{fs::PermissionsExt, net::{UnixDatagram,UnixListener,UnixStream}}, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc}, time::Duration};

#[derive(Serialize, Deserialize)]
pub struct Request { pub hit: Hit, pub target: String, pub created_ms: u128, #[serde(default)] pub values: BTreeMap<String,String>, #[serde(default)] pub clock:Option<(i64,i32)>, #[serde(default)] pub generation:Option<u64>, #[serde(default)] pub erase: usize, #[serde(default)] pub prepare: bool }
#[derive(Serialize,Deserialize)]
pub struct Prompt { pub hit: Hit, pub target: String, pub erase: usize, pub generation:u64, pub created_ms:u128 }
pub struct Insertion { pub deadline: std::time::Instant, pub step: ClipboardStep, pub erase: usize, pub generation: Option<u64>, pub target: String, pub reply: mpsc::Sender<std::result::Result<u64, String>> }
pub struct PanelPresence(PathBuf);
impl Drop for PanelPresence { fn drop(&mut self) { let _=fs::remove_file(&self.0); } }
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(default,deny_unknown_fields)]
pub struct CaptureControl { pub version:u32,pub session:String,pub enabled:bool,pub expires_ms:i64,pub protected_app:Option<String>,pub excluded_apps:Vec<String> }
pub use crate::observation::CaptureHealth;
#[derive(Serialize,Deserialize)]
pub enum CaptureBody { Frame(crate::observation::CaptureFrame),Health(CaptureHealth) }
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct CapturePacket { version:u32,session:String,worker:u32,body:CaptureBody }
pub struct CaptureReceiver {socket:UnixDatagram,path:PathBuf}
impl CaptureReceiver {
    pub fn bind()->Result<Self>{Self::bind_path(PanelIpc::directory()?.join("capture.sock"))}
    fn bind_path(path:PathBuf)->Result<Self>{use std::os::fd::AsRawFd;let _=fs::remove_file(&path);let socket=UnixDatagram::bind(&path)?;socket.set_nonblocking(true)?;fs::set_permissions(&path,fs::Permissions::from_mode(0o600))?;let yes:libc::c_int=1;anyhow::ensure!(unsafe{libc::setsockopt(socket.as_raw_fd(),libc::SOL_SOCKET,libc::SO_PASSCRED,(&yes as *const libc::c_int).cast(),std::mem::size_of_val(&yes) as _)}==0,"Could not authenticate capture peer");Ok(Self{socket,path})}
    pub fn receive(&self,session:&str)->Result<Option<CaptureBody>>{use std::os::fd::AsRawFd;
        let mut bytes=[0u8;16384];let mut control=[0usize;16];let mut iov=libc::iovec{iov_base:bytes.as_mut_ptr().cast(),iov_len:bytes.len()};let mut message:libc::msghdr=unsafe{std::mem::zeroed()};message.msg_iov=&mut iov;message.msg_iovlen=1;message.msg_control=control.as_mut_ptr().cast();message.msg_controllen=std::mem::size_of_val(&control);
        let length=unsafe{libc::recvmsg(self.socket.as_raw_fd(),&mut message,libc::MSG_DONTWAIT)};
        if length<0{let error=std::io::Error::last_os_error();if error.kind()==std::io::ErrorKind::WouldBlock{return Ok(None);}return Err(error.into());}
        if message.msg_flags&(libc::MSG_TRUNC|libc::MSG_CTRUNC)!=0{return Ok(None);}
        let mut peer=None;unsafe{let mut header=libc::CMSG_FIRSTHDR(&message);while !header.is_null(){if (*header).cmsg_level==libc::SOL_SOCKET&&(*header).cmsg_type==libc::SCM_CREDENTIALS{peer=Some(std::ptr::read_unaligned(libc::CMSG_DATA(header).cast::<libc::ucred>()));}header=libc::CMSG_NXTHDR(&message,header);}}
        let Some(peer)=peer.filter(|peer|peer.uid==unsafe{libc::geteuid()})else{return Ok(None);};let Ok(packet)=serde_json::from_slice::<CapturePacket>(&bytes[..length as usize])else{return Ok(None);};
        if packet.version!=1||packet.session!=session||packet.worker!=peer.pid as u32{return Ok(None);}
        let Some((pid,start))=PanelIpc::capture_worker(self.path.parent().context("Missing capture directory")?)?else{return Ok(None);};if pid!=packet.worker||PanelIpc::process_start(pid).ok().as_ref()!=Some(&start){return Ok(None);}
        Ok(Some(packet.body))
    }
}
impl Drop for CaptureReceiver {fn drop(&mut self){let _=fs::remove_file(&self.path);}}
pub struct PanelIpc;
impl PanelIpc {
    pub fn capture_control()->Result<CaptureControl>{let path=Self::directory()?.join("capture-control.json");match fs::read(path){Ok(bytes)if bytes.len()<=131072=>Ok(serde_json::from_slice(&bytes)?),Ok(_)=>anyhow::bail!("Capture control exceeds limit"),Err(error)if error.kind()==std::io::ErrorKind::NotFound=>Ok(CaptureControl::default()),Err(error)=>Err(error.into())}}
    pub fn configure_capture(control:&CaptureControl)->Result<()>{Paths::atomic_write(&Self::directory()?.join("capture-control.json"),&serde_json::to_vec(control)?,false)}
    pub fn register_capture_worker()->Result<()> {Paths::atomic_write(&Self::directory()?.join("capture-worker.json"),&serde_json::to_vec(&(std::process::id(),Self::process_start(std::process::id())?))?,false)}
    fn capture_worker(directory:&std::path::Path)->Result<Option<(u32,String)>> {let path=directory.join("capture-worker.json");match fs::read(path){Ok(bytes)if bytes.len()<=4096=>Ok(Some(serde_json::from_slice(&bytes)?)),_=>Ok(None)}}
    pub fn send_capture(socket:&UnixDatagram,session:&str,body:CaptureBody)->Result<()> {let bytes=serde_json::to_vec(&CapturePacket{version:1,session:session.into(),worker:std::process::id(),body})?;anyhow::ensure!(bytes.len()<=16384,"Capture event exceeds limit");socket.send_to(&bytes,Self::directory()?.join("capture.sock"))?;Ok(())}
    pub fn directory() -> Result<PathBuf> {
        let root = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").context("Missing user runtime directory")?).join("typerelay-panel");
        fs::create_dir_all(&root)?; fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?; Ok(root)
    }
    pub fn register() -> Result<PanelPresence> {
        let path=Self::directory()?.join("process.json");
        let pid=std::process::id(); let start=Self::process_start(pid)?;
        Paths::atomic_write(&path,&serde_json::to_vec(&(pid,start))?,false)?; Ok(PanelPresence(path))
    }
    fn process_start(pid:u32)->Result<String> { Ok(fs::read_to_string(format!("/proc/{pid}/stat"))?.rsplit_once(") ").context("Invalid process")?.1.split_whitespace().nth(19).context("Missing process identity")?.into()) }
    pub fn owns_window(pid:u32)->bool { (||->Result<bool>{let (owner,start):(u32,String)=serde_json::from_slice(&fs::read(PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").context("Missing runtime directory")?).join("typerelay-panel/process.json"))?)?;Ok(owner==pid && Self::process_start(pid)?==start)})().unwrap_or(false) }
    pub fn notify() -> bool {
        Self::directory().and_then(|root| { let pid=fs::read_to_string(root.join("ready"))?.parse::<u32>()?; anyhow::ensure!(Self::owns_window(pid),"Panel is not running"); let socket=UnixDatagram::unbound()?;socket.set_nonblocking(true)?;socket.send_to(b"show",root.join("events.sock"))?; Ok(()) }).is_ok()
    }

    pub fn prompt(prompt: Prompt) -> bool {
        Self::directory().and_then(|root| { let pid=fs::read_to_string(root.join("ready"))?.parse::<u32>()?; anyhow::ensure!(Self::owns_window(pid),"Panel is not running"); let socket=UnixDatagram::unbound()?; socket.set_nonblocking(true)?; socket.send_to(&serde_json::to_vec(&prompt)?,root.join("events.sock"))?; Ok(()) }).is_ok()
    }
    pub fn execute(tx: &mpsc::SyncSender<Insertion>, hit: &Hit, target: &str, steps: Vec<ClipboardStep>, erase: usize, generation: Option<u64>) -> Result<()> {
		let steps = if steps.is_empty() { vec![ClipboardStep::Payload(crate::clipboard_payload::ClipboardPayload::text(String::new()))] } else { steps };
        let record_usage=steps.iter().any(|step| match step { ClipboardStep::Payload(payload)=> !payload.plain.is_empty() || payload.html.is_some(), ClipboardStep::Enter=>true });let characters=Panel::usage_characters(&steps,erase);
        let mut expected_generation=generation;
        for (index, step) in steps.into_iter().enumerate() {
            Panel::content(&Paths::config_dir()?.join("snippets"),hit)?;
            let (reply, wait)=mpsc::channel();
            tx.try_send(Insertion { deadline: std::time::Instant::now()+Duration::from_secs(2), step, erase: if index == 0 {erase} else {0}, generation:expected_generation, target:target.into(), reply }).context("Expansion service is busy")?;
            expected_generation=Some(wait.recv_timeout(Duration::from_secs(5)).context("Insertion timed out; no automatic retry")?.map_err(anyhow::Error::msg)?);
        }
        if record_usage { Panel::record_usage(&Paths::config_dir()?.join("snippets"),hit,"insert","desktop",characters); }
        Ok(())
    }
    pub fn engine(running: Arc<AtomicBool>) -> Result<(mpsc::Receiver<Insertion>,mpsc::SyncSender<Insertion>)> {
        let path=Self::directory()?.join("engine.sock"); let _=fs::remove_file(&path);
        let listener=UnixListener::bind(&path)?; fs::set_permissions(&path,fs::Permissions::from_mode(0o600))?; listener.set_nonblocking(true)?;
        let (tx,rx)=mpsc::sync_channel(1); let background=tx.clone();
        std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                let Ok((mut stream,_))=listener.accept() else { std::thread::sleep(Duration::from_millis(20)); continue; };
                let result=(|| -> Result<()> {
                    stream.set_read_timeout(Some(Duration::from_secs(2)))?; stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                    let mut size=[0u8;4]; stream.read_exact(&mut size)?; let length=u32::from_le_bytes(size) as usize;
                    anyhow::ensure!(length<=1048576,"Template input exceeds IPC limit");
                    let mut bytes=vec![0;length]; stream.read_exact(&mut bytes)?;
                    let request:Request=serde_json::from_slice(&bytes)?;
                    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
                    anyhow::ensure!(now>=request.created_ms && now-request.created_ms<2000 && request.erase<=64,"Insertion request expired or invalid");
					let steps=if request.prepare { Panel::content(&Paths::config_dir()?.join("snippets"),&request.hit)?; vec![] } else { Panel::steps_at(&Paths::config_dir()?.join("snippets"),&request.hit,request.values,false,request.clock.unwrap_or_else(crate::templates::Templates::clock))? };
                    anyhow::ensure!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis().saturating_sub(request.created_ms)<2000,"Insertion preparation expired; nothing inserted");
                    Self::execute(&background,&request.hit,&request.target,steps,request.erase,request.generation)
                })().map_err(|error|error.to_string());
                if let Ok(bytes)=serde_json::to_vec(&result) { let _=stream.write_all(&bytes); }
            }
            let _=fs::remove_file(path);
        });
        Ok((rx,tx))
    }
    pub fn insert(request:Request)->Result<()> {
        let bytes=serde_json::to_vec(&request)?; anyhow::ensure!(bytes.len()<=1048576,"Template input exceeds IPC limit");
        let mut stream=UnixStream::connect(Self::directory()?.join("engine.sock")).context("Start the TypeRelay expansion service to insert")?;
        stream.set_read_timeout(Some(Duration::from_secs(360)))?; stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(&(bytes.len() as u32).to_le_bytes())?; stream.write_all(&bytes)?;
        let mut bytes=Vec::new(); stream.take(4096).read_to_end(&mut bytes)?;
        serde_json::from_slice::<std::result::Result<(),String>>(&bytes)?.map_err(anyhow::Error::msg)
    }
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    #[test]
    fn authenticates_worker_session_version_and_process_lifetime() {
        let directory=tempfile::tempdir().unwrap();let receiver=CaptureReceiver::bind_path(directory.path().join("capture.sock")).unwrap();let sender=UnixDatagram::unbound().unwrap();sender.set_nonblocking(true).unwrap();
        let pid=std::process::id();let registration=directory.path().join("capture-worker.json");fs::write(&registration,serde_json::to_vec(&(pid,PanelIpc::process_start(pid).unwrap())).unwrap()).unwrap();
        let packet=|version,session:&str,worker|serde_json::to_vec(&CapturePacket{version,session:session.into(),worker,body:CaptureBody::Health(CaptureHealth::default())}).unwrap();
        for invalid in [packet(2,"test",pid),packet(1,"old",pid),packet(1,"test",pid+1),b"invalid".to_vec(),vec![0;20000]]{sender.send_to(&invalid,&receiver.path).unwrap();assert!(receiver.receive("test").unwrap().is_none());}
        sender.send_to(&packet(1,"test",pid),&receiver.path).unwrap();assert!(matches!(receiver.receive("test").unwrap(),Some(CaptureBody::Health(_))));
        fs::write(&registration,serde_json::to_vec(&(pid,"different-start-time")).unwrap()).unwrap();sender.send_to(&packet(1,"test",pid),&receiver.path).unwrap();assert!(receiver.receive("test").unwrap().is_none());
    }
    #[test]
    fn socket_backpressure_and_disconnect_do_not_block_sender() {
        let directory=tempfile::tempdir().unwrap();let receiver=CaptureReceiver::bind_path(directory.path().join("capture.sock")).unwrap();let sender=UnixDatagram::unbound().unwrap();sender.set_nonblocking(true).unwrap();let start=std::time::Instant::now();let mut full=false;for _ in 0..1000{if sender.send_to(b"metadata",&receiver.path).is_err(){full=true;}}assert!(full);assert!(start.elapsed()<Duration::from_secs(1));let path=receiver.path.clone();drop(receiver);assert!(sender.send_to(b"metadata",path).is_err());
    }
}
