use crate::{database::Database, editor::Paths};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::{Read, Write}, net::TcpListener, path::{Path, PathBuf}, time::{Duration, Instant}};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials { pub server: String, pub access_token: String, pub refresh_token: String }
#[derive(Debug)]
struct ServerError { status: u16, message: String }
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
        Ok(Self { root, directory, client: reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build()? })
    }
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
    fn request(&self, credentials: &mut Credentials, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let send = |credentials: &Credentials| {
            let request = self.client.request(method.clone(), format!("{}/api/v2/{path}", credentials.server)).bearer_auth(&credentials.access_token).header("X-TypeRelay-Sync-Protocol", "6");
            if let Some(body) = body { request.json(body).send() } else { request.send() }
        };
        let mut response = send(credentials)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            let tokens = Self::response(self.client.post(format!("{}/oauth/token", credentials.server)).json(&json!({"grant_type":"refresh_token","refresh_token":credentials.refresh_token})).send()?)?;
            credentials.access_token = tokens["access_token"].as_str().context("Missing access token")?.into();
            credentials.refresh_token = tokens["refresh_token"].as_str().context("Missing refresh token")?.into();
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
	fn download_assets(&self,credentials:&Credentials,db:&Database,response:&Value)->Result<()> {for metadata in response["assets"].as_array().into_iter().flatten(){let id=metadata["id"].as_str().context("Missing asset ID")?;if db.asset(id)?.is_some(){continue;}let bytes=self.asset_request(credentials,reqwest::Method::GET,id,None,None)?.bytes()?.to_vec();ensure!(bytes.len()==metadata["size"].as_u64().context("Missing asset size")? as usize,"Asset size mismatch");ensure!(format!("{:x}",Sha256::digest(&bytes))==id,"Asset hash mismatch");db.put_asset(metadata,&bytes,true)?;}Ok(())}
	fn upload_assets(&self,credentials:&Credentials,db:&Database)->Result<()> {for (metadata,bytes) in db.pending_assets()?{let id=metadata["id"].as_str().context("Missing asset ID")?;self.asset_request(credentials,reqwest::Method::PUT,id,metadata["mime_type"].as_str(),Some(bytes))?;db.mark_asset_uploaded(id)?;}Ok(())}
    pub fn connect(&self, server: &str, open_browser: bool) -> Result<()> {
        let _lock = self.lock()?;
        ensure!(!self.path("credentials.json").exists(), "Already connected; disconnect before changing accounts");
        let server = server.trim_end_matches('/');
        let url = url::Url::parse(server)?;
        ensure!(url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))), "Use HTTPS (HTTP is permitted only on loopback)");
        ensure!(url.path() == "/" && url.query().is_none() && url.fragment().is_none() && url.username().is_empty(), "Use the server origin without a path or credentials");
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr()?.port());
        let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let state = Uuid::new_v4().simple().to_string();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorize = url::Url::parse(&format!("{server}/oauth/authorize"))?;
        authorize.query_pairs_mut().extend_pairs([("client_id", "typerelay-desktop"), ("redirect_uri", &redirect), ("code_challenge", &challenge), ("code_challenge_method", "S256"), ("state", &state), ("device_name", "TypeRelay desktop")]);
        println!("Open this URL in your browser:\n{authorize}");
        #[cfg(target_os = "linux")] { if open_browser { let _ = std::process::Command::new("xdg-open").arg(authorize.as_str()).spawn(); } }
        #[cfg(target_os = "macos")] { if open_browser { std::process::Command::new("open").arg(authorize.as_str()).spawn()?; } }
        #[cfg(target_os = "windows")] { if open_browser { std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", authorize.as_str()]).spawn()?; } }
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            ensure!(Instant::now() < deadline, "Browser sign-in timed out");
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                    let mut buffer = [0u8; 8192];
                    let length = stream.read(&mut buffer)?;
                    let request = std::str::from_utf8(&buffer[..length])?;
                    let target = request.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("/");
                    let callback = url::Url::parse(&format!("http://127.0.0.1{target}"))?;
                    let params: BTreeMap<_, _> = callback.query_pairs().into_owned().collect();
                    if callback.path() != "/callback" || params.get("state") != Some(&state) { let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); continue; }
                    let tokens = Self::response(self.client.post(format!("{server}/oauth/token")).json(&json!({"grant_type":"authorization_code","client_id":"typerelay-desktop","code":params.get("code"),"redirect_uri":redirect,"code_verifier":verifier})).send()?)?;
                    let mut settings = crate::settings::SettingsStore::open(self.root.join("settings.yml"))?;
                    let prefix = settings.settings.trigger_prefix.clone();
                    settings.save(server, &prefix)?;
                    self.secret(&Credentials { server: server.into(), access_token: tokens["access_token"].as_str().context("Missing token")?.into(), refresh_token: tokens["refresh_token"].as_str().context("Missing token")?.into() })?;
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 37\r\nConnection: close\r\n\r\nTypeRelay connected. Close this tab.\n")?;
                    println!("Connected. Enroll selected files with: typerelay enroll FILE.yml");
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => return Err(error.into()),
            }
        }
    }
    pub fn enroll(&self, name: &str) -> Result<()> {
        let _lock = self.lock()?;
        self.credentials()?;
        Database::open(&self.directory)?.enroll(name)?;
        println!("Library enrolled; changes queued for sync.");
        Ok(())
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
        let db = Database::open(&self.directory)?;
        db.cleanup()?;
        let mut credentials = self.credentials()?;
        self.legacy(&mut credentials, &db)?;
        let cursor = if db.pending()?.is_empty() && db.meta("sync_protocol")? == Some(json!(6)) { db.meta("cursor")?.and_then(|value| value.as_u64()).unwrap_or(0) } else { 0 };
        let response = self.request(&mut credentials, reqwest::Method::GET, &format!("sync?cursor={cursor}"), None)?;
        ensure!(response["protocol"] == 6, "Server upgrade required: sync protocol 6");
		self.download_assets(&credentials,&db,&response)?;
        db.apply(&response, None)?;
        db.set_meta("sync_protocol", &json!(6))?;
		self.upload_assets(&credentials,&db)?;
        while let Some((seq, operation)) = db.pending()?.into_iter().next() {
            let id = operation["library"].as_str().context("Missing library")?;
            let path = match operation["kind"].as_str() { Some("create") => "libraries".to_owned(), Some("edit") => format!("libraries/{id}/snippets"), Some("trash") => "trash/action".into(), Some("batch") => "snippets/batch".into(), _ => anyhow::bail!("Unknown pending operation") };
            let result = self.request(&mut credentials, reqwest::Method::POST, &path, Some(&operation["body"]));
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
                        let fresh = self.request(&mut credentials, reqwest::Method::GET, "sync?cursor=0", None)?;
                        db.apply(&fresh, None)?;
                    } else { return Err(error); }
                }
            }
        }
        let cursor = if db.pending()?.is_empty() && db.meta("sync_protocol")? == Some(json!(6)) { db.meta("cursor")?.and_then(|value| value.as_u64()).unwrap_or(0) } else { 0 };
		let response=self.request(&mut credentials,reqwest::Method::GET,&format!("sync?cursor={cursor}"),None)?;self.download_assets(&credentials,&db,&response)?;db.apply(&response,None)?;
        let conflicts = db.meta("conflicts")?.and_then(|value|value.as_array().map(Vec::len)).unwrap_or(0);
        Paths::atomic_write(&self.path("status"), format!("Synced. {conflicts} conflicts. {} Resolve: {}/", db.meta("last_failure")?.and_then(|value|value.as_str().map(str::to_owned)).unwrap_or_default(), credentials.server).as_bytes(), false)?;
        Ok(())
    }
    pub fn disconnect(&self) -> Result<()> {
        let _lock = self.lock()?;
        let mut credentials = self.credentials()?;
        let _ = self.request(&mut credentials, reqwest::Method::DELETE, "connection", None);
        let db = Database::open(&self.directory)?;
        let transaction = db.connection.unchecked_transaction()?;
        db.connection.execute("UPDATE libraries SET synced=0", [])?;
        db.connection.execute_batch("DELETE FROM base_libraries; DELETE FROM base_snippets;")?;
        for (seq, operation) in db.pending()? { db.recover_operation(&operation)?; db.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; }
        db.set_meta("cursor", &json!(0))?;
        transaction.commit()?;
        fs::remove_file(self.path("credentials.json"))?;
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
        sync.secret(&Credentials { server: "http://127.0.0.1:9".into(), access_token: "offline".into(), refresh_token: "offline".into() }).unwrap();
        Database::open(&directory).unwrap().set_meta("cursor", &json!(42)).unwrap();
        sync.disconnect().unwrap();
        assert!(!root.path().join("sync/credentials.json").exists());
        assert_eq!(Database::open(&directory).unwrap().meta("cursor").unwrap(), Some(json!(0)));
    }
}
