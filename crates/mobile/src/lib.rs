//! Serialized native bridge. App storage and keyboard snapshots never contain OAuth credentials.
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, ffi::{CStr, CString, c_char}, fs, path::Path};
use typerelay_client::{assets::Assets, config::Match, database::Database, editor::Paths, panel::Panel, sync::{Credentials, ServerError, Sync}, templates::Templates};
use typerelay_core::rich_text::{RichRequest, RichText};

pub struct Mobile;
impl Mobile {
    fn text<'a>(request: &'a Value, key: &str) -> Result<&'a str> { request[key].as_str().with_context(|| format!("Missing {key}")) }
    pub fn dispatch(directory: &Path, shared: &Path, request: &Value) -> Result<Value> {
        let action = Self::text(request, "action")?;
        // Extensions use only these read-only operations, without opening the SQLite database.
        if action == "keyboard" { return Ok(serde_json::from_slice(&fs::read(shared.join("keyboard.json"))?)?); }
        if action == "keyboard_matches" {
            let snapshot: Value = serde_json::from_slice(&fs::read(shared.join("keyboard.json"))?)?;
            ensure!(snapshot["generation"] == request["generation"], "Snippets changed; search again");
            return Self::keyboard_matches(&snapshot, request);
        }
        if action == "keyboard_usage" {
            let snapshot: Value = serde_json::from_slice(&fs::read(shared.join("keyboard.json"))?)?;
            ensure!(snapshot["generation"] == request["generation"], "Snippets changed");
            let identity = &snapshot["statistics_identity"];
            if !identity["user"].is_string() { return Ok(json!({})); }
            let library = snapshot["libraries"].as_array().context("Invalid snapshot")?.iter().find(|library| library["_id"] == request["library"]).context("Library unavailable")?;
            if library["synced"] != true { return Ok(json!({})); }
            ensure!(library["records"].as_array().context("Invalid library")?.iter().any(|record| record["id"] == request["id"]), "Snippet unavailable");
            ensure!(matches!(request["kind"].as_str(), Some("copy" | "insert")), "Invalid usage action");
            let characters = request["characters"].as_u64().context("Missing character count")?;
            let client = if cfg!(target_os="ios") { "ios" } else if cfg!(target_os="android") { "android" } else { "mobile" };
            let event = Database::usage_event(Self::text(request,"library")?,Self::text(request,"id")?,library["shared"]==true,Self::text(request,"kind")?,client,characters as usize);
            let id = event["event_id"].as_str().context("Missing usage ID")?;
            fs::create_dir_all(shared.join("usage"))?;
            Paths::atomic_write(&shared.join("usage").join(id), &serde_json::to_vec(&json!({"identity":identity,"event":event}))?, false)?;
            return Ok(json!({}));
        }
        if action == "keyboard_render" {
            let snapshot: Value = serde_json::from_slice(&fs::read(shared.join("keyboard.json"))?)?;
            ensure!(snapshot["generation"] == request["generation"], "Snippets changed; select again");
            let record = snapshot["libraries"].as_array().context("Invalid snapshot")?.iter().filter(|library| library["_id"] == request["library"]).flat_map(|library| library["records"].as_array().into_iter().flatten()).find(|record| record["id"] == request["id"]).context("Snippet is no longer available")?;
            let content = &record["content"];
            // Only the containing app requests rich clipboard binaries; keyboard insertion stays lightweight.
            let mut assets = BTreeMap::new();
            if request["clipboard"] == true { for id in content["assets"].as_array().into_iter().flatten() {
                let id = id.as_str().context("Invalid asset ID")?;
                ensure!(id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()), "Invalid asset ID");
                assets.insert(id.into(), fs::read_to_string(shared.join("assets").join(id))?);
            } }
            return Self::render(content, request, assets);
        }
        if action == "reset" {
            // Revoke keyboard visibility first, even if private-data removal subsequently fails.
            Paths::atomic_write(&shared.join("keyboard.json"), br#"{"generation":"signed-out","libraries":[]}"#, false)?;
            if shared.join("usage").exists() { fs::remove_dir_all(shared.join("usage"))?; }
            if shared.join("assets").exists() { fs::remove_dir_all(shared.join("assets"))?; }
            if directory.exists() { fs::remove_dir_all(directory)?; }
            return Ok(json!({}));
        }
        let db = Database::open(directory)?;
        let result = match action {
            "state" => Self::state(&db)?,
            "bind" => {
                let identity = json!({"server":Self::text(request,"server")?,"account":Self::text(request,"account")?});
                if let Some(previous) = db.meta("mobile_identity")? { ensure!(previous == identity, "Sign out before switching accounts; pending drafts belong to the previous account."); }
                db.set_meta("mobile_identity", &identity)?; json!({})
            }
            "resolve" => {
                let id = Self::text(request, "id")?;
                let conflicts = db.meta("conflicts")?.unwrap_or(json!([]));
                let conflict = conflicts.as_array().context("Invalid conflicts")?.iter().find(|conflict|conflict["_id"] == id).context("Conflict is no longer available")?;
                let library_id = conflict["library"].as_str().context("Missing conflict library")?;
                db.editable(library_id)?;
                ensure!(matches!(request["choice"].as_str(), Some("server" | "local")), "Choose a resolution");
                if !db.pending()?.iter().any(|(_,operation)| operation["kind"] == "resolve" && operation["conflict"] == id) {
                    db.queue(&json!({"kind":"resolve","conflict":id,"library":library_id,"body":{"operation_id":Self::text(request,"operation_id")?,"choice":request["choice"],"base_revision":db.library(library_id)?["revision"]}}))?;
                }
                json!({"queued":true})
            }
            "trash" => json!(db.trash()?),
            "trash_action" => {
                let operation = Self::text(request, "operation_id")?;
                ensure!((16..=128).contains(&operation.len()) && operation.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'), "Invalid operation ID");
                let trash_action = Self::text(request, "trash_action")?;
                ensure!(matches!(trash_action, "restore" | "purge"), "Unknown Trash action");
                let key = format!("mobile-trash-{operation}");
                let signature = format!("{:x}", Sha256::digest(serde_json::to_vec(request)?));
                if let Some(receipt) = db.meta(&key)? { ensure!(receipt["signature"] == signature, "This Trash action already completed for another item."); return Ok(receipt["result"].clone()); }
                db.trash_action(&request["target"], trash_action)?;
                let result = json!({"completed":true,"items":db.trash()?});
                db.set_meta(&key, &json!({"signature":signature,"result":result}))?;
                result
            }
            "suspend" => { db.set_meta("keyboard_blocked", &json!(true))?; Self::publish(&db, shared)?; json!({}) },
            "save" => {
                let operation = Self::text(request, "operation_id")?;
                ensure!((16..=128).contains(&operation.len()) && operation.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'), "Invalid operation ID");
                let key = format!("mobile-save-{operation}");
                let signature = format!("{:x}", Sha256::digest(serde_json::to_vec(request)?));
                if let Some(receipt) = db.meta(&key)? { ensure!(receipt["signature"] == signature, "This save already completed with different content. Reopen the snippet."); Self::publish(&db, shared)?; return Ok(receipt["result"].clone()); }
                let transaction = db.connection.unchecked_transaction()?;
                let library = db.library(Self::text(request, "library")?)?;
                let file = db.editor(library["name"].as_str().context("Missing library name")?)?;
                let index = if let Some(id) = request["id"].as_str() { Some(file.ids.iter().position(|existing| existing == id).context("Snippet is no longer available")?) } else { None };
                if let Some(index) = index { let record = db.records(&file.id)?.into_iter().find(|record| record["id"] == file.ids[index]).context("Snippet no longer exists")?; ensure!(record["revision"] == request["record_revision"], "This snippet changed. Your draft is kept; save as a new snippet to keep both versions."); }
                let entry: Match = serde_json::from_value(request["entry"].clone())?;
                let saved = db.edit(&file, index, Some(entry))?;
                let result = json!({"library": saved.id, "id": index.map(|index| saved.ids[index].clone()).unwrap_or_else(|| saved.ids.last().unwrap().clone())});
                db.set_meta(&key, &json!({"signature":signature,"result":result}))?;
                transaction.commit()?;
                result
            }
            "delete" => {
                let operation = Self::text(request, "operation_id")?;
                ensure!((16..=128).contains(&operation.len()) && operation.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'), "Invalid operation ID");
                let key = format!("mobile-delete-{operation}");
                let signature = format!("{:x}", Sha256::digest(serde_json::to_vec(request)?));
                if let Some(receipt) = db.meta(&key)? { ensure!(receipt["signature"] == signature, "This delete already completed for another snippet."); Self::publish(&db, shared)?; return Ok(receipt["result"].clone()); }
                let transaction = db.connection.unchecked_transaction()?;
                let library = db.library(Self::text(request, "library")?)?;
                let file = db.editor(library["name"].as_str().context("Missing library name")?)?;
                let id = Self::text(request, "id")?;
                let index = file.ids.iter().position(|existing| existing == id).context("Snippet is no longer available")?;
                let record = db.records(&file.id)?.into_iter().find(|record| record["id"] == id).context("Snippet no longer exists")?;
                ensure!(record["revision"] == request["record_revision"], "This snippet changed. Reopen it before deleting.");
                db.edit(&file, Some(index), None)?;
                let result = json!({"library":file.id,"id":id,"deleted":true});
                db.set_meta(&key, &json!({"signature":signature,"result":result}))?;
                transaction.commit()?;
                result
            }
            "sync" => {
                if shared.join("usage").exists() {
                    for file in fs::read_dir(shared.join("usage"))? { let file = file?; if !file.file_type()?.is_file() || file.file_name().to_string_lossy().contains('.') { continue; } let value: Value = serde_json::from_slice(&fs::read(file.path())?)?; db.queue_usage(&value["identity"], &value["event"])?; fs::remove_file(file.path())?; }
                }
                let server = Self::text(request, "server")?;
                let mut credentials = Credentials { server: server.into(), access_token: Self::text(request, "access_token")?.into(), refresh_token: String::new(), account:None, device:None };
                let sync = Sync::new(directory.to_owned(), directory.to_owned())?;
                let result = sync.cycle_authenticated(&mut credentials);
                // A partially completed cycle may have removed access or applied acknowledged writes.
                if result.is_ok() { db.set_meta("keyboard_blocked", &json!(false))?; }
                Self::publish(&db, shared)?;
                result?;
                Self::state(&db)?
            }
            "asset_fetch" => {
                let credentials = Credentials { server: Self::text(request,"server")?.into(), access_token: Self::text(request,"access_token")?.into(), refresh_token: String::new(), account:None, device:None };
                Sync::new(directory.to_owned(), directory.to_owned())?.download_asset(&credentials, &db, &request["metadata"])?;
                request["metadata"].clone()
            }
            "asset_import" => {
                let bytes = STANDARD.decode(Self::text(request, "base64")?)?;
                let (metadata, bytes) = Assets::normalize(&bytes, "")?;
                db.put_asset(&metadata, &bytes, false)?;
                metadata
            }
            "asset" => {
                let (metadata, bytes) = db.asset(Self::text(request, "id")?)?.context("Image unavailable offline")?;
                json!({"url": format!("data:{};base64,{}", metadata["mime_type"].as_str().unwrap(), STANDARD.encode(bytes))})
            }
            "render" => {
                let content = &request["content"];
                if content["type"] == "rich_text" {
                    serde_json::to_value(Panel::rich_render(directory, content, serde_json::from_value(request.get("values").cloned().unwrap_or(json!({})))?, request["preview"] == true, Templates::clock())?)?
                } else { Self::render(content, request, BTreeMap::new())? }
            }
            "recovery" => {
                let mut statement = db.connection.prepare("SELECT id,library,data FROM recovery ORDER BY rowid")?;
                let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?;
                json!(rows.map(|row| { let (id, library, data) = row?; Ok(json!({"id":id,"library":library,"data":serde_json::from_str::<Value>(&data)?})) }).collect::<Result<Vec<_>>>()?)
            }
            "draft" => { db.set_meta("mobile_draft", request.get("draft").unwrap_or(&Value::Null))?; json!({}) }
            _ => anyhow::bail!("Unknown mobile action"),
        };
        if matches!(action, "state" | "save" | "delete" | "trash_action") { Self::publish(&db, shared)?; }
        Ok(result)
    }
    fn keyboard_matches(snapshot: &Value, request: &Value) -> Result<Value> {
        let mode = Self::text(request, "mode")?;
        ensure!(mode == "typing" || mode == "search", "Unknown keyboard match mode");
        let input = Self::text(request, if mode == "typing" { "context" } else { "query" })?;
        ensure!(input.len() <= 512, "Keyboard match input is too long");
        let fragment = if mode == "typing" {
            let start = input.char_indices().rev().take_while(|(_, character)| character.is_ascii_alphanumeric() || *character == '-').last().map(|(index, _)| index).unwrap_or(input.len());
            let preceding = input[..start].chars().last();
            if preceding.is_some_and(|character| character.is_alphanumeric() || character == '_') || input.len() - start > 63 { "" } else { &input[start..] }
        } else { input.trim() };
        let needle = fragment.to_lowercase();
        let mut ranked = Vec::new();
        if mode == "search" || !needle.is_empty() {
            for library in snapshot["libraries"].as_array().context("Invalid keyboard snapshot")? {
                for record in library["records"].as_array().context("Invalid keyboard records")? {
                    if mode=="typing" && record["abbreviation_collision"]==true { continue; }
                    let trigger = record.get("effective_trigger").unwrap_or(&record["trigger"]).as_str().unwrap_or("");
                    let title = record["title"].as_str().filter(|title| !title.is_empty()).unwrap_or(trigger);
                    let content = &record["content"];
                    let replacement = content["text"].as_str().filter(|text| !text.trim().is_empty()).or_else(|| content["markdown"].as_str()).unwrap_or(title);
                    let lower_trigger = trigger.to_lowercase();
                    let rank = if mode == "typing" {
                        if trigger.is_empty() || !lower_trigger.starts_with(&needle) { continue; }
                        if lower_trigger == needle { 0 } else { 1 }
                    } else if needle.is_empty() { 3 }
                    else if lower_trigger == needle { 0 }
                    else if lower_trigger.starts_with(&needle) { 1 }
                    else if lower_trigger.contains(&needle) || title.to_lowercase().contains(&needle) { 2 }
                    else if replacement.to_lowercase().contains(&needle) { 3 }
                    else { continue; };
                    let preview = replacement.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect::<String>();
                    ranked.push((rank, lower_trigger, json!({"id":record["id"],"library":library["_id"],"title":title,"trigger":trigger,"preview":preview})));
                }
            }
        }
        ranked.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)).then(left.2["library"].as_str().cmp(&right.2["library"].as_str())).then(left.2["id"].as_str().cmp(&right.2["id"].as_str())));
        let exact = if mode == "typing" && ranked.len() == 1 && ranked[0].0 == 0 { ranked.first().map(|hit| hit.2.clone()) } else { None };
        let limit = if mode == "typing" { 3 } else { 60 };
        let truncated = ranked.len() > limit;
        Ok(json!({"fragment":fragment,"matches":ranked.into_iter().take(limit).map(|hit| hit.2).collect::<Vec<_>>(),"exact":exact,"truncated":truncated}))
    }
    fn render(content: &Value, request: &Value, assets: BTreeMap<String, String>) -> Result<Value> {
        let values = serde_json::from_value(request.get("values").cloned().unwrap_or(json!({})))?;
        let clock = Templates::clock();
        if content["type"] == "rich_text" {
            Ok(serde_json::to_value(RichText::render(RichRequest { markdown: Self::text(content, "markdown")?.into(), variables: serde_json::from_value(content.get("variables").cloned().unwrap_or(json!({})))?, values, preview: request["preview"] == true, assets, now_ms: clock.0, offset_minutes: clock.1 }).map_err(anyhow::Error::msg)?)?)
        } else { Ok(serde_json::to_value(Templates::render_at(content, values, request["preview"] == true, clock)?)?) }
    }
    fn state(db: &Database) -> Result<Value> {
        let transaction = db.connection.unchecked_transaction()?;
        let mut libraries = Vec::new();
        let collisions = db.abbreviation_collisions()?;
        for mut library in db.libraries()? {
            if library["state"] != "active" || library["permissions"]["read"] != true { continue; }
            let id = library["_id"].as_str().context("Missing library ID")?;
            let file = db.editor(library["name"].as_str().context("Missing name")?)?;
            let synced=db.synced(id)?;
            library["records"] = json!(db.effective_records(id)?.into_iter().filter(|record| record["state"] == "active").map(|mut record| { record["abbreviation_collision"]=json!(collisions.contains(record["effective_trigger"].as_str().unwrap_or(""))); record }).collect::<Vec<_>>());
            library["editor_revision"] = json!(file.revision);
            library["synced"] = json!(synced);
            libraries.push(library);
        }
        let snapshot_libraries = libraries.iter().cloned().map(|mut library| { library.as_object_mut().unwrap().remove("editor_revision"); library }).collect::<Vec<_>>();
        let result = json!({"mobile_bridge_version":2,"generation": format!("{:x}", Sha256::digest(serde_json::to_vec(&snapshot_libraries)?)), "libraries": libraries, "pending": db.pending()?.len(), "conflicts": db.meta("conflicts")?.unwrap_or(json!([])), "draft": db.meta("mobile_draft")?, "last_failure":db.meta("last_failure")?});
        transaction.commit()?;
        Ok(result)
    }
    fn publish(db: &Database, shared: &Path) -> Result<()> {
        let mut state = Self::state(db)?;
        if db.meta("keyboard_blocked")? == Some(json!(true)) { state["libraries"] = json!([]); state["generation"] = json!("suspended"); }
        let mut referenced = BTreeSet::new();
        fs::create_dir_all(shared.join("assets"))?;
        for library in state["libraries"].as_array().unwrap() {
            for record in library["records"].as_array().unwrap() {
                for id in record["content"]["assets"].as_array().into_iter().flatten() {
                    let id = id.as_str().context("Invalid asset ID")?;
                    referenced.insert(id.to_owned());
                    if !shared.join("assets").join(id).exists() && let Some((metadata, bytes)) = db.asset(id)? { Paths::atomic_write(&shared.join("assets").join(id), format!("data:{};base64,{}", metadata["mime_type"].as_str().unwrap(), STANDARD.encode(bytes)).as_bytes(), false)?; }
                }
            }
        }
        Paths::atomic_write(&shared.join("keyboard.json"), &serde_json::to_vec(&json!({"generation":state["generation"],"libraries":state["libraries"],"statistics_identity":db.meta("statistics_identity")?}))?, false)?;
        for file in fs::read_dir(shared.join("assets"))? { let file = file?; if !referenced.contains(&file.file_name().to_string_lossy().to_string()) && file.file_type()?.is_file() { fs::remove_file(file.path())?; } }
        Ok(())
    }
    pub fn call(directory: &str, shared: &str, request: &str) -> String {
        let result = std::panic::catch_unwind(|| -> Result<Value> { ensure!(request.len() <= 12 * 1048576, "Request too large"); Self::dispatch(Path::new(directory), Path::new(shared), &serde_json::from_str(request)?) });
        match result { Ok(Ok(value)) => json!({"data":value}), Ok(Err(error)) => json!({"error":error.to_string(),"status":error.downcast_ref::<ServerError>().map(|error|error.status)}), Err(_) => json!({"error":"Native operation failed"}) }.to_string()
    }
    /// Pointers must be valid NUL-terminated UTF-8 strings, owned by the caller for this call.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn typerelay_mobile_call(directory: *const c_char, shared: *const c_char, request: *const c_char) -> *mut c_char {
        let read = |pointer| unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
        CString::new(Self::call(&read(directory), &read(shared), &read(request))).unwrap().into_raw()
    }
    /// Release exactly once, using a pointer returned by typerelay_mobile_call.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn typerelay_mobile_free(pointer: *mut c_char) { if !pointer.is_null() { drop(unsafe { CString::from_raw(pointer) }); } }
    #[cfg(target_os = "android")]
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_typerelay_mobile_NativeCore_call(mut env: jni::JNIEnv, _class: jni::objects::JClass, directory: jni::objects::JString, shared: jni::objects::JString, request: jni::objects::JString) -> jni::sys::jstring {
        let result = (|| -> jni::errors::Result<String> { Ok(Self::call(&String::from(env.get_string(&directory)?), &String::from(env.get_string(&shared)?), &String::from(env.get_string(&request)?))) })().unwrap_or_else(|_| "{\"error\":\"Invalid native request\"}".into());
        env.new_string(result).map(|value|value.into_raw()).unwrap_or(std::ptr::null_mut())
    }
}

#[cfg(test)]
mod tests;
