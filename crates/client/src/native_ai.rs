//! Native-only AI transport, verified model storage and immutable snippet selection.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, net::{SocketAddr, TcpStream}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use crate::{config::Match, editor::Paths, panel::{Hit, Panel}};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Model { pub id: String, pub name: String, pub publisher: String, pub repository: String, pub revision: String, pub filename: String, pub bytes: u64, pub sha256: String, pub license: String, pub recommended: bool, pub ram_bytes: Option<u64> }
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Settings { pub model: Option<String>, pub enabled: Option<bool> }
#[derive(Deserialize, Serialize)]
pub struct Endpoint { pub address: SocketAddr, pub token: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchPlan { pub intent: String, pub terms: Vec<String> }
pub struct NativeAi;
impl NativeAi {
    pub fn prompt(kind: &str, input: Value) -> String { let instructions: Value = serde_json::from_str(include_str!("ai-prompts.json")).expect("AI instructions"); format!("{}\nInput: {}", instructions[kind].as_str().unwrap_or(""), input) }
    pub fn catalog() -> Vec<Model> { serde_json::from_str(include_str!("ai-models.json")).expect("pinned catalog") }
    pub fn model(id: &str) -> Result<Model> { Self::catalog().into_iter().find(|model| model.id == id).context("Unknown model") }
    pub fn directory(root: &Path) -> Result<PathBuf> {
        let directory = root.join("native-ai"); fs::create_dir_all(&directory)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?; }
        Ok(directory)
    }
    pub fn settings(root: &Path) -> Result<Settings> { match fs::read(Self::directory(root)?.join("settings.json")) { Ok(bytes) => Ok(serde_json::from_slice(&bytes)?), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()), Err(error) => Err(error.into()) } }
    pub fn save(root: &Path, model: Option<String>, enabled: bool) -> Result<()> { Paths::atomic_write(&Self::directory(root)?.join("settings.json"), &serde_json::to_vec(&Settings { model, enabled: Some(enabled) })?, false) }
    pub fn path(root: &Path, model: &Model) -> Result<PathBuf> { Ok(Self::directory(root)?.join(format!("{}.gguf", model.id))) }
    pub fn exchange(stream: &mut TcpStream, value: &Value) -> Result<Value> {
        stream.set_read_timeout(Some(Duration::from_secs(if value["op"] == "download" { 7200 } else { 180 })))?; stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        Self::write(stream, value)?; let response = Self::read(stream)?;
        if let Some(error) = response["error"].as_str() { anyhow::bail!("{error}"); } Ok(response["value"].clone())
    }
    pub fn write(stream: &mut TcpStream, value: &Value) -> Result<()> { let bytes = serde_json::to_vec(value)?; ensure!(bytes.len() <= 1_048_576, "AI message too large"); stream.write_all(&(bytes.len() as u32).to_be_bytes())?; stream.write_all(&bytes)?; Ok(()) }
    pub fn read(stream: &mut TcpStream) -> Result<Value> { let mut length = [0; 4]; stream.read_exact(&mut length)?; let length = u32::from_be_bytes(length) as usize; ensure!(length <= 1_048_576, "AI message too large"); let mut bytes = vec![0; length]; stream.read_exact(&mut bytes)?; Ok(serde_json::from_slice(&bytes)?) }
    fn connect(root: &Path) -> Result<(TcpStream, Endpoint)> { let endpoint: Endpoint = serde_json::from_slice(&fs::read(Self::directory(root)?.join("endpoint.json"))?)?; ensure!(endpoint.address.ip().is_loopback(), "Invalid AI endpoint"); let stream = TcpStream::connect_timeout(&endpoint.address, Duration::from_millis(250))?; Ok((stream, endpoint)) }
    pub fn request(root: &Path, mut request: Value) -> Result<Value> {
        let (mut stream, endpoint) = match Self::connect(root) { Ok(connection) => connection, Err(_) => {
            let executable = std::env::current_exe()?.with_file_name(if cfg!(windows) { "typerelay-ai.exe" } else { "typerelay-ai" });
            ensure!(executable.is_file(), "The bundled AI worker is missing. Reinstall Typerelay.");
            let mut command = Command::new(executable); command.arg("--root").arg(root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
            let mut child = command.spawn()?; std::thread::spawn(move || { let _ = child.wait(); });
            let mut connection = None; for _ in 0..60 { if let Ok(value) = Self::connect(root) { connection = Some(value); break; } std::thread::sleep(Duration::from_millis(50)); } connection.context("AI worker did not start")?
        }};
        request["token"] = json!(endpoint.token); Self::exchange(&mut stream, &request)
    }
    pub fn stop(root: &Path) -> Result<()> {
        if let Ok((mut stream, endpoint)) = Self::connect(root) { Self::exchange(&mut stream, &json!({"op":"shutdown","token":endpoint.token}))?; for _ in 0..40 { if Self::connect(root).is_err() { return Ok(()); } std::thread::sleep(Duration::from_millis(50)); } anyhow::bail!("AI worker did not stop for update"); } Ok(())
    }
    pub fn verify(path: &Path, model: &Model, cancelled: &AtomicBool) -> Result<()> {
        let mut file = fs::File::open(path)?; ensure!(file.metadata()?.len() == model.bytes, "Model size mismatch"); let mut hash = Sha256::new(); let mut buffer = [0; 262144];
        loop { ensure!(!cancelled.load(Ordering::Relaxed), "Cancelled"); let count = file.read(&mut buffer)?; if count == 0 { break; } hash.update(&buffer[..count]); }
        ensure!(format!("{:x}", hash.finalize()) == model.sha256, "Model checksum mismatch"); Ok(())
    }
    pub fn download(root: &Path, model: &Model, cancelled: &AtomicBool) -> Result<()> {
        let target = Self::path(root, model)?; let partial = target.with_extension("partial"); let offset = fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
        ensure!(offset <= model.bytes, "Partial model is too large; remove it and retry");
        ensure!(fs2::available_space(Self::directory(root)?)? >= model.bytes - offset + 64 * 1024 * 1024, "Not enough disk space");
        let url = format!("https://huggingface.co/{}/resolve/{}/{}", model.repository, model.revision, model.filename);
        let client = reqwest::blocking::Client::builder().https_only(true).connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(30)).build()?;
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&partial)?; let mut total = offset; let mut buffer = [0; 262144];
        while total < model.bytes {
            ensure!(!cancelled.load(Ordering::Relaxed), "Cancelled");
            let end = (total + 8 * 1024 * 1024 - 1).min(model.bytes - 1);
            let mut response = client.get(&url).header("Range", format!("bytes={total}-{end}")).send()?.error_for_status()?;
            ensure!(response.status() == reqwest::StatusCode::PARTIAL_CONTENT, "Model host did not honor the download range");
            let expected = format!("bytes {total}-{end}/{}", model.bytes);
            ensure!(response.headers().get("content-range").and_then(|value| value.to_str().ok()) == Some(expected.as_str()), "Invalid download range");
            loop { ensure!(!cancelled.load(Ordering::Relaxed), "Cancelled"); let count = response.read(&mut buffer)?; if count == 0 { break; } total += count as u64; ensure!(total <= end+1, "Model download exceeds requested range"); file.write_all(&buffer[..count])?; }
            ensure!(total == end+1, "Interrupted download; resume to continue");
        }
        file.sync_all()?; drop(file);
        if let Err(error) = Self::verify(&partial, model, cancelled) { if !cancelled.load(Ordering::Relaxed) { let _ = fs::remove_file(&partial); } return Err(error); }
        fs::rename(partial, target)?; Ok(())
    }
    pub fn search(root: &Path, directory: &Path, query: &str, id: &str) -> Result<Vec<Hit>> {
        let ordinary = Panel::search(directory, query)?;
        if query.trim().is_empty() || ordinary.iter().any(|hit| hit.abbreviation.eq_ignore_ascii_case(query.trim())) || Self::settings(root)?.model.is_none() { return Ok(ordinary); }
        let result = Self::request(root, json!({"op":"infer","kind":"search","id":id,"prompt":Self::prompt("search",json!({"query":query}))}));
        let Ok(result) = result else { return Ok(ordinary); }; let Ok(plan) = serde_json::from_value::<SearchPlan>(result) else { return Ok(ordinary); };
        Self::rank(directory, ordinary, &plan)
    }
    pub fn rank(directory: &Path, ordinary: Vec<Hit>, plan: &SearchPlan) -> Result<Vec<Hit>> {
        if plan.intent != "descriptive" || plan.terms.is_empty() || plan.terms.len() > 6 || plan.terms.iter().any(|term| term.trim().is_empty() || term.len() > 80) { return Ok(ordinary); }
        let mut ranked = std::collections::BTreeMap::new();
        for hit in ordinary { ranked.insert((hit.library.clone(), hit.id.clone()), (2usize, hit)); }
        for term in &plan.terms { for hit in Panel::search(directory, term)? { let value = ranked.entry((hit.library.clone(), hit.id.clone())).or_insert((0, hit)); value.0 += 1; } }
        let mut rows: Vec<_> = ranked.into_values().collect(); rows.sort_by(|a,b| b.0.cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
        Ok(rows.into_iter().filter_map(|(_,hit)| Panel::content(directory, &hit).ok().map(|_|hit)).take(50).collect())
    }
    pub fn author(root: &Path, draft: &Match, instruction: &str, id: &str) -> Result<Match> {
        ensure!(instruction.len() <= 2000 && draft.replace.len() <= 16000, "Draft or instruction too long");
        let proposal = Self::request(root, json!({"op":"infer","kind":"author","id":id,"prompt":Self::prompt("author",json!({"instruction":instruction,"snippet":draft.replace,"content_type":draft.kind}))}))?;
        let mut result = draft.clone(); result.replace = proposal["text"].as_str().context("Invalid AI draft")?.to_owned(); Self::validate_proposal(draft, &result)?; Ok(result)
    }
    pub fn validate_proposal(original: &Match, proposal: &Match) -> Result<()> {
        ensure!(original.kind == proposal.kind && original.variables == proposal.variables && original.language == proposal.language && original.trigger == proposal.trigger, "AI changed protected snippet fields");
        ensure!(!proposal.replace.trim().is_empty() && proposal.replace.len() <= 65536, "Invalid AI draft length");
        ensure!(Self::protected(&original.replace)? == Self::protected(&proposal.replace)?, "AI changed template variables, Enter actions or image references");
        if proposal.kind == "rich_text" {
            let images = [original,proposal].into_iter().map(|draft| {
                let rendered = typerelay_core::rich_text::RichText::render(typerelay_core::rich_text::RichRequest { markdown:draft.replace.clone(), variables:draft.variables.clone(), preview:true, ..Default::default() }).map_err(anyhow::Error::msg)?;
                Ok(rendered.html.split("<img").skip(1).map(|part|part.split('>').next().unwrap_or("").to_owned()).collect::<Vec<_>>())
            }).collect::<Result<Vec<_>>>()?;
            ensure!(images[0] == images[1], "AI changed image references");
        } else { crate::templates::Templates::render_at(&proposal.value()["content"], Default::default(), true, crate::templates::Templates::clock())?; }
        Ok(())
    }
    fn protected(text: &str) -> Result<Vec<String>> {
        let mut tokens = Vec::new(); let mut rest = text;
        while let Some(index) = rest.find("{{") { rest = &rest[index..]; let end = rest.find("}}").map(|end|end+2).context("Incomplete protected token")?; tokens.push(rest[..end].to_owned()); rest = &rest[end..]; }
        Ok(tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    #[test]
    fn disabled_and_exact_search_never_start_a_worker() {
        let root = tempfile::tempdir().unwrap(); let directory = root.path().join("snippets"); let db = Database::open(&directory).unwrap(); db.import("Local", "matches: [{trigger: refund, replace: Refund policy}]").unwrap();
        assert_eq!(NativeAi::search(root.path(), &directory, "policy", "one").unwrap().len(), 1);
        NativeAi::save(root.path(), Some(NativeAi::catalog()[0].id.clone()), true).unwrap(); assert_eq!(NativeAi::search(root.path(), &directory, "REFUND", "two").unwrap()[0].abbreviation, "refund");
        assert!(!NativeAi::directory(root.path()).unwrap().join("endpoint.json").exists());
    }
    #[test]
    fn ranking_keeps_stored_readable_snippets_and_revalidates_revisions() {
        let root = tempfile::tempdir().unwrap(); let db = Database::open(root.path()).unwrap(); let local = db.import("Local", "matches: [{trigger: refund, replace: Refund policy}]").unwrap(); let synced = db.import("Synced", "matches: [{trigger: return, replace: Return policy}]").unwrap(); db.connection.execute("UPDATE libraries SET synced=1 WHERE id=?1", [&synced.id]).unwrap();
        let plan = SearchPlan { intent: "descriptive".into(), terms: vec!["policy".into(),"refund".into()] }; let rows = NativeAi::rank(root.path(), vec![], &plan).unwrap(); assert_eq!(rows.len(), 2); assert_eq!(rows[0].library, local.id);
        db.edit(&local, Some(0), None).unwrap(); assert!(Panel::content(root.path(), &rows[0]).is_err()); assert_eq!(NativeAi::rank(root.path(), rows, &plan).unwrap().len(),1);
    }
    #[test]
    fn literal_and_invalid_plans_leave_results_unchanged() {
        let root = tempfile::tempdir().unwrap(); Database::open(root.path()).unwrap().import("Local", "matches: [{trigger: a, replace: Hello}]").unwrap(); let rows = Panel::search(root.path(),"a").unwrap();
        for plan in [SearchPlan { intent:"literal".into(), terms:vec!["different".into()] }, SearchPlan { intent:"descriptive".into(), terms:vec![String::new()] }] { assert_eq!(NativeAi::rank(root.path(),rows.clone(),&plan).unwrap()[0].id,rows[0].id); }
        assert!(serde_json::from_str::<SearchPlan>(r#"{"intent":"descriptive","terms":[],"text":"invented"}"#).is_err());
    }
    #[test]
    fn proposals_preserve_tokens_actions_images_and_type() {
        let original = Match { replace: "Hello {{name}}{{key:enter}}Done".into(), kind:"template".into(), ..Default::default() }; let mut proposal = original.clone(); proposal.replace = "Welcome {{name}}{{key:enter}}Finished".into(); assert!(NativeAi::validate_proposal(&original,&proposal).is_ok());
        for text in ["Welcome {{other}}{{key:enter}}Finished", "Welcome {{name}}Finished", "Welcome {{name}}{{key:enter}}{{key:enter}}"] { proposal.replace=text.into(); assert!(NativeAi::validate_proposal(&original,&proposal).is_err()); }
        let original = Match { replace:"![Diagram](https://example.com/a.png)".into(), kind:"rich_text".into(), ..Default::default() }; let mut proposal=original.clone(); proposal.replace="![Diagram](https://example.com/b.png)".into(); assert!(NativeAi::validate_proposal(&original,&proposal).is_err()); proposal=original.clone(); proposal.kind="plain_text".into(); assert!(NativeAi::validate_proposal(&original,&proposal).is_err());
    }
    #[test]
    fn corrupt_partial_and_cancelled_models_are_never_accepted() {
        let root=tempfile::tempdir().unwrap(); let path=root.path().join("partial"); fs::write(&path,b"abc").unwrap(); let mut model=NativeAi::catalog()[0].clone(); model.bytes=3; model.sha256=format!("{:x}",Sha256::digest(b"abc")); assert!(NativeAi::verify(&path,&model,&AtomicBool::new(false)).is_ok()); assert!(NativeAi::verify(&path,&model,&AtomicBool::new(true)).is_err()); fs::write(&path,b"abd").unwrap(); assert!(NativeAi::verify(&path,&model,&AtomicBool::new(false)).is_err()); fs::write(&path,b"ab").unwrap(); assert!(NativeAi::verify(&path,&model,&AtomicBool::new(false)).is_err());
    }
    #[test]
    fn catalog_has_immutable_pins_and_does_not_invent_ram_measurements() {
        for model in NativeAi::catalog() { assert_eq!(model.revision.len(),40); assert_eq!(model.sha256.len(),64); assert!(model.bytes>1_000_000_000); assert_eq!(model.license,"apache-2.0"); assert_eq!(model.ram_bytes,None); }
    }
}
