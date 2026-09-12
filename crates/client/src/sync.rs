use crate::{config::{Document, FileStore}, editor::Paths};
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
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct State { #[serde(default)] pub directory: Option<PathBuf>, pub cursor: u64, pub files: BTreeMap<String, Managed>, pub pending: Option<Value>, pub conflicts: Vec<Value> }
#[derive(Clone, Serialize, Deserialize)]
pub struct Managed { pub filename: String, pub library: Value, pub baseline: String }
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
    pub fn state(&self) -> Result<State> { match fs::read(self.path("state.json")) { Ok(bytes) => { let state: State = serde_json::from_slice(&bytes)?; ensure!(state.directory.as_ref().is_none_or(|directory| self.directory.canonicalize().is_ok_and(|current| &current == directory)), "This connection belongs to another snippets directory"); Ok(state) }, Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()), Err(error) => Err(error.into()) } }
    fn save(&self, state: &State) -> Result<()> { let mut state = state.clone(); state.directory = Some(self.directory.canonicalize()?); Paths::atomic_write(&self.path("state.json"), &serde_json::to_vec_pretty(&state)?, false) }
    fn credentials(&self) -> Result<Credentials> { Ok(serde_json::from_slice(&fs::read(self.path("credentials.json")).context("Connect first: typerelay connect --server URL")?)?) }
    fn secret(&self, credentials: &Credentials) -> Result<()> {
        Paths::atomic_write(&self.path("credentials.json"), &serde_json::to_vec(credentials)?, false)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(self.path("credentials.json"), fs::Permissions::from_mode(0o600))?; }
        Ok(())
    }
    fn response(response: reqwest::blocking::Response) -> Result<Value> {
        let status = response.status();
        let value: Value = response.json()?;
        ensure!(status.is_success(), "Server {}: {}", status, value["error"].as_str().unwrap_or("Request failed"));
        Ok(value)
    }
    fn request(&self, credentials: &mut Credentials, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let send = |credentials: &Credentials| {
            let request = self.client.request(method.clone(), format!("{}/api/v1/{path}", credentials.server)).bearer_auth(&credentials.access_token);
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
        #[cfg(not(target_os = "linux"))] let _ = open_browser;
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
        ensure!(Path::new(name).file_name().and_then(|name| name.to_str()) == Some(name) && matches!(Path::new(name).extension().and_then(|name| name.to_str()), Some("yaml" | "yml")), "Choose a YAML filename in the snippets directory");
        let mut state = self.state()?;
        ensure!(state.pending.is_none(), "Run sync to finish the pending operation first");
        ensure!(!state.files.values().any(|file| file.filename == name), "File already enrolled");
        let yaml = String::from_utf8(FileStore::read(&self.directory.join(name))?)?;
        FileStore::parse(yaml.as_bytes())?;
        state.pending = Some(json!({"path":"libraries","body":{"operation_id":Uuid::new_v4().to_string(),"name":name,"yaml":yaml},"filename":name,"source":yaml,"enroll":true}));
        self.save(&state)?;
        self.finish_pending(&mut self.credentials()?, &mut state)?;
        println!("Enrolled {name}");
        Ok(())
    }
    fn finish_pending(&self, credentials: &mut Credentials, state: &mut State) -> Result<()> {
        let Some(pending) = state.pending.clone() else { return Ok(()); };
        let result = self.request(credentials, reqwest::Method::POST, pending["path"].as_str().context("Missing path")?, Some(&pending["body"]))?;
        let library = result["library"].clone();
        let id = library["_id"].as_str().context("Missing library ID")?.to_owned();
        let filename = pending["filename"].as_str().context("Missing filename")?.to_owned();
        let source = pending["source"].as_str().context("Missing pending source")?;
        if pending["enroll"] == true {
            state.files.insert(id, Managed { filename, library, baseline: source.into() });
        } else {
            let current = fs::read_to_string(self.directory.join(&filename)).unwrap_or_default();
            if current != source {
                // A second local edit arrived during upload. Preserve it before rebasing.
                self.recover(&filename, &current)?;
            }
            self.activate(&id, &library, state, true)?;
        }
        state.pending = None;
        self.save(state)?;
        Ok(())
    }
    pub fn changes(managed: &Managed, yaml: &str) -> Result<Vec<Value>> {
        FileStore::parse(yaml.as_bytes())?;
        let document: Document = serde_saphyr::from_str(yaml)?;
        let previous = managed.library["snippets"].as_array().context("Missing snippets")?;
        let mut changes = Vec::new();
        for snippet in previous {
            let next = document.matches.iter().find(|entry| Some(entry.trigger.as_str()) == snippet["trigger"].as_str());
            let value = next.map(|entry| json!(entry)).unwrap_or(Value::Null);
            if next.is_none_or(|entry| Some(entry.replace.as_str()) != snippet["replace"].as_str()) {
                changes.push(json!({"id":snippet["id"],"base_revision":snippet["revision"],"base":snippet,"value":value}));
            }
        }
        for entry in document.matches {
            if !previous.iter().any(|snippet| snippet["trigger"] == entry.trigger) { changes.push(json!({"id":Uuid::new_v4().to_string(),"base_revision":null,"value":entry})); }
        }
        Ok(changes)
    }
    fn recover(&self, filename: &str, content: &str) -> Result<()> { Paths::atomic_write(&self.path("recovery").join(format!("{}-{filename}", Uuid::new_v4())), content.as_bytes(), true) }
    fn activate(&self, id: &str, library: &Value, state: &mut State, preserve: bool) -> Result<()> {
        ensure!(id.len() == 24 && id.bytes().all(|byte| byte.is_ascii_hexdigit()), "Invalid library ID");
        let filename = state.files.get(id).map(|file| file.filename.clone()).unwrap_or(format!("library-{id}.yml"));
        let path = self.directory.join(&filename);
        ensure!(!path.is_symlink(), "Managed file is a symlink");
        if !state.files.contains_key(id) { ensure!(!path.exists(), "Unrelated local file occupies {filename}"); }
        let yaml = library["yaml"].as_str().context("Missing YAML")?;
        // Stage first: invalid remote data never replaces the working engine files.
        Paths::atomic_write(&self.path("staged").join(format!("{id}.json")), &serde_json::to_vec(library)?, false)?;
        let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(self.directory.join(".typerelay-edit.lock"))?;
        lock.lock_exclusive()?;
        let mut files = FileStore::read_files(&self.directory, true)?;
        files.retain(|(file, _)| file != &path);
        files.push((path.clone(), yaml.as_bytes().to_vec()));
        ensure!(files.len() <= 256 && files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() <= 8 * 1048576 && yaml.len() <= 1048576, "Engine file limits exceeded; incoming library staged");
        FileStore::parse_files(&files)?;
        if let Ok(current) = fs::read_to_string(&path) {
            let baseline = state.files.get(id).map(|file| file.baseline.as_str()).unwrap_or("");
            if current != baseline && current != yaml {
                ensure!(preserve, "Local edits arrived during sync; retry");
                self.recover(&filename, &current)?;
            }
        }
        Paths::atomic_write(&path, yaml.as_bytes(), !path.exists())?;
        state.files.insert(id.into(), Managed { filename, library: library.clone(), baseline: yaml.into() });
        self.save(state)?;
        Ok(())
    }
    pub fn cycle(&self) -> Result<()> {
        let _lock = self.lock()?;
        let mut credentials = self.credentials()?;
        let mut state = self.state()?;
        // Obtain current grants before uploading any locally modified content.
        let remote = self.request(&mut credentials, reqwest::Method::GET, &format!("sync?cursor={}", state.cursor), None)?;
        let accessible = remote["accessible"].as_array().context("Missing access manifest")?;
        for (id, managed) in state.files.clone() {
            if !accessible.iter().any(|value| value.as_str() == Some(&id)) {
                let path = self.directory.join(&managed.filename);
                let edit_lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(self.directory.join(".typerelay-edit.lock"))?;
                edit_lock.lock_exclusive()?;
                ensure!(!path.is_symlink(), "Managed file is a symlink");
                if path.exists() {
                    let current = fs::read_to_string(&path)?;
                    if current != managed.baseline { self.recover(&managed.filename, &current)?; }
                    fs::remove_file(path)?;
                }
                state.files.remove(&id);
                self.save(&state)?;
            }
        }
        let incoming = remote["libraries"].as_array().context("Missing libraries")?;
        if let Some(pending) = state.pending.clone() {
            let target = pending["path"].as_str().unwrap_or("").split('/').nth(1).unwrap_or("");
            let permitted = pending["enroll"] == true || (accessible.iter().any(|id| id.as_str() == Some(target)) && incoming.iter().find(|library| library["_id"] == target).or_else(|| state.files.get(target).map(|file| &file.library)).is_some_and(|library| library["permissions"]["edit"] == true));
            if !permitted {
                self.recover(pending["filename"].as_str().unwrap_or("draft.yml"), pending["source"].as_str().unwrap_or(""))?;
                state.pending = None;
                self.save(&state)?;
            } else { self.finish_pending(&mut credentials, &mut state)?; }
        }

        for (id, managed) in state.files.clone() {
            let latest = incoming.iter().find(|library| library["_id"] == id && library["revision"].as_u64() >= managed.library["revision"].as_u64()).unwrap_or(&managed.library);
            if latest["permissions"]["edit"] != true {
                self.activate(&id, latest, &mut state, true)?;
                continue;
            }
            let path = self.directory.join(&managed.filename);
            if !path.exists() { self.activate(&id, latest, &mut state, false)?; continue; }
            let yaml = String::from_utf8(FileStore::read(&path)?)?;
            if yaml == managed.baseline { continue; }
            let changes = Self::changes(&managed, &yaml)?;
            state.pending = Some(json!({"path":format!("libraries/{id}/snippets"),"filename":managed.filename,"source":yaml,"body":{"operation_id":Uuid::new_v4().to_string(),"base_revision":managed.library["revision"],"changes":changes,"yaml":yaml}}));
            self.save(&state)?;
            self.finish_pending(&mut credentials, &mut state)?;
        }
        // Fetch again: upload may have advanced revisions and conflict records.
        let remote = self.request(&mut credentials, reqwest::Method::GET, &format!("sync?cursor={}", state.cursor), None)?;
        for library in remote["libraries"].as_array().context("Missing libraries")? {
            let id = library["_id"].as_str().context("Missing ID")?;
            self.activate(id, library, &mut state, true)?;
        }
        state.cursor = remote["cursor"].as_u64().context("Missing cursor")?;
        state.conflicts = remote["conflicts"].as_array().cloned().unwrap_or_default();
        self.save(&state)?;
        Paths::atomic_write(&self.path("status"), format!("Synced. {} conflicts. Resolve: {}/", state.conflicts.len(), credentials.server).as_bytes(), false)?;
        Ok(())
    }
    pub fn disconnect(&self) -> Result<()> {
        let _lock = self.lock()?;
        let mut credentials = self.credentials()?;
        let devices = self.request(&mut credentials, reqwest::Method::GET, "devices", None)?;
        // Revoke only the current device by matching the active token on the server.
        let _ = devices;
        self.request(&mut credentials, reqwest::Method::DELETE, "connection", None)?;
        self.recover("state.json", &fs::read_to_string(self.path("state.json")).unwrap_or_default())?;
        if self.path("state.json").exists() { fs::remove_file(self.path("state.json"))?; }
        fs::remove_file(self.path("credentials.json"))?;
        Ok(())
    }
    pub fn editable(root: &Path, directory: &Path, name: &str) -> Result<()> {
        let sync = Self::new(root.into(), directory.into())?;
        if let Some(file) = sync.state()?.files.values().find(|file| file.filename == name) { ensure!(file.library["permissions"]["edit"] == true, "Shared library is read-only"); }
        Ok(())
    }
    pub fn label(root: &Path, directory: &Path, name: &str) -> String {
        Self::new(root.into(), directory.into()).and_then(|sync| sync.state()).ok().and_then(|state| state.files.values().find(|file| file.filename == name).and_then(|file| file.library["name"].as_str()).map(|friendly| format!("{friendly} ({name})"))).unwrap_or_else(|| name.into())
    }
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
            let mut request = Vec::new();
            let mut observed = Vec::new();
            let mut changed = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                if !sync.path("credentials.json").exists() { continue; }
                let files = FileStore::read_files(&sync.directory, true).unwrap_or_default();
                let local_changed = files != observed;
                if local_changed { observed = files; changed = Instant::now(); }
                let next = fs::read(sync.path("request")).unwrap_or_default();
                if last.elapsed() >= Duration::from_secs(30) || next != request || (!local_changed && changed.elapsed() >= Duration::from_secs(2) && changed > last) {
                    request = next;
                    if let Err(error) = sync.cycle() { if error.to_string().contains("Sync already running") { last = Instant::now(); continue; } let _ = Paths::atomic_write(&sync.path("status"), format!("Sync: {error:#}").as_bytes(), false); }
                    last = Instant::now();
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { _temp: tempfile::TempDir, sync: Sync }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("config");
            let directory = root.join("snippets");
            fs::create_dir_all(&directory).unwrap();
            let sync = Sync::new(root, directory).unwrap();
            Self { _temp: temp, sync }
        }
        fn library(trigger: &str, replacement: &str, edit: bool) -> Value {
            json!({"_id":"0123456789abcdef01234567","name":"Friendly","revision":1,"yaml":format!("matches: [{{trigger: {trigger}, replace: {replacement}}}]
"),"permissions":{"edit":edit},"snippets":[{"id":"snippet-0000000001","trigger":trigger,"replace":replacement,"revision":1}]})
        }
    }
    #[test]
    fn rename_is_delete_create_and_invalid_offline_drafts_stay_on_disk() {
        let fixture = Fixture::new();
        let library = Fixture::library("old", "Before", true);
        let managed = Managed { filename: "mine.yml".into(), baseline: library["yaml"].as_str().unwrap().into(), library };
        let changes = Sync::changes(&managed, "matches: [{trigger: new, replace: After}]").unwrap();
        assert_eq!(changes.len(), 2);
        assert!(changes[0]["value"].is_null());
        assert_eq!(changes[1]["value"]["trigger"], "new");
        assert!(Sync::changes(&managed, "matches: [").is_err());
        fs::write(fixture.sync.directory.join("mine.yml"), "matches: [").unwrap();
        assert!(fixture.sync.cycle().is_err());
        assert_eq!(fs::read_to_string(fixture.sync.directory.join("mine.yml")).unwrap(), "matches: [");
    }
    #[test]
    fn collision_stages_without_activation_and_readonly_draft_recovers() {
        let fixture = Fixture::new();
        let mut state = State::default();
        let library = Fixture::library("same", "Server", false);
        let id = library["_id"].as_str().unwrap();
        fs::write(fixture.sync.directory.join("local.yml"), "matches: [{trigger: same, replace: Local}]").unwrap();
        assert!(fixture.sync.activate(id, &library, &mut state, true).is_err());
        assert!(state.files.is_empty());
        assert!(fixture.sync.path("staged").join(format!("{id}.json")).exists());
        fs::remove_file(fixture.sync.directory.join("local.yml")).unwrap();
        fixture.sync.activate(id, &library, &mut state, false).unwrap();
        let path = fixture.sync.directory.join(&state.files[id].filename);
        fs::write(&path, "matches: [{trigger: same, replace: Draft}]").unwrap();
        fixture.sync.activate(id, &library, &mut state, true).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("Server"));
        assert_eq!(fs::read_dir(fixture.sync.path("recovery")).unwrap().count(), 1);
        assert!(Sync::editable(&fixture.sync.root, &fixture.sync.directory, &state.files[id].filename).is_err());
    }
    #[test]
    fn unrelated_filename_and_failed_activation_keep_working_state() {
        let fixture = Fixture::new();
        let mut state = State::default();
        let library = Fixture::library("first", "Server", true);
        let id = library["_id"].as_str().unwrap();
        let path = fixture.sync.directory.join(format!("library-{id}.yml"));
        fs::write(&path, "matches: []").unwrap();
        assert!(fixture.sync.activate(id, &library, &mut state, false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "matches: []");
        fs::remove_file(&path).unwrap();
        fixture.sync.activate(id, &library, &mut state, false).unwrap();
        let mut invalid = library.clone();
        invalid["yaml"] = json!("invalid: [");
        assert!(fixture.sync.activate(id, &invalid, &mut state, true).is_err());
        assert!(fs::read_to_string(&path).unwrap().contains("Server"));
        assert_eq!(state.files[id].library, library);
    }
}
