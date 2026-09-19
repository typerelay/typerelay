use crate::{database::Database, editor::Paths};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::{ErrorKind, Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf}, sync::atomic::{AtomicBool,Ordering}, time::{Duration, Instant}};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials { pub server: String, pub access_token: String, pub refresh_token: String, #[serde(default)] pub account: Option<String>, #[serde(default)] pub device: Option<String> }
#[derive(Debug)]
pub struct ServerError { pub status: u16, message: String }
impl std::fmt::Display for ServerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(formatter, "Server {}: {}", self.status, self.message) }
}
impl std::error::Error for ServerError {}
impl ServerError {
    fn rejected(error: &anyhow::Error, batch: bool) -> bool {
        let status = error.downcast_ref::<Self>().map(|error|error.status);
        matches!(status, Some(403 | 404 | 409 | 410)) || (batch && matches!(status, Some(400 | 422)))
    }
}

pub struct Sync { root: PathBuf, directory: PathBuf, client: reqwest::blocking::Client }
impl Sync {
    pub fn new(root: PathBuf, directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("sync"))?;
        fs::create_dir_all(&directory)?;
		#[cfg_attr(not(target_os="linux"),allow(unused_mut))]
        let mut builder=reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none());
        #[cfg(target_os="linux")]
        if let Some(home)=std::env::var_os("HOME"){let database=PathBuf::from(home).join(".pki/nssdb");let certutil=Path::new("/usr/bin/certutil");if database.is_dir()&&certutil.is_file(){let database=format!("sql:{}",database.display());if let Ok(output)=std::process::Command::new(certutil).args(["-L","-d",&database]).output(){for nickname in Self::trusted_nss_nicknames(&String::from_utf8_lossy(&output.stdout)).into_iter().take(64){if let Ok(output)=std::process::Command::new(certutil).args(["-L","-d",&database,"-n",&nickname,"-a"]).output()&&output.status.success()&&let Ok(certificate)=reqwest::Certificate::from_pem(&output.stdout){builder=builder.add_root_certificate(certificate);}}}}}
        Ok(Self { root, directory, client: builder.build()? })
    }
    #[cfg(target_os="linux")]
    fn trusted_nss_nicknames(list:&str)->Vec<String>{list.lines().filter_map(|line|{let line=line.trim();let(index,trust)=line.char_indices().rev().find(|(_,character)|character.is_whitespace()).map(|(index,_)|(index,line[index..].trim()))?;if trust.split(',').next().is_some_and(|flags|flags.contains('C')){Some(line[..index].trim().into())}else{None}}).collect()}
    fn path(&self, name: &str) -> PathBuf { self.root.join("sync").join(name) }
    fn lock(&self) -> Result<fs::File> {
        let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(self.path("worker.lock"))?;
        file.try_lock_exclusive().context("Sync already running")?;
        Ok(file)
    }
    fn credentials(&self) -> Result<Credentials> { Ok(serde_json::from_slice(&fs::read(self.path("credentials.json")).context("Connect first: typerelay connect --server URL")?)?) }
    fn secret(&self, credentials: &Credentials) -> Result<()> {
        Paths::atomic_write(&self.path("credentials.json"), &serde_json::to_vec(credentials)?, false)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(self.path("credentials.json"), fs::Permissions::from_mode(0o600))?; }
        Ok(())
    }
    fn response(response: reqwest::blocking::Response) -> Result<Value> {
        let status = response.status();
        let value: Value = response.json()?;
        if !status.is_success() { return Err(ServerError { status: status.as_u16(), message: if status.as_u16()==426 {"Server and client versions must match: rich text requires sync protocol 6".into()}else{value["error"].as_str().unwrap_or("Request failed").into()} }.into()); }
        Ok(value)
    }
    fn callback(stream: &mut TcpStream, state: &str, timeout: Duration) -> Result<Option<BTreeMap<String, String>>> {
        stream.set_read_timeout(Some(timeout))?;
        let mut buffer = [0u8; 8192];
        let length = match stream.read(&mut buffer) { Ok(0) => return Ok(None), Ok(length) => length, Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => return Ok(None), Err(error) => return Err(error.into()) };
        let Ok(request) = std::str::from_utf8(&buffer[..length]) else { return Ok(None); };
        let target = request.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("/");
        let Ok(callback) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { return Ok(None); };
        let params: BTreeMap<_, _> = callback.query_pairs().into_owned().collect();
        if callback.path() != "/callback" || params.get("state").map(String::as_str) != Some(state) { let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return Ok(None); }
        Ok(Some(params))
    }
    fn request(&self, credentials: &mut Credentials, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let send = |credentials: &Credentials| {
            let request = self.client.request(method.clone(), format!("{}/api/v2/{path}", credentials.server)).bearer_auth(&credentials.access_token).header("X-TypeRelay-Sync-Protocol", "6");
            if let Some(body) = body { request.json(body).send() } else { request.send() }
        };
        let mut response = send(credentials)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && !credentials.refresh_token.is_empty() {
            let tokens = Self::response(self.client.post(format!("{}/oauth/token", credentials.server)).json(&json!({"grant_type":"refresh_token","refresh_token":credentials.refresh_token})).send()?)?;
            credentials.access_token = tokens["access_token"].as_str().context("Missing access token")?.into();
            credentials.refresh_token = tokens["refresh_token"].as_str().context("Missing refresh token")?.into();
			credentials.account=tokens["account"].as_str().map(str::to_owned).or(credentials.account.take());credentials.device=tokens["device"].as_str().map(str::to_owned).or(credentials.device.take());
            self.secret(credentials)?;
            response = send(credentials)?;
        }
        Self::response(response)
    }
	fn asset_request(&self,credentials:&Credentials,method:reqwest::Method,id:&str,mime:Option<&str>,body:Option<Vec<u8>>)->Result<reqwest::blocking::Response>{
		let mut request=self.client.request(method,format!("{}/api/v2/assets/{id}",credentials.server)).bearer_auth(&credentials.access_token).header("X-TypeRelay-Sync-Protocol","6");
		if let Some(mime)=mime{request=request.header(reqwest::header::CONTENT_TYPE,mime);}
		if let Some(body)=body{request=request.body(body);}
		let response=request.send()?;
		if !response.status().is_success(){let status=response.status();let message=response.text().unwrap_or_default();return Err(ServerError{status:status.as_u16(),message:serde_json::from_str::<Value>(&message).ok().and_then(|value|value["error"].as_str().map(str::to_owned)).unwrap_or_else(||"Asset transfer failed".into())}.into());}
		Ok(response)
	}
	pub fn download_asset(&self, credentials: &Credentials, db: &Database, metadata: &Value) -> Result<()> {
        let id = metadata["id"].as_str().context("Missing asset ID")?;
        ensure!(id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()), "Invalid asset ID");
        if db.asset(id)?.is_some() { return Ok(()); }
        let size = metadata["size"].as_u64().context("Missing asset size")?;
        ensure!(size > 0 && size <= 2 * 1048576, "Invalid asset size");
        let mut bytes = Vec::new();
        self.asset_request(credentials, reqwest::Method::GET, id, None, None)?.take(2 * 1048576 + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() == size as usize, "Asset size mismatch");
        ensure!(format!("{:x}", Sha256::digest(&bytes)) == id, "Asset hash mismatch");
        db.put_asset(metadata, &bytes, true)
    }
    fn download_assets(&self, credentials: &Credentials, db: &Database, response: &Value) -> Result<()> { for metadata in response["assets"].as_array().into_iter().flatten() { self.download_asset(credentials, db, metadata)?; } Ok(()) }

	fn upload_assets(&self,credentials:&Credentials,db:&Database)->Result<()> {for (metadata,bytes) in db.pending_assets()?{let id=metadata["id"].as_str().context("Missing asset ID")?;self.asset_request(credentials,reqwest::Method::PUT,id,metadata["mime_type"].as_str(),Some(bytes))?;db.mark_asset_uploaded(id)?;}Ok(())}
    pub fn connect(&self, server: &str, open_browser: bool, app_callback: bool) -> Result<()> {
		self.connect_cancellable(server,open_browser,app_callback,&AtomicBool::new(false))
	}
	pub fn connect_cancellable(&self, server: &str, open_browser: bool, app_callback: bool, cancelled:&AtomicBool) -> Result<()> {
        let _lock = self.lock()?;
        ensure!(!self.path("credentials.json").exists(), "Already connected; disconnect before changing accounts");
        let server = server.trim_end_matches('/');
        let url = url::Url::parse(server)?;
        ensure!(url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))), "Use HTTPS (HTTP is permitted only on loopback)");
        ensure!(url.path() == "/" && url.query().is_none() && url.fragment().is_none() && url.username().is_empty(), "Use the server origin without a path or credentials");
        let mut settings = crate::settings::SettingsStore::open(self.root.join("settings.yml"))?; let prefix=settings.settings.trigger_prefix.clone();settings.save(server,&prefix)?;
        let listener = if app_callback { None } else { let listener = TcpListener::bind("127.0.0.1:0")?; listener.set_nonblocking(true)?; Some(listener) };
        let redirect = listener.as_ref().map(|listener|format!("http://127.0.0.1:{}/callback",listener.local_addr().unwrap().port())).unwrap_or_else(||"typerelay://oauth/callback".into());
        let callback_path = self.path("oauth-callback"); let _ = fs::remove_file(&callback_path);
        let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let state = Uuid::new_v4().simple().to_string();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorize = url::Url::parse(&format!("{server}/oauth/authorize"))?;
        authorize.query_pairs_mut().extend_pairs([("client_id", "typerelay-desktop"), ("redirect_uri", &redirect), ("code_challenge", &challenge), ("code_challenge_method", "S256"), ("state", &state), ("device_name", if app_callback { "TypeRelay desktop" } else { "TypeRelay CLI / TUI" }), ("client_type", if app_callback { "desktop" } else { "cli" })]);
        if matches!(std::env::consts::OS, "macos" | "windows" | "linux") { authorize.query_pairs_mut().append_pair("os", std::env::consts::OS); }
        println!("Open this URL in your browser:\n{authorize}");
        #[cfg(target_os = "linux")] { if open_browser { let _ = std::process::Command::new("xdg-open").arg(authorize.as_str()).spawn(); } }
        #[cfg(target_os = "macos")] { if open_browser { std::process::Command::new("open").arg(authorize.as_str()).spawn()?; } }
        #[cfg(target_os = "windows")] { if open_browser { std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", authorize.as_str()]).spawn()?; } }
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
			ensure!(!cancelled.load(Ordering::SeqCst),"Authentication cancelled");
            ensure!(Instant::now() < deadline, "Browser sign-in timed out");
            if app_callback && let Ok(callback) = fs::read_to_string(&callback_path) {
				let _ = fs::remove_file(&callback_path); let Ok(callback) = url::Url::parse(&callback)else{continue;};
				if callback.scheme()!="typerelay"||callback.host_str()!=Some("oauth")||callback.path()!="/callback"{continue;}
                let params:BTreeMap<_,_>=callback.query_pairs().into_owned().collect();
				if params.get("state")!=Some(&state){continue;}
                let tokens = Self::response(self.client.post(format!("{server}/oauth/token")).json(&json!({"grant_type":"authorization_code","client_id":"typerelay-desktop","code":params.get("code"),"redirect_uri":redirect,"code_verifier":verifier})).send()?)?;
				ensure!(!cancelled.load(Ordering::SeqCst),"Authentication cancelled");self.secret(&Credentials { server: server.into(), access_token: tokens["access_token"].as_str().context("Missing token")?.into(), refresh_token: tokens["refresh_token"].as_str().context("Missing token")?.into(), account:tokens["account"].as_str().map(str::to_owned), device:tokens["device"].as_str().map(str::to_owned) })?;return Ok(());
            }
            let Some(listener)=&listener else {std::thread::sleep(Duration::from_millis(100));continue;};
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let Some(params) = Self::callback(&mut stream, &state, Duration::from_secs(2))? else { continue; };
                    let tokens = Self::response(self.client.post(format!("{server}/oauth/token")).json(&json!({"grant_type":"authorization_code","client_id":"typerelay-desktop","code":params.get("code"),"redirect_uri":redirect,"code_verifier":verifier})).send()?)?;
					ensure!(!cancelled.load(Ordering::SeqCst),"Authentication cancelled");self.secret(&Credentials { server: server.into(), access_token: tokens["access_token"].as_str().context("Missing token")?.into(), refresh_token: tokens["refresh_token"].as_str().context("Missing token")?.into(), account:tokens["account"].as_str().map(str::to_owned), device:tokens["device"].as_str().map(str::to_owned) })?;
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 37\r\nConnection: close\r\n\r\nTypeRelay connected. Close this tab.\n")?;
                    println!("Connected. Enroll selected files with: typerelay enroll FILE.yml");
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => return Err(error.into()),
            }
        }
    }
    pub fn receive_callback(root:&Path,url:&str)->Result<bool>{let callback=url::Url::parse(url)?;if callback.scheme()!="typerelay"||callback.host_str()!=Some("oauth")||callback.path()!="/callback"{return Ok(false);}fs::create_dir_all(root.join("sync"))?;Paths::atomic_write(&root.join("sync/oauth-callback"),url.as_bytes(),false)?;Ok(true)}
    pub fn enroll(&self, name: &str) -> Result<()> {
        let _lock = self.lock()?;
        self.credentials()?;
        Database::open(&self.directory)?.enroll(name)?;
        println!("Library enrolled; changes queued for sync.");
        Ok(())
    }
	pub fn resolve_conflict(&self,id:&str,choice:&str,value:Option<Value>)->Result<()> {
		ensure!(["local","server","merged"].contains(&choice),"Choose a conflict resolution");let _lock=self.lock()?;let mut credentials=self.credentials()?;let db=Database::open(&self.directory)?;let conflicts=db.meta("conflicts")?.and_then(|value|value.as_array().cloned()).unwrap_or_default();let conflict=conflicts.iter().find(|conflict|conflict["_id"]==id).context("Conflict no longer exists")?;let library_id=conflict["library"].as_str().context("Missing conflict library")?;let library=db.library(library_id)?;
		if choice=="merged"{let value=value.as_ref().context("Enter the merged record")?;Database::entries(&[json!({"state":"active","trigger":value["trigger"],"title":value["title"],"content":value["content"]})])?;}
		let result=self.request(&mut credentials,reqwest::Method::POST,&format!("conflicts/{id}"),Some(&json!({"operation_id":Uuid::new_v4().to_string(),"base_revision":library["revision"],"choice":choice,"value":value})))?;db.apply(&result,None)?;let fresh=self.request(&mut credentials,reqwest::Method::GET,"sync?cursor=0",None)?;self.download_assets(&credentials,&db,&fresh)?;db.apply(&fresh,None)?;Ok(())
	}
    fn legacy(&self, credentials: &mut Credentials, db: &Database) -> Result<()> {
        let Some(pending) = db.meta("legacy_pending")?.filter(|value| !value.is_null()) else { return Ok(()); };
        let operation_id = pending["body"]["operation_id"].as_str().context("Invalid legacy pending operation")?;
        let receipt = self.request(credentials, reqwest::Method::GET, &format!("operations/{operation_id}"), None)?;
        let name = pending["filename"].as_str().context("Missing legacy filename")?;
        let file = db.editor(name)?;
        if receipt["found"] == true {
            if let Some(library) = receipt.get("library") { db.reconcile_legacy(name, library, pending["source"].as_str().context("Missing legacy submission")?, &receipt["versions"])?; }
            else if let Some(remote_id) = receipt["library_id"].as_str() {
                let transaction = db.connection.unchecked_transaction()?;
                db.remap(&file.id, remote_id)?;
                transaction.commit()?;
                db.apply(&receipt, None)?;
            }
        } else if pending["enroll"] == true && !db.synced(&file.id)? { db.enroll(name)?; }
        db.set_meta("legacy_pending", &Value::Null)?;
        Ok(())
    }
    pub fn cycle(&self) -> Result<()> {
        let _lock = self.lock()?;
        let mut credentials = self.credentials()?;
        self.cycle_inner(&mut credentials)
    }
    /// Mobile supplies an access token only. Refresh and credential persistence remain in native secure storage.
    pub fn cycle_authenticated(&self, credentials: &mut Credentials) -> Result<()> {
        let _lock = self.lock()?;
        self.cycle_inner(credentials)
    }
    fn cycle_inner(&self, credentials: &mut Credentials) -> Result<()> {
        let db = Database::open(&self.directory)?;
        db.cleanup()?;
        self.legacy(credentials, &db)?;
        let cursor = if db.pending()?.is_empty() && db.meta("sync_protocol")? == Some(json!(6)) { db.meta("cursor")?.and_then(|value| value.as_u64()).unwrap_or(0) } else { 0 };
        let response = self.request(credentials, reqwest::Method::GET, &format!("sync?cursor={cursor}"), None)?;
        ensure!(response["protocol"] == 6, "Server upgrade required: sync protocol 6");
		db.reconcile_detached(&response,&credentials.server,credentials.account.as_deref())?;
		self.download_assets(credentials,&db,&response)?;
        db.apply(&response, None)?;
        db.set_meta("sync_protocol", &json!(6))?;
		self.upload_assets(credentials,&db)?;
        while let Some((seq, operation)) = db.pending()?.into_iter().next() {
            let id = operation["library"].as_str().context("Missing library")?;
            let path = match operation["kind"].as_str() { Some("create") => "libraries".to_owned(), Some("edit") => format!("libraries/{id}/snippets"), Some("trash") => "trash/action".into(), Some("batch") => "snippets/batch".into(), Some("resolve") => format!("conflicts/{}", operation["conflict"].as_str().context("Missing conflict")?), _ => anyhow::bail!("Unknown pending operation") };
            let result = self.request(credentials, reqwest::Method::POST, &path, Some(&operation["body"]));
            match result {
                Ok(result) => db.apply(&result, Some((seq, &operation)))?,
                Err(error) => {
                    let message = error.to_string();
                    let status = error.downcast_ref::<ServerError>().map(|error|error.status);
                    if ServerError::rejected(&error, operation["kind"] == "batch") {
                        let transaction = db.connection.unchecked_transaction()?;
                        if status != Some(410) { db.recover_operation(&operation)?; }
                        db.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?;
                        db.set_meta("last_failure", &json!(message))?;
                        transaction.commit()?;
                        // Full refresh rolls back rejected optimistic moves on both sides.
                        let fresh = self.request(credentials, reqwest::Method::GET, "sync?cursor=0", None)?;
                        db.apply(&fresh, None)?;
                    } else { return Err(error); }
                }
            }
        }
        let cursor = if db.pending()?.is_empty() && db.meta("sync_protocol")? == Some(json!(6)) { db.meta("cursor")?.and_then(|value| value.as_u64()).unwrap_or(0) } else { 0 };
		let response=self.request(credentials,reqwest::Method::GET,&format!("sync?cursor={cursor}"),None)?;self.download_assets(credentials,&db,&response)?;db.apply(&response,None)?;
        let conflicts = db.meta("conflicts")?.and_then(|value|value.as_array().map(Vec::len)).unwrap_or(0);
        Paths::atomic_write(&self.path("status"), format!("Synced. {conflicts} conflicts. {} Resolve: {}/", db.meta("last_failure")?.and_then(|value|value.as_str().map(str::to_owned)).unwrap_or_default(), credentials.server).as_bytes(), false)?;
        Ok(())
    }
    pub fn disconnect(&self) -> Result<()> {
        let _lock = self.lock()?;
        let mut credentials=self.credentials().ok();
        if let Some(value)=credentials.as_mut(){let _=self.request(value,reqwest::Method::DELETE,"connection",None);}
        let db = Database::open(&self.directory)?;
        let transaction = db.connection.unchecked_transaction()?;
        let libraries:Vec<String>=db.libraries()?.into_iter().filter_map(|library|library["_id"].as_str().map(str::to_owned)).filter(|id|db.synced(id).unwrap_or(false)).collect();
        db.connection.execute("UPDATE libraries SET synced=0", [])?;
        for (seq, operation) in db.pending()? { db.recover_operation(&operation)?; db.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; }
        db.set_meta("cursor", &json!(0))?;
		if !libraries.is_empty(){db.set_meta("detached",&json!({"server":credentials.as_ref().map(|value|value.server.as_str()),"account":credentials.as_ref().and_then(|value|value.account.as_deref()),"libraries":libraries}))?;}
        transaction.commit()?;
        match fs::remove_file(self.path("credentials.json")){Ok(())=>(),Err(error)if error.kind()==ErrorKind::NotFound=>(),Err(error)=>return Err(error.into())}
        Ok(())
    }
    pub fn editable(_root: &Path, directory: &Path, name: &str) -> Result<()> { let db = Database::open(directory)?; db.editable(&db.editor(name)?.id) }
    pub fn label(_root: &Path, _directory: &Path, name: &str) -> String { name.into() }
    pub fn trigger(root: &Path) -> Result<()> {
        ensure!(root.join("sync/credentials.json").exists(), "Connect first: typerelay connect --server URL");
        Paths::atomic_write(&root.join("sync/request"), Uuid::new_v4().to_string().as_bytes(), false)
    }
    pub fn worker(root: PathBuf, directory: PathBuf) {
        std::thread::spawn(move || {
            let Ok(sync) = Self::new(root, directory) else { return; };
            let Ok(leader) = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(sync.path("leader.lock")) else { return; };
            while leader.try_lock_exclusive().is_err() { std::thread::sleep(Duration::from_millis(500)); }
            let mut last = Instant::now() - Duration::from_secs(31);
            let mut cleanup = Instant::now() - Duration::from_secs(3601);
            let mut request = Vec::new();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let Ok(db) = Database::open(&sync.directory) else { continue; };
                if cleanup.elapsed() > Duration::from_secs(3600) { let _ = db.cleanup(); cleanup = Instant::now(); }
                if !sync.path("credentials.json").exists() { continue; }
                let next = fs::read(sync.path("request")).unwrap_or_default();
                let pending = db.pending().is_ok_and(|rows| !rows.is_empty());
                if last.elapsed() >= Duration::from_secs(30) || next != request || (pending && last.elapsed() >= Duration::from_secs(2)) {
                    request = next;
                    if let Err(error) = sync.cycle() && !error.to_string().contains("Sync already running") { let _ = Paths::atomic_write(&sync.path("status"), format!("Sync: {error:#}").as_bytes(), false); }
                    last = Instant::now();
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_failures_never_discard_queued_operations() {
        assert!(!ServerError::rejected(&anyhow::anyhow!("connection refused at http://127.0.0.1:40901"), true));
        assert!(!ServerError::rejected(&ServerError { status: 503, message: "Try again".into() }.into(), true));
        assert!(ServerError::rejected(&ServerError { status: 409, message: "Selection changed".into() }.into(), true));
    }
    #[test]
    fn disconnect_succeeds_when_server_is_unavailable() {
        let root = tempfile::tempdir().unwrap(); let directory = root.path().join("snippets");
        let sync = Sync::new(root.path().into(), directory.clone()).unwrap();
        sync.secret(&Credentials { server: "http://127.0.0.1:9".into(), access_token: "offline".into(), refresh_token: "offline".into(), account:Some("account-one".into()), device:Some("device-one".into()) }).unwrap();
		let db=Database::open(&directory).unwrap();let id="0123456789abcdef01234567";db.apply(&json!({"libraries":[{"_id":id,"name":"Mine","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-0000000001","trigger":"one","title":"","content":{"version":1,"type":"plain_text","text":"One"},"revision":1,"state":"active","position":0}]}],"accessible":[id]}),None).unwrap();db.set_meta("cursor", &json!(42)).unwrap();
        sync.disconnect().unwrap();
        assert!(!root.path().join("sync/credentials.json").exists());
		let db=Database::open(&directory).unwrap();assert_eq!(db.meta("cursor").unwrap(), Some(json!(0)));assert_eq!(db.connection.query_row("SELECT count(*) FROM base_snippets",[],|row|row.get::<_,i64>(0)).unwrap(),1);assert_eq!(db.meta("detached").unwrap().unwrap()["account"],"account-one");
        sync.disconnect().unwrap();
		assert_eq!(Database::open(&directory).unwrap().meta("detached").unwrap().unwrap()["account"],"account-one");
    }
    #[test]
    fn idle_browser_connection_does_not_cancel_callback_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        assert_eq!(Sync::callback(&mut stream, "expected", Duration::from_millis(10)).unwrap(), None);
    }
    #[test]
    fn registered_app_callback_is_validated_before_delivery() {
        let root=tempfile::tempdir().unwrap();
        assert!(!Sync::receive_callback(root.path(),"https://example.test/callback?code=x").unwrap());
        assert!(Sync::receive_callback(root.path(),"typerelay://oauth/callback?code=x&state=y").unwrap());
        assert_eq!(fs::read_to_string(root.path().join("sync/oauth-callback")).unwrap(),"typerelay://oauth/callback?code=x&state=y");
    }
	#[test]
	fn desktop_authentication_can_cancel_and_ignores_a_late_callback() {
		let root=tempfile::tempdir().unwrap();let path=root.path().to_path_buf();let sync=Sync::new(path.clone(),path.join("snippets")).unwrap();let cancelled=std::sync::Arc::new(AtomicBool::new(false));let signal=cancelled.clone();let worker=std::thread::spawn(move||sync.connect_cancellable("http://127.0.0.1:3040",false,true,&signal));std::thread::sleep(Duration::from_millis(50));Sync::receive_callback(&path,"typerelay://oauth/callback?code=late&state=old-state").unwrap();std::thread::sleep(Duration::from_millis(50));cancelled.store(true,Ordering::SeqCst);assert_eq!(worker.join().unwrap().unwrap_err().to_string(),"Authentication cancelled");assert!(!path.join("sync/credentials.json").exists());
	}
    #[cfg(target_os="linux")]
    #[test]
    fn only_ssl_trusted_nss_certificates_are_loaded() {
        let list="Certificate Nickname  Trust Attributes\n\nDBH Caddy Local Authority  C,,\nEmail only  ,C,\nUntrusted  ,,,\n";
        assert_eq!(Sync::trusted_nss_nicknames(list),vec!["DBH Caddy Local Authority"]);
    }
}
