//! Private per-user IPC between the Omarchy keyboard service and search panel.
use crate::{editor::Paths, panel::{Hit, Panel}};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{io::{Read,Write}, collections::BTreeMap};
use typerelay_core::template::Step;
use std::{fs, os::unix::{fs::PermissionsExt, net::{UnixDatagram,UnixListener,UnixStream}}, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc}, time::Duration};

#[derive(Serialize, Deserialize)]
pub struct Request { pub hit: Hit, pub target: String, pub created_ms: u128, #[serde(default)] pub values: BTreeMap<String,String>, #[serde(default)] pub clock:Option<(i64,i32)>, #[serde(default)] pub generation:Option<u64>, #[serde(default)] pub erase: usize, #[serde(default)] pub prepare: bool }
#[derive(Serialize,Deserialize)]
pub struct Prompt { pub hit: Hit, pub target: String, pub erase: usize, pub generation:u64, pub created_ms:u128 }
pub struct Insertion { pub deadline: std::time::Instant, pub step: Step, pub erase: usize, pub generation: Option<u64>, pub target: String, pub reply: mpsc::Sender<std::result::Result<u64, String>> }
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

    pub fn prompt(prompt: Prompt) -> bool {
        Self::directory().and_then(|root| { let pid=fs::read_to_string(root.join("ready"))?.parse::<u32>()?; anyhow::ensure!(Self::owns_window(pid),"Panel is not running"); let socket=UnixDatagram::unbound()?; socket.set_nonblocking(true)?; socket.send_to(&serde_json::to_vec(&prompt)?,root.join("events.sock"))?; Ok(()) }).is_ok()
    }
    pub fn execute(tx: &mpsc::SyncSender<Insertion>, hit: &Hit, target: &str, steps: Vec<Step>, erase: usize, generation: Option<u64>) -> Result<()> {
        let steps = if steps.is_empty() { vec![Step::Text {text:String::new()}] } else { steps };
        let mut expected_generation=generation;
        for (index, step) in steps.into_iter().enumerate() {
            Panel::content(&Paths::config_dir()?.join("snippets"),hit)?;
            let (reply, wait)=mpsc::channel();
            tx.try_send(Insertion { deadline: std::time::Instant::now()+Duration::from_secs(2), step, erase: if index == 0 {erase} else {0}, generation:expected_generation, target:target.into(), reply }).context("Expansion service is busy")?;
            expected_generation=Some(wait.recv_timeout(Duration::from_secs(5)).context("Insertion timed out; no automatic retry")?.map_err(anyhow::Error::msg)?);
        }
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
                    let steps=if request.prepare { Panel::content(&Paths::config_dir()?.join("snippets"),&request.hit)?; vec![] } else { Panel::render_at(&Paths::config_dir()?.join("snippets"),&request.hit,request.values,false,request.clock.unwrap_or_else(crate::templates::Templates::clock))?.steps };
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
