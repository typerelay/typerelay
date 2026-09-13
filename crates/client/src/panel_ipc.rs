//! Private per-user IPC between the Omarchy keyboard service and search panel.
use crate::{editor::Paths, panel::{Hit, Panel}};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, os::unix::{fs::PermissionsExt, net::UnixDatagram}, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc}, time::Duration};

#[derive(Serialize, Deserialize)]
pub struct Request { pub hit: Hit, pub target: String, pub created_ms: u128 }
pub struct Insertion { pub deadline: std::time::Instant, pub text: String, pub target: String, pub reply: mpsc::Sender<std::result::Result<(), String>> }
pub struct PanelPresence(PathBuf);
impl Drop for PanelPresence { fn drop(&mut self) { let _=fs::remove_file(&self.0); } }
pub struct PanelIpc;
impl PanelIpc {
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
    pub fn engine(running: Arc<AtomicBool>) -> Result<mpsc::Receiver<Insertion>> {
        let path = Self::directory()?.join("engine.sock"); let _ = fs::remove_file(&path);
        let socket = UnixDatagram::bind(&path)?; socket.set_read_timeout(Some(Duration::from_millis(200)))?;
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = [0u8;16384];
            while running.load(Ordering::SeqCst) {
                let Ok((length, peer)) = socket.recv_from(&mut bytes) else { continue; };
                let Some(peer) = peer.as_pathname() else { continue; };
                let outcome: Result<()> = (|| {
                    let request: Request = serde_json::from_slice(&bytes[..length])?;
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
                    anyhow::ensure!(now >= request.created_ms && now - request.created_ms < 2000, "Insertion request expired; nothing inserted");
                    let text = Panel::selected(&Paths::config_dir()?.join("snippets"), &request.hit)?;
                    let elapsed=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis().saturating_sub(request.created_ms);
                    anyhow::ensure!(elapsed<2000,"Insertion request expired; nothing inserted");
                    let (reply, wait) = mpsc::channel();
                    tx.try_send(Insertion { deadline: std::time::Instant::now() + Duration::from_millis((2000-elapsed) as u64), text, target: request.target, reply }).context("Expansion service is busy")?;
                    wait.recv_timeout(Duration::from_secs(5)).context("Insertion timed out")?.map_err(anyhow::Error::msg)
                })();
                let result: std::result::Result<(),String> = outcome.map_err(|error|error.to_string());
                if let Ok(bytes) = serde_json::to_vec(&result) { let _ = socket.send_to(&bytes,peer); }
            }
            let _ = fs::remove_file(path);
        });
        Ok(rx)
    }
    pub fn insert(request: Request) -> Result<()> {
        let root = Self::directory()?; let path = root.join(format!("request-{}.sock",uuid::Uuid::new_v4()));
        let socket = UnixDatagram::bind(&path)?;
        let result = (|| {
            socket.set_read_timeout(Some(Duration::from_secs(6)))?;
            socket.connect(root.join("engine.sock")).context("Start the TypeRelay expansion service to insert")?;
            socket.send(&serde_json::to_vec(&request)?)?;
            let mut bytes = [0u8;4096]; let length = socket.recv(&mut bytes)?;
            serde_json::from_slice::<std::result::Result<(),String>>(&bytes[..length])?.map_err(anyhow::Error::msg)
        })();
        let _ = fs::remove_file(path); result
    }
}
