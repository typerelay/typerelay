use crate::{bridge::Bridge, config::{Document, Match}, editor::{OpenFile, Paths}};
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{fs, path::{Path, PathBuf}, time::Duration as StdDuration};
use typerelay_core::Snapshot;
use uuid::Uuid;

pub struct Database { pub connection: Connection, directory: PathBuf }
impl Database {
    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory)?;
        let connection = Connection::open(directory.join("typerelay.sqlite"))?;
        connection.busy_timeout(StdDuration::from_secs(3))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,data TEXT NOT NULL,synced INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS snippets(id TEXT PRIMARY KEY,library TEXT NOT NULL,data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS snippet_library ON snippets(library);
            CREATE TABLE IF NOT EXISTS departures(library TEXT,id TEXT,PRIMARY KEY(library,id));
            CREATE TABLE IF NOT EXISTS base_libraries(id TEXT PRIMARY KEY,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS base_snippets(id TEXT PRIMARY KEY,library TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS recovery(id TEXT PRIMARY KEY,library TEXT,snippet TEXT,data TEXT NOT NULL);")?;
        let db = Self { connection, directory: directory.to_owned() };
        db.migrate()?;
        Ok(db)
    }
    pub fn meta(&self, key: &str) -> Result<Option<Value>> {
        self.connection.query_row("SELECT value FROM meta WHERE key=?1", [key], |row| row.get::<_, String>(0)).optional()?.map(|text| serde_json::from_str(&text).map_err(Into::into)).transpose()
    }
    pub fn set_meta(&self, key: &str, value: &Value) -> Result<()> { self.connection.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value.to_string()])?; Ok(()) }
    pub fn libraries(&self) -> Result<Vec<Value>> {
        let mut statement = self.connection.prepare("SELECT data FROM libraries ORDER BY name,id")?;
        statement.query_map([], |row| row.get::<_, String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn library(&self, id: &str) -> Result<Value> {
        let text: String = self.connection.query_row("SELECT data FROM libraries WHERE id=?1", [id], |row| row.get(0))?;
        Ok(serde_json::from_str(&text)?)
    }
    pub fn records(&self, id: &str) -> Result<Vec<Value>> {
        let mut statement = self.connection.prepare("SELECT data FROM snippets WHERE library=?1 ORDER BY CAST(json_extract(data,'$.position') AS INTEGER),id")?;
        statement.query_map([id], |row| row.get::<_, String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    fn put_record(&self, library: &str, entry: &Value) -> Result<()> {
        self.connection.execute("INSERT INTO snippets(id,library,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET library=excluded.library,data=excluded.data", params![entry["id"].as_str().context("Missing snippet ID")?, library, entry.to_string()])?;
        Ok(())
    }
    fn put_library(&self, library: &Value, name: &str, synced: bool) -> Result<()> {
        self.connection.execute("INSERT INTO libraries(id,name,data,synced) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,synced=excluded.synced,version=version+1", params![library["_id"].as_str().context("Missing library ID")?, name, library.to_string(), synced])?;
        Ok(())
    }
    pub fn synced(&self, id: &str) -> Result<bool> { Ok(self.connection.query_row("SELECT synced FROM libraries WHERE id=?1", [id], |row| row.get(0))?) }
    pub fn entries(records: &[Value]) -> Result<Vec<Match>> {
        records.iter().filter(|entry| entry["state"] == "active").map(|entry| {
            let content = &entry["content"];
            ensure!(content["version"] == 1 && (content["type"] == "plain_text" || content["type"] == "code" || content["type"] == "template"), "Unsupported snippet content");
            Ok(Match { variables: serde_json::from_value(content.get("variables").cloned().unwrap_or_else(||json!({})))?, trigger: entry["trigger"].as_str().unwrap_or_default().into(), replace: content["text"].as_str().context("Missing text")?.into(), title: entry["title"].as_str().unwrap_or_default().into(), kind: content["type"].as_str().unwrap().into(), language: content["language"].as_str().unwrap_or("plain_text").into() })
        }).collect()
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let transaction = self.connection.unchecked_transaction()?;
        let snapshot = self.validated_snapshot()?;
        transaction.commit()?;
        Ok(snapshot)
    }
    fn validated_snapshot(&self) -> Result<Snapshot> {
        let mut entries = Vec::new();
        let mut total = 0;
        let mut count = 0;
        for library in self.libraries()? {
            if library["state"] != "active" { continue; }
            count += 1;
            let next = Self::entries(&self.records(library["_id"].as_str().unwrap())?)?;
            let bytes = serde_json::to_vec(&next)?;
            ensure!(bytes.len() <= 1048576, "Library exceeds 1 MiB");
            total += bytes.len(); entries.extend(next);
        }
        ensure!(count <= 256 && total <= 8 * 1048576, "Active library limits exceeded");
        let mut snapshot = Bridge::validate(&entries)?;
        for library in self.libraries()?.iter().filter(|library| library["state"] == "active") {
            for record in self.records(library["_id"].as_str().unwrap())?.iter().filter(|record|record["state"] == "active" && record["content"]["type"] == "template") {
                snapshot.identify(record["trigger"].as_str().unwrap_or_default(), typerelay_core::Identity { id: record["id"].as_str().context("Missing ID")?.into(), library: library["_id"].as_str().unwrap().into(), revision: record["revision"].as_i64().context("Missing revision")? });
            }
        }
        Ok(snapshot)
    }
    fn validate_transaction(&self) -> Result<()> { self.validated_snapshot().map(|_| ()) }
    pub fn names(&self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare("SELECT name FROM libraries WHERE json_extract(data,'$.state')='active' ORDER BY name")?;
        Ok(statement.query_map([], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?)
    }
    pub fn editor(&self, name: &str) -> Result<OpenFile> {
        let (id, revision): (String, i64) = self.connection.query_row("SELECT id,version FROM libraries WHERE name=?1 AND json_extract(data,'$.state')='active'", [name], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let records = self.records(&id)?;
        let entries = Self::entries(&records)?;
        let ids = records.iter().filter(|entry| entry["state"] == "active").map(|entry| entry["id"].as_str().unwrap().to_owned()).collect();
        Ok(OpenFile { name: name.into(), entries, id, revision, ids })
    }
    fn name(value: &str) -> Result<String> { let name = value.trim(); ensure!(!name.is_empty() && name.len() <= 100 && !name.contains(['/', '\\', '\n', '\r']), "Use a library name without directories"); Ok(name.into()) }
    pub fn create(&self, name: &str) -> Result<OpenFile> {
        let name = Self::name(name)?;
        let transaction = self.connection.unchecked_transaction()?;
        let id = Uuid::new_v4().to_string();
        self.put_library(&json!({"_id":id,"name":name,"state":"active","revision":1,"permissions":{"read":true,"edit":true,"manage":true}}), &name, false)?;
        self.validate_transaction()?;
        transaction.commit()?;
        self.editor(&name)
    }
    pub fn editable(&self, id: &str) -> Result<()> { ensure!(self.library(id)?["permissions"]["edit"] == true, "Library is read-only"); Ok(()) }
    pub fn queue(&self, operation: &Value) -> Result<()> { self.connection.execute("INSERT INTO outbox(operation) VALUES(?1)", [operation.to_string()])?; Ok(()) }
    pub fn pending(&self) -> Result<Vec<(i64, Value)>> {
        let mut statement = self.connection.prepare("SELECT seq,operation FROM outbox ORDER BY seq")?;
        statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?.map(|row| { let (seq, text) = row?; Ok((seq, serde_json::from_str(&text)?)) }).collect()
    }
    pub fn edit(&self, file: &OpenFile, index: Option<usize>, entry: Option<Match>) -> Result<OpenFile> {
        let transaction = self.connection.unchecked_transaction()?;
        self.editable(&file.id)?;
        let current = self.editor(&file.name)?;
        ensure!(current.revision == file.revision, "Library changed outside the TUI; draft kept. Reopen before saving");
        if let Some(index) = index { ensure!(index < file.ids.len(), "Snippet no longer exists"); }
        let mut library = self.library(&file.id)?;
        let id = index.map(|index| file.ids[index].clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
        let records = self.records(&file.id)?;
        let old = records.iter().find(|record| record["id"] == id).cloned();
        let base = old.as_ref().and_then(|record| record["revision"].as_i64());
        let value = entry.as_ref().map(|entry| entry.value());
        let mut record = old.clone().unwrap_or(json!({"id":id,"position":records.iter().filter_map(|entry|entry["position"].as_i64()).max().unwrap_or(-1)+1}));
        record["revision"] = json!(base.unwrap_or(0) + 1);
        if let Some(value) = &value { record["trigger"] = value["trigger"].clone(); record["content"] = value["content"].clone(); record["title"] = value["title"].clone(); record["state"] = json!("active"); }
        else { Self::mark_trash(&mut record, !self.synced(&file.id)?); }
        self.put_record(&file.id, &record)?;
        if self.synced(&file.id)? {
            self.queue(&json!({"kind":"edit","library":file.id,"body":{"operation_id":Uuid::new_v4().to_string(),"base_revision":library["revision"],"changes":[{"id":id,"base_revision":base,"base":old,"value":value}]}}))?;
        }
        library["revision"] = json!(library["revision"].as_i64().unwrap_or(1) + 1);
        self.put_library(&library, &file.name, self.synced(&file.id)?)?;
        self.validate_transaction()?;
        transaction.commit()?;
        self.editor(&file.name)
    }
    pub fn destinations(&self, source: &str) -> Result<Vec<Value>> {
        let synced = self.synced(source)?;
        Ok(self.libraries()?.into_iter().filter(|library| library["_id"] != source && library["state"] == "active" && library["permissions"]["edit"] == true && self.synced(library["_id"].as_str().unwrap()).ok() == Some(synced)).collect())
    }
    pub fn batch_items(&self, file: &OpenFile, ids: &[String]) -> Result<Vec<Value>> {
        ensure!(self.editor(&file.name)?.revision == file.revision, "Library changed; review your selection");
        let records = self.records(&file.id)?;
        ids.iter().map(|id| {
            let record = records.iter().find(|record| record["id"] == *id && record["state"] == "active").context("Selection changed")?;
            Ok(json!({"id":id,"base_revision":record["revision"]}))
        }).collect()
    }
    pub fn batch(&self, source: &str, destination: Option<&str>, items: &[Value]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        self.batch_inner(source, destination, items, true)?;
        self.validate_transaction()?;
        transaction.commit()?;
        Ok(())
    }
    pub fn edit_move(&self, file: &OpenFile, index: usize, entry: Match, destination: &str) -> Result<OpenFile> {
        let transaction = self.connection.unchecked_transaction()?;
        let id = file.ids.get(index).context("Snippet missing")?;
        let mut items = self.batch_items(file, std::slice::from_ref(id))?;
        items[0]["value"] = entry.value();
        self.batch_inner(&file.id, Some(destination), &items, true)?;
        self.validate_transaction()?;
        transaction.commit()?;
        self.editor(&file.name)
    }
    fn batch_inner(&self, source: &str, destination: Option<&str>, items: &[Value], enqueue: bool) -> Result<()> {
        ensure!(!items.is_empty() && items.len() <= 10000, "Select snippets first");
        let mut source_library = self.library(source)?;
        ensure!(source_library["state"] == "active", "Source library is unavailable");
        self.editable(source)?;
        let synced = self.synced(source)?;
        let mut destination_library = if let Some(id) = destination {
            ensure!(id != source, "Choose another library");
            let library = self.library(id)?;
            ensure!(library["state"] == "active", "Destination library is unavailable");
            self.editable(id)?;
            ensure!(self.synced(id)? == synced, "Move only between libraries with the same sync status");
            Some(library)
        } else { None };
        let records = self.records(source)?;
        let ids: std::collections::BTreeSet<_> = items.iter().filter_map(|item|item["id"].as_str()).collect();
        ensure!(ids.len() == items.len(), "Invalid or repeated selection");
        let selected: Vec<_> = records.iter().filter(|record|record["state"] == "active" && record["id"].as_str().is_some_and(|id|ids.contains(id))).cloned().collect();
        ensure!(selected.len() == items.len(), "Selection changed; review it again");
        for record in &selected {
            let item = items.iter().find(|item|item["id"] == record["id"]).unwrap();
            ensure!(item["base_revision"] == record["revision"], "Selected snippet changed; review it again");
            ensure!(item.get("value").is_none() || (items.len() == 1 && destination.is_some()), "Edits require a single-snippet move");
        }
        let mut position = if let Some(id) = destination { self.records(id)?.iter().filter_map(|record|record["position"].as_i64()).max().unwrap_or(-1)+1 } else { 0 };
        for record in &selected {
            let mut next = record.clone();
            next["revision"] = json!(record["revision"].as_i64().context("Missing revision")? + 1);
            if let Some(id) = destination {
                next["library"] = json!(id); next["position"] = json!(position); position += 1;
                if let Some(value) = items.iter().find(|item|item["id"] == record["id"]).and_then(|item|item.get("value")) {
                    next["trigger"] = value["trigger"].clone();
                    next["content"] = value["content"].clone(); next["title"] = value["title"].clone();
                }
                self.put_record(id, &next)?;
            } else {
                Self::mark_trash(&mut next, !synced);
                self.put_record(source, &next)?;
            }
        }
        source_library["revision"] = json!(source_library["revision"].as_i64().unwrap_or(0) + 1);
        self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1", params![source,source_library.to_string()])?;
        if let Some(library) = &mut destination_library {
            library["revision"] = json!(library["revision"].as_i64().unwrap_or(0)+1);
            self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1", params![destination,library.to_string()])?;
        }
        if enqueue && synced {
            self.queue(&json!({"kind":"batch","library":source,"records":selected,"body":{"operation_id":Uuid::new_v4().to_string(),"action":if destination.is_some() {"move"} else {"trash"},"source_library":source,"destination_library":destination,"items":items}}))?;
        }
        Ok(())
    }
    fn mark_trash(record: &mut Value, local: bool) {
        record["state"] = json!("trashed");
        record["trashed_by"] = json!("local");
        record["trashed_at"] = json!(Utc::now().to_rfc3339());
        record["expires_at"] = if local { json!((Utc::now() + Duration::days(30)).to_rfc3339()) } else { Value::Null };
    }
    fn expired(record: &Value) -> bool { record["expires_at"].as_str().and_then(|date| DateTime::parse_from_rfc3339(date).ok()).is_some_and(|date| date <= Utc::now()) }
    pub fn trash(&self) -> Result<Vec<Value>> {
        let mut result = Vec::new();
        for library in self.libraries()? {
            let id = library["_id"].as_str().unwrap();
            if library["state"] == "purged" { continue; }
            let can_manage = library["permissions"]["manage"] == true;
            if library["state"] == "trashed" {
                if !Self::expired(&library) && can_manage { result.push(json!({"type":"library","id":id,"library":id,"name":library["name"],"revision":library["revision"],"can_purge":can_manage,"expires_at":library["expires_at"]})); }
                continue;
            }
            if library["state"] != "active" || library["permissions"]["edit"] != true { continue; }
            for record in self.records(id)? {
                if record["state"] == "trashed" && !Self::expired(&record) { result.push(json!({"type":"snippet","id":record["id"],"library":id,"name":record["title"].as_str().filter(|v|!v.is_empty()).or(record["trigger"].as_str()).unwrap_or("Untitled snippet"),"revision":record["revision"],"can_purge":can_manage,"expires_at":record["expires_at"]})); }
            }
        }
        Ok(result)
    }
    fn scrub(&self, library: &str, snippet: Option<&str>) -> Result<()> {
        for mut record in self.records(library)? {
            if snippet.is_some_and(|id| record["id"] != id) { continue; }
            record = json!({"id":record["id"],"state":"purged","revision":record["revision"].as_i64().unwrap_or(0)+1});
            self.put_record(library, &record)?;
        }
        self.connection.execute("DELETE FROM base_snippets WHERE library=?1 AND (?2 IS NULL OR id=?2)", params![library,snippet])?;
        if snippet.is_none() { self.connection.execute("DELETE FROM base_libraries WHERE id=?1", [library])?; }
        self.connection.execute("DELETE FROM recovery WHERE library=?1 AND (?2 IS NULL OR snippet=?2)", params![library, snippet])?;
        let mut conflicts = self.meta("conflicts")?.unwrap_or(json!([]));
        if let Some(rows) = conflicts.as_array_mut() { rows.retain(|row| row["library"] != library || snippet.is_some_and(|id| row["snippet"] != id)); }
        self.set_meta("conflicts", &conflicts)?;
        Ok(())
    }
    pub fn trash_action(&self, target: &Value, action: &str) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        self.trash_action_inner(target, action)?;
        self.validate_transaction()?;
        transaction.commit()?;
        Ok(())
    }
    fn trash_action_inner(&self, target: &Value, action: &str) -> Result<()> {
        ensure!(matches!(action, "trash" | "restore" | "purge"), "Unknown Trash action");
        let id = target["library"].as_str().context("Missing library")?;
        let mut library = self.library(id)?;
        let whole = target["type"] == "library";
        ensure!(library["permissions"][if whole || action == "purge" { "manage" } else { "edit" }] == true, "Trash permission denied");
        let record = if whole { library.clone() } else { self.records(id)?.into_iter().find(|record| record["id"] == target["id"]).context("Snippet missing")? };
        ensure!(record["revision"] == target["revision"], "Item changed; review Trash again");
        ensure!(record["state"] == if action == "trash" { "active" } else { "trashed" }, "Item is no longer in the expected state");
        if action == "restore" { ensure!(!Self::expired(&record), "Trash retention expired"); ensure!(whole || library["state"] == "active", "Restore the library first"); }
        let synced = self.synced(id)?;
        if synced { self.queue(&json!({"kind":"trash","library":id,"body":{"operation_id":Uuid::new_v4().to_string(),"target":target,"action":action}}))?; }
        let mut next = record;
        next["revision"] = json!(next["revision"].as_i64().unwrap_or(0)+1);
        if action == "trash" { Self::mark_trash(&mut next, !synced); }
        else if action == "restore" { next["state"] = json!("active"); for key in ["trashed_at","trashed_by","expires_at"] { next.as_object_mut().unwrap().remove(key); } }
        else if synced { next["state"] = json!("purge_pending"); }
        else { self.scrub(id, if whole { None } else { target["id"].as_str() })?; next = json!({"_id":id,"id":target["id"],"state":"purged","revision":next["revision"],"permissions":library["permissions"]}); }
        if whole { library = next; } else { self.put_record(id, &next)?; library["revision"] = json!(library["revision"].as_i64().unwrap_or(0)+1); }
        let name: String = self.connection.query_row("SELECT name FROM libraries WHERE id=?1", [id], |row| row.get(0))?;
        let name = if whole && action == "purge" && !synced { format!("purged-{id}") } else { name };
        self.put_library(&library, &name, synced)?;
        Ok(())
    }
    pub fn empty(&self, targets: &[Value]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for target in targets { self.trash_action_inner(target, "purge")?; }
        transaction.commit()?;
        Ok(())
    }
    pub fn cleanup(&self) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for mut library in self.libraries()? {
            let id = library["_id"].as_str().unwrap().to_owned();
            if self.synced(&id)? { continue; }
            if library["state"] == "trashed" && Self::expired(&library) {
                self.scrub(&id, None)?;
                library = json!({"_id":id,"state":"purged","revision":library["revision"].as_i64().unwrap_or(0)+1,"permissions":library["permissions"]});
                self.connection.execute("UPDATE libraries SET data=?2,name='purged-'||id,version=version+1 WHERE id=?1", params![id,library.to_string()])?;
            } else {
                for record in self.records(&id)? { if record["state"] == "trashed" && Self::expired(&record) { self.scrub(&id, record["id"].as_str())?; } }
            }
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn export(&self, name: &str, destination: &Path) -> Result<()> { let file = self.editor(name)?; Paths::atomic_write(destination, Bridge::export(&file.entries)?.as_bytes(), true) }
    pub fn import(&self, name: &str, source: &str) -> Result<OpenFile> {
        let parsed = Bridge::execute(crate::bridge::Request { yaml: Some(source.into()), matches: None, export: false, edits: vec![] })?;
        let name = Self::name(name)?;
        let transaction = self.connection.unchecked_transaction()?;
        let id = Uuid::new_v4().to_string();
        self.put_library(&json!({"_id":id,"name":name,"state":"active","revision":1,"permissions":{"read":true,"edit":true,"manage":true}}), &name, false)?;
        for (position, entry) in parsed.matches.iter().enumerate() { self.put_record(&id, &json!({"id":Uuid::new_v4().to_string(),"trigger":entry.value()["trigger"],"title":entry.title,"content":entry.value()["content"],"position":position,"revision":1,"state":"active"}))?; }
        self.validate_transaction()?;
        transaction.commit()?;
        self.editor(&name)
    }

    pub fn enroll(&self, name: &str) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        let file = self.editor(name)?;
        ensure!(!self.synced(&file.id)?, "Library already enrolled");
        let records: Vec<Value> = self.records(&file.id)?.into_iter().filter(|record| record["state"] == "active").collect();
        self.queue(&json!({"kind":"create","library":file.id,"body":{"operation_id":Uuid::new_v4().to_string(),"name":name,"snippets":records}}))?;
        self.connection.execute("UPDATE libraries SET synced=1 WHERE id=?1", [&file.id])?;
        transaction.commit()?;
        Ok(())
    }
    pub fn recover(&self, library: &str, snippet: Option<&str>, data: &Value) -> Result<()> {
        self.connection.execute("INSERT INTO recovery(id,library,snippet,data) SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM recovery WHERE library=?2 AND snippet IS ?3 AND data=?4)", params![Uuid::new_v4().to_string(),library,snippet,data.to_string()])?;
        Ok(())
    }
    pub fn recover_operation(&self, operation: &Value) -> Result<()> {
        let library = operation["library"].as_str().unwrap_or("");
        if operation["kind"] == "batch" {
            if let Some(items) = operation["body"]["items"].as_array() { for item in items {
                let purged: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM snippets WHERE id=?1 AND json_extract(data,'$.state')='purged')", [item["id"].as_str().unwrap_or("")], |row|row.get(0))?;
                if !purged { self.recover(library, item["id"].as_str(), &json!({"action":operation["body"]["action"],"item":item,"record":operation["records"].as_array().and_then(|rows|rows.iter().find(|row|row["id"] == item["id"]))}))?; }
            } }
        } else if let Some(changes) = operation["body"]["changes"].as_array() {
            for change in changes { self.recover(library, change["id"].as_str(), change)?; }
        } else if let Some(records) = operation["body"]["snippets"].as_array() {
            for record in records { self.recover(library, record["id"].as_str(), record)?; }
        } else { self.recover(library, None, operation)?; }
        Ok(())
    }
    pub fn remap(&self, old: &str, new: &str) -> Result<()> {
        if old == new { return Ok(()); }
        self.connection.execute("UPDATE libraries SET id=?2 WHERE id=?1", params![old,new])?;
        self.connection.execute("UPDATE snippets SET library=?2 WHERE library=?1", params![old,new])?;
        self.connection.execute("UPDATE base_libraries SET id=?2 WHERE id=?1", params![old,new])?;
        self.connection.execute("UPDATE base_snippets SET library=?2 WHERE library=?1", params![old,new])?;
        for (seq, mut operation) in self.pending()? {
            let previous = operation.clone();
            if operation["library"] == old { operation["library"] = json!(new); }
            for field in ["source_library","destination_library"] {
                if operation["body"][field] == old { operation["body"][field] = json!(new); }
            }
            if operation["body"]["target"]["library"] == old { operation["body"]["target"]["library"] = json!(new); if operation["body"]["target"]["type"] == "library" { operation["body"]["target"]["id"] = json!(new); } }
            if previous != operation { self.connection.execute("UPDATE outbox SET operation=?2 WHERE seq=?1", params![seq,operation.to_string()])?; }
        }
        Ok(())
    }
    fn accept_library(&self, remote: &Value) -> Result<()> {
        let id = remote["_id"].as_str().context("Missing library ID")?;
        ensure!(id.len() <= 128 && !id.is_empty(), "Invalid library ID");
        let old_name: Option<String> = self.connection.query_row("SELECT name FROM libraries WHERE id=?1", [id], |row| row.get(0)).optional()?;
        let mut name = remote["name"].as_str().map(str::to_owned).or(old_name).unwrap_or_else(|| "Library".into());
        let occupied: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE name=?1 AND id<>?2)", params![name,id], |row|row.get(0))?;
        if occupied { name = format!("{name} [{id}]"); }
        let mut library = remote.clone();
        for key in ["snippets","records","yaml","deleted"] { library.as_object_mut().context("Invalid library")?.remove(key); }
        self.connection.execute("INSERT INTO base_libraries(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![id,library.to_string()])?;
        self.connection.execute("DELETE FROM base_snippets WHERE library=?1", [id])?;
        for record in remote["records"].as_array().context("Missing structured records")? {
            self.connection.execute("INSERT INTO base_snippets(id,library,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET library=excluded.library,data=excluded.data", params![record["id"].as_str().context("Missing snippet ID")?,id,record.to_string()])?;
        }
        self.put_library(&library, &name, true)?;
        // Keep purged tombstones, replacing only content-bearing records.
        self.connection.execute("DELETE FROM snippets WHERE library=?1 AND json_extract(data,'$.state')<>'purged'", [id])?;
        for record in remote["records"].as_array().context("Missing structured snippet records")? {
            let old: Option<String> = self.connection.query_row("SELECT data FROM snippets WHERE id=?1", [record["id"].as_str().context("Missing snippet ID")?], |row|row.get(0)).optional()?;
            if old.is_some_and(|text| serde_json::from_str::<Value>(&text).is_ok_and(|old| old["state"] == "purged")) { continue; }
            if record["state"] != "purged" { Self::entries(&[json!({"state":"active","trigger":record["trigger"],"content":record["content"]})])?; }
            self.put_record(id, record)?;
            self.connection.execute("DELETE FROM departures WHERE library=?1 AND id=?2", params![id,record["id"].as_str()])?;
            self.connection.execute("UPDATE recovery SET library=?1 WHERE snippet=?2", params![id, record["id"].as_str()])?;
        }
        Ok(())
    }
    fn overlay(&self) -> Result<()> {
        // Rebuild pending projections from canonical records, so partial acknowledgements
        // cannot erase a snippet optimistically moved into a newly enrolled library.
        let mut affected = std::collections::BTreeSet::new();
        for (_, operation) in self.pending()? {
            if let Some(id) = operation["library"].as_str() { affected.insert(id.to_owned()); }
            if let Some(id) = operation["body"]["destination_library"].as_str() { affected.insert(id.to_owned()); }
        }
        let mut bases = Vec::new();
        for id in &affected {
            let base: Option<String> = self.connection.query_row("SELECT data FROM base_libraries WHERE id=?1", [id], |row|row.get(0)).optional()?;
            if let Some(base) = base {
                let data: Value = serde_json::from_str(&base)?;
                if data["state"] != "purged" {
                    self.connection.execute("DELETE FROM snippets WHERE library=?1 AND json_extract(data,'$.state')<>'purged'", [id])?;
                    bases.push((id.clone(), data));
                }
            }
        }
        for (id, data) in bases {
            let name: String = self.connection.query_row("SELECT name FROM libraries WHERE id=?1", [&id], |row|row.get(0))?;
            self.put_library(&data, &name, true)?;
            let mut statement = self.connection.prepare("SELECT data FROM base_snippets WHERE library=?1")?;
            let records = statement.query_map([&id], |row|row.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            for record in records { self.put_record(&id, &serde_json::from_str(&record)?)?; }
        }
        for (seq, operation) in self.pending()? {
            let id = operation["library"].as_str().context("Missing operation library")?;
            let Ok(mut library) = self.library(id) else { continue; };
            if library["state"] == "purged" {
                self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; continue;
            }
            let permission = if operation["kind"] == "trash" && (operation["body"]["action"] == "purge" || operation["body"]["target"]["type"] == "library") { "manage" } else { "edit" };
            if operation["kind"] == "batch" && (library["state"] != "active" || library["permissions"][permission] != true) { continue; }
            if library["permissions"][permission] != true {
                self.recover_operation(&operation)?;
                self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; continue;
            }
            if operation["kind"] == "create" {
                library["revision"] = json!(1);
                self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1", params![id,library.to_string()])?;
                self.connection.execute("DELETE FROM snippets WHERE library=?1", [id])?;
                if let Some(records) = operation["body"]["snippets"].as_array() { for record in records { self.put_record(id, record)?; } }
                continue;
            }
            if operation["kind"] == "batch" {
                self.connection.execute_batch("SAVEPOINT batch_overlay")?;
                let destination = operation["body"]["destination_library"].as_str();
                let outcome = self.batch_inner(id, destination, operation["body"]["items"].as_array().context("Missing batch selection")?, false).and_then(|_|self.validate_transaction());
                if outcome.is_err() { self.connection.execute_batch("ROLLBACK TO batch_overlay")?; }
                self.connection.execute_batch("RELEASE batch_overlay")?;
                continue;
            }
            if operation["kind"] == "trash" {
                let target = &operation["body"]["target"];
                let whole = target["type"] == "library";
                let mut record = if whole { library.clone() } else { self.records(id)?.into_iter().find(|record| record["id"] == target["id"]).unwrap_or(Value::Null) };
                if record.is_null() || record["state"] == "purged" { continue; }
                let action = operation["body"]["action"].as_str().unwrap_or("");
                if action == "trash" && record["state"] == "active" { Self::mark_trash(&mut record, false); }
                else if action == "restore" && record["state"] == "trashed" && !Self::expired(&record) { record["state"] = json!("active"); record["expires_at"] = Value::Null; }
                else if action == "purge" && record["state"] == "trashed" { record["state"] = json!("purge_pending"); }
                else { continue; }
                record["revision"] = json!(target["revision"].as_i64().unwrap_or(0)+1);
                if whole { library = record; } else { self.put_record(id, &record)?; library["revision"] = json!(library["revision"].as_i64().unwrap_or(0)+1); }
                self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1", params![id,library.to_string()])?;
            }
            if operation["kind"] == "edit" {
                for change in operation["body"]["changes"].as_array().context("Missing changes")? {
                    let location: Option<String> = self.connection.query_row("SELECT library FROM snippets WHERE id=?1", [change["id"].as_str().unwrap_or("")], |row|row.get(0)).optional()?;
                    if location.as_deref().is_some_and(|location|location != id) { continue; }
                    let departed: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM departures WHERE library=?1 AND id=?2)", params![id,change["id"].as_str()], |row|row.get(0))?;
                    if departed { continue; }
                    let old = self.records(id)?.into_iter().find(|record| record["id"] == change["id"]);
                    if old.as_ref().is_some_and(|record| record["state"] == "purged") { continue; }
                    if library["state"] != "active" || (old.as_ref().is_some_and(|record| record["state"] == "trashed") && !change["value"].is_null()) {
                        self.recover(id, change["id"].as_str(), &change["value"])?; continue;
                    }
                    let mut record = old.unwrap_or(json!({"id":change["id"],"position":self.records(id)?.iter().filter_map(|entry|entry["position"].as_i64()).max().unwrap_or(-1)+1}));
                    record["revision"] = json!(change["base_revision"].as_i64().unwrap_or(0)+1);
                    if change["value"].is_null() { Self::mark_trash(&mut record, false); }
                    else { record["state"] = json!("active"); record["trigger"] = change["value"]["trigger"].clone(); record["content"] = change["value"]["content"].clone(); record["title"] = change["value"]["title"].clone(); }
                    self.put_record(id, &record)?;
                }
                library["revision"] = json!(library["revision"].as_i64().unwrap_or(1)+1);
                self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1", params![id,library.to_string()])?;
            }
        }
        Ok(())
    }
    pub fn apply(&self, response: &Value, ack: Option<(i64, &Value)>) -> Result<()> {
        self.set_meta("staged", response)?;
        let transaction = self.connection.unchecked_transaction()?;
        if let Some((seq, operation)) = ack {
            if response["conflicts"].as_array().is_some_and(|rows| !rows.is_empty())
                && let Some(changes) = operation["body"]["changes"].as_array() { for change in changes { self.recover(operation["library"].as_str().unwrap_or(""), change["id"].as_str(), &change["value"])?; } }
            if operation["kind"] == "create" { self.remap(operation["library"].as_str().unwrap(), response["library"]["_id"].as_str().context("Missing created library")?)?; }
            self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?;
        }
        if let Some(remote) = response.get("library") { self.accept_library(remote)?; }
        if let Some(remotes) = response["libraries"].as_array() { for remote in remotes { self.accept_library(remote)?; } }
        if let Some(accessible) = response["accessible"].as_array() {
            for mut library in self.libraries()? {
                let id = library["_id"].as_str().unwrap().to_owned();
                let pending_create = self.pending()?.iter().any(|(_, operation)| operation["kind"] == "create" && operation["library"] == id);
                if self.synced(&id)? && !pending_create && !accessible.iter().any(|value| value == &id) {
                    for (seq, operation) in self.pending()? {
                        if operation["library"] == id || operation["body"]["destination_library"] == id { self.recover_operation(&operation)?; self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; }
                    }
                    self.connection.execute("DELETE FROM snippets WHERE library=?1", [&id])?;
                    self.connection.execute("DELETE FROM base_snippets WHERE library=?1", [&id])?;
                    self.connection.execute("DELETE FROM base_libraries WHERE id=?1", [&id])?;
                    library["state"] = json!("revoked"); library["permissions"] = json!({"read":false,"edit":false,"manage":false});
                    self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1", params![id,library.to_string()])?;
                }
            }
        }
        if let Some(ids) = response["purged"].as_array() {
            for id in ids {
                if let Some(id) = id.as_str() {
                    self.scrub(id, None)?;
                    self.connection.execute("UPDATE libraries SET data=?2,name='purged-'||id,version=version+1 WHERE id=?1", params![id,json!({"_id":id,"state":"purged","permissions":{}}).to_string()])?;
                }
            }
        }
        if let Some(records) = response["tombstones"].as_array() {
            for record in records {
                let library = record["library"].as_str().context("Missing tombstone library")?;
                let id = record["id"].as_str().context("Missing tombstone ID")?;
                self.scrub(library, Some(id))?;
                self.put_record(library, &json!({"id":id,"revision":record["revision"],"state":"purged"}))?;
                for (seq, operation) in self.pending()? {
                    if operation["kind"] == "batch" && operation["body"]["items"].as_array().is_some_and(|items|items.iter().any(|item|item["id"] == id)) {
                        self.recover_operation(&operation)?;
                        self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?;
                        self.set_meta("last_failure", &json!("A selected snippet was permanently removed; the bulk action was cancelled"))?;
                    }
                    if operation["library"] == library && operation["body"]["changes"].as_array().is_some_and(|changes| changes.iter().any(|change| change["id"] == id)) {
                        let mut remaining = operation.clone();
                        remaining["body"]["changes"].as_array_mut().unwrap().retain(|change| change["id"] != id);
                        if remaining["body"]["changes"].as_array().unwrap().is_empty() { self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; }
                        else { remaining["body"]["operation_id"] = json!(Uuid::new_v4().to_string()); self.connection.execute("UPDATE outbox SET operation=?2 WHERE seq=?1", params![seq,remaining.to_string()])?; }
                    }
                }
            }
        }
        if let Some(departures) = response["departures"].as_array() { for item in departures {
            self.connection.execute("INSERT OR IGNORE INTO departures(library,id) VALUES(?1,?2)", params![item["library"].as_str(),item["id"].as_str()])?;
        } }
        self.overlay()?;
        self.validate_transaction()?;
        if let Some(conflicts) = response.get("conflicts") && conflicts.as_array().is_some_and(|rows| rows.is_empty() || rows[0].is_object()) { self.set_meta("conflicts", conflicts)?; }
        if let Some(cursor) = response.get("cursor") { self.set_meta("cursor", cursor)?; }
        self.set_meta("staged", &Value::Null)?;
        transaction.commit()?;
        Ok(())
    }
    pub fn reconcile_legacy(&self, name: &str, remote: &Value, source: &str, versions: &Value) -> Result<()> {
        let current = self.editor(name)?;
        let submitted: Document = serde_saphyr::from_str(source)?;
        let id = remote["_id"].as_str().context("Missing remote library")?;
        let transaction = self.connection.unchecked_transaction()?;
        self.remap(&current.id, id)?;
        for (seq, operation) in self.pending()? { if operation["library"] == id { self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; } }
        let baseline = remote["records"].as_array().context("Missing remote records")?;
        let mut changes = Vec::new();
        for entry in &current.entries {
            let submitted_entry = submitted.matches.iter().find(|old| old.trigger == entry.trigger);
            if submitted_entry == Some(entry) { continue; }
            let old = baseline.iter().find(|record| record["trigger"] == entry.trigger);
            if old.is_none() && submitted_entry.is_some() { continue; }
            let snippet_id = old.map(|record|record["id"].clone()).unwrap_or(json!(Uuid::new_v4().to_string()));
            let revision = old.map(|record| versions[record["id"].as_str().unwrap_or("")].as_i64().map(|revision|json!(revision)).unwrap_or(record["revision"].clone()));
            changes.push(json!({"id":snippet_id,"base_revision":revision,"base":submitted_entry,"value":{"trigger":entry.trigger,"content":{"version":1,"type":"plain_text","text":entry.replace}}}));
        }
        for submitted_entry in &submitted.matches {
            if !current.entries.iter().any(|entry| entry.trigger == submitted_entry.trigger)
                && let Some(old) = baseline.iter().find(|record| record["trigger"] == submitted_entry.trigger && record["state"] == "active") {
                    let revision = versions[old["id"].as_str().unwrap_or("")].as_i64().map(|revision|json!(revision)).unwrap_or(old["revision"].clone());
                    changes.push(json!({"id":old["id"],"base_revision":revision,"base":submitted_entry,"value":null}));
                }
        }
        self.accept_library(remote)?;
        if !changes.is_empty() { self.queue(&json!({"kind":"edit","library":id,"body":{"operation_id":Uuid::new_v4().to_string(),"base_revision":remote["revision"],"changes":changes}}))?; }
        self.overlay()?;
        self.validate_transaction()?;
        self.set_meta("legacy_pending", &Value::Null)?;
        transaction.commit()?;
        Ok(())
    }
    pub fn generation(&self) -> Result<String> {
        let version: i64 = self.connection.query_row("PRAGMA data_version", [], |row|row.get(0))?;
        Ok(format!("{version}:{}", self.connection.total_changes()))
    }
    fn migrate(&self) -> Result<()> {
        if self.meta("storage_version")?.is_some() { return Ok(()); }
        let root = self.directory.parent().context("Missing config directory")?;
        let legacy_path = root.join("sync/state.json");
        let legacy = fs::read(&legacy_path).ok().map(|bytes| serde_json::from_slice::<Value>(&bytes)).transpose()?.unwrap_or(json!({}));
        let mut originals = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            if entry.file_type()?.is_file() && matches!(entry.path().extension().and_then(|value| value.to_str()), Some("yml" | "yaml")) {
                let bytes = crate::config::FileStore::read(&entry.path())?;
                let document: Document = serde_saphyr::from_str(std::str::from_utf8(&bytes)?)?;
                Bridge::validate(&document.matches)?;
                originals.push((entry.path(), bytes, document));
            }
        }
        let backup = root.join("backups").join(format!("database-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&backup)?;
        for (path, bytes, _) in &originals { Paths::atomic_write(&backup.join(path.file_name().unwrap()), bytes, true)?; }
        if legacy_path.exists() { Paths::atomic_write(&backup.join("state.json"), &fs::read(&legacy_path)?, true)?; }
        let transaction = self.connection.unchecked_transaction()?;
        if self.meta("storage_version")?.is_some() { transaction.commit()?; return Ok(()); }
        let mut imported = std::collections::BTreeSet::new();
        for (path, _, document) in &originals {
            let name = path.file_name().unwrap().to_str().context("Non-UTF8 library name")?;
            let managed = legacy["files"].as_object().and_then(|files| files.iter().find(|(_, file)| file["filename"] == name));
            let id = managed.map(|(id, _)| id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
            imported.insert(id.clone());
            let mut library = managed.map(|(_, file)| file["library"].clone()).unwrap_or(json!({"_id":id,"name":name,"revision":1,"permissions":{"read":true,"edit":true,"manage":true}}));
            library["state"] = json!("active");
            let baseline = library["snippets"].as_array().cloned().unwrap_or_default();
            library.as_object_mut().unwrap().remove("yaml"); library.as_object_mut().unwrap().remove("snippets"); library.as_object_mut().unwrap().remove("records");
            self.put_library(&library, name, managed.is_some())?;
            let mut changes = Vec::new();
            for (position, entry) in document.matches.iter().enumerate() {
                let previous = baseline.iter().find(|record| record["trigger"] == entry.trigger);
                let snippet_id = previous.and_then(|record| record["id"].as_str()).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
                let value=entry.value();
                let content = value["content"].clone();
                let record = json!({"id":snippet_id,"trigger":value["trigger"],"title":entry.title,"content":content,"position":position,"state":"active","revision":previous.map(|record| record["revision"].clone()).unwrap_or(json!(1))});
                self.put_record(&id, &record)?;
                if managed.is_some() && previous.is_none_or(|record| record["replace"] != entry.replace) { changes.push(json!({"id":snippet_id,"base_revision":previous.map(|record|record["revision"].clone()),"base":previous,"value":value})); }
            }
            for previous in &baseline {
                if !document.matches.iter().any(|entry| previous["trigger"] == entry.trigger) {
                    changes.push(json!({"id":previous["id"],"base_revision":previous["revision"],"base":previous,"value":null}));
                }
            }
            if !changes.is_empty() { self.queue(&json!({"kind":"edit","library":id,"body":{"operation_id":Uuid::new_v4().to_string(),"base_revision":library["revision"],"changes":changes}}))?; }
        }
        if let Some(files) = legacy["files"].as_object() {
            for (id, managed) in files {
                if imported.contains(id) { continue; }
                let mut library = managed["library"].clone();
                let entries = library["snippets"].as_array().cloned().unwrap_or_default();
                library["state"] = json!("active");
                library.as_object_mut().unwrap().remove("yaml"); library.as_object_mut().unwrap().remove("snippets"); library.as_object_mut().unwrap().remove("records");
                self.put_library(&library, managed["filename"].as_str().context("Missing filename")?, true)?;
                for (position, entry) in entries.iter().enumerate() { self.put_record(id, &json!({"id":entry["id"],"trigger":entry["trigger"],"content":{"version":1,"type":"plain_text","text":entry["replace"]},"revision":entry["revision"],"state":"active","position":position}))?; }
            }
        }
        if !legacy["pending"].is_null() { self.set_meta("legacy_pending", &legacy["pending"])?; }
        self.set_meta("conflicts", &legacy["conflicts"].as_array().cloned().map(Value::Array).unwrap_or(json!([])))?;
        self.set_meta("cursor", &json!(0))?;
        self.validate_transaction()?;
        self.set_meta("migration_backup", &json!(backup))?;
        self.set_meta("storage_version", &json!(2))?;
        transaction.commit()?;
        for (path, bytes, _) in originals { if fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) { fs::remove_file(path)?; } }
        if legacy_path.exists() { fs::rename(&legacy_path, backup.join("legacy-state-retired.json"))?; }
        Ok(())
    }
}
pub struct DatabaseSnapshot { pub snapshot: Snapshot, database: Database, generation: String }
impl DatabaseSnapshot {
    pub fn open(directory: &Path) -> Result<Self> {
        let database = Database::open(directory)?;
        database.cleanup()?;
        let snapshot = database.snapshot()?;
        let generation = database.generation()?;
        Ok(Self { snapshot, database, generation })
    }
    pub fn reload(&mut self) -> Result<Option<Snapshot>> {
        let generation = self.database.generation()?;
        if generation == self.generation { return Ok(None); }
        let snapshot = self.database.snapshot()?;
        self.generation = generation;
        if snapshot == self.snapshot { return Ok(None); }
        self.snapshot = snapshot.clone();
        Ok(Some(snapshot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { _temp: tempfile::TempDir, directory: PathBuf }
    impl Fixture {
        fn new() -> Self { let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("snippets"); fs::create_dir_all(&directory).unwrap(); Self { _temp: temp, directory } }
        fn db(&self) -> Database { Database::open(&self.directory).unwrap() }
        fn entry(trigger: &str, text: &str) -> Match { Match { variables: Default::default(), trigger: trigger.into(), replace: text.into(), ..Match::default() } }
    }
    #[test]
    fn code_optional_trigger_roundtrip_move_and_trash() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("Code").unwrap();
        let entry = Match { variables: Default::default(), trigger: String::new(), title: "Example".into(), kind: "code".into(), language: "RustLexer".into(), replace: "\t  {{ λ }}  \n$|$\n\n".into() };
        let file = db.edit(&file, None, Some(entry.clone())).unwrap();
        let file = db.edit(&file, None, Some(entry.clone())).unwrap();
        assert!(db.snapshot().unwrap().is_empty());
        assert_eq!(file.search("example").len(), 2);
        let yaml = Bridge::export(&file.entries).unwrap();
        let decoded: Document = serde_saphyr::from_str(&yaml).unwrap();
        assert_eq!(decoded.matches, file.entries);
        let mut activated = entry.clone(); activated.trigger = "code".into();
        let file = db.edit(&file, Some(0), Some(activated.clone())).unwrap();
        let mut engine = typerelay_core::Engine::new(db.snapshot().unwrap());
        for c in ";code".chars() { engine.feed(typerelay_core::Input::Character(c)); }
        assert_eq!(engine.feed(typerelay_core::Input::Space).unwrap().text, entry.replace);
        let destination = db.create("Destination").unwrap();
        db.edit_move(&file, 0, activated.clone(), &destination.id).unwrap();
        let destination = db.editor("Destination").unwrap();
        assert_eq!(destination.entries[0], activated);
        db.edit(&destination, Some(0), None).unwrap();
        let target = db.trash().unwrap().into_iter().find(|row|row["type"] == "snippet").unwrap();
        db.trash_action(&target, "restore").unwrap();
        assert_eq!(db.editor("Destination").unwrap().entries[0], activated);
    }
    #[test]
    fn yaml_import_is_once_export_is_derived_and_multiline_is_exact() {
        let fixture = Fixture::new();
        let original = "# old comments\nmatches:\n- trigger: naf\n  replace: |+\n    Sincerely,\n    Nitai\n\n";
        fs::write(fixture.directory.join("mine.yml"), original).unwrap();
        let db = fixture.db();
        let file = db.editor("mine.yml").unwrap();
        assert_eq!(file.entries[0].replace, "Sincerely,\nNitai\n\n");
        assert!(!fixture.directory.join("mine.yml").exists());
        let backup = db.meta("migration_backup").unwrap().unwrap();
        assert_eq!(fs::read_to_string(PathBuf::from(backup.as_str().unwrap()).join("mine.yml")).unwrap(), original);
        db.export("mine.yml", &fixture.directory.join("export.yml")).unwrap();
        assert!(fs::read_to_string(fixture.directory.join("export.yml")).unwrap().starts_with(Bridge::HEADER));
        fs::write(fixture.directory.join("export.yml"), "matches: [{trigger: hacked, replace: Ignore}]").unwrap();
        let reopened = fixture.db();
        assert_eq!(reopened.names().unwrap(), vec!["mine.yml"]);
        assert_eq!(reopened.snapshot().unwrap().len(), 1);
        assert_eq!(reopened.editor("mine.yml").unwrap().entries, file.entries);
    }
    #[test]
    fn atomic_import_duplicate_rejection_and_stale_editor_keep_data() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("Personal").unwrap();
        let saved = db.edit(&file, None, Some(Fixture::entry("hi", "One\nTwo\t\n"))).unwrap();
        assert!(db.edit(&file, None, Some(Fixture::entry("old", "Stale"))).is_err());
        assert!(db.import("Collision", "matches: [{trigger: unique, replace: A}, {trigger: hi, replace: B}]").is_err());
        assert_eq!(db.names().unwrap(), vec!["Personal"]);
        assert_eq!(db.editor("Personal").unwrap().entries, saved.entries);
    }
    #[test]
    fn library_restore_does_not_restore_independently_trashed_snippets() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("Team").unwrap();
        let file = db.edit(&file, None, Some(Fixture::entry("a", "A"))).unwrap();
        let file = db.edit(&file, None, Some(Fixture::entry("b", "B"))).unwrap();
        let file = db.edit(&file, Some(0), None).unwrap();
        let library = db.library(&file.id).unwrap();
        db.trash_action(&json!({"type":"library","id":file.id,"library":file.id,"revision":library["revision"]}), "trash").unwrap();
        assert_eq!(db.snapshot().unwrap().len(), 0);
        assert_eq!(db.trash().unwrap().len(), 1);
        db.trash_action(&db.trash().unwrap()[0], "restore").unwrap();
        assert_eq!(db.snapshot().unwrap().len(), 1);
        assert_eq!(db.trash().unwrap().len(), 1);
        assert_eq!(db.editor("Team").unwrap().entries[0].trigger, "b");
    }
    #[test]
    fn restore_collisions_and_stale_empty_requests_never_delete_active_records() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("One").unwrap();
        let file = db.edit(&file, None, Some(Fixture::entry("same", "Original"))).unwrap();
        db.edit(&file, Some(0), None).unwrap();
        let target = db.trash().unwrap()[0].clone();
        let other = db.create("Two").unwrap();
        let other = db.edit(&other, None, Some(Fixture::entry("same", "Other"))).unwrap();
        assert!(db.trash_action(&target, "restore").is_err());
        db.edit(&other, Some(0), None).unwrap();
        db.trash_action(&target, "restore").unwrap();
        assert!(db.empty(&[target]).is_err());
        assert_eq!(db.editor("One").unwrap().entries[0].replace, "Original");
    }
    #[test]
    fn expiry_and_purge_scrub_content_but_keep_identity() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("Local").unwrap();
        let file = db.edit(&file, None, Some(Fixture::entry("gone", "Sensitive old content"))).unwrap();
        let id = file.ids[0].clone();
        db.edit(&file, Some(0), None).unwrap();
        let target = db.trash().unwrap()[0].clone();
        db.connection.execute("UPDATE snippets SET data=json_set(data,'$.expires_at',?1)", [(Utc::now()-Duration::days(31)).to_rfc3339()]).unwrap();
        assert!(db.trash_action(&target, "restore").is_err());
        db.cleanup().unwrap();
        let record = &db.records(&file.id).unwrap()[0];
        assert_eq!(record["id"], id);
        assert_eq!(record["state"], "purged");
        assert!(record.get("content").is_none());
        assert!(db.trash().unwrap().is_empty());
    }
    #[test]
    fn offline_outbox_and_snapshot_updates_are_atomic() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("Offline").unwrap();
        let file = db.edit(&file, None, Some(Fixture::entry("a", "Initial"))).unwrap();
        db.enroll("Offline").unwrap();
        let pending = db.pending().unwrap();
        assert_eq!(pending[0].1["kind"], "create");
        let remote = json!({"_id":"0123456789abcdef01234567","name":"Offline","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":db.records(&file.id).unwrap()});
        db.apply(&json!({"library":remote}), Some((pending[0].0, &pending[0].1))).unwrap();
        let mut snapshot = DatabaseSnapshot::open(&fixture.directory).unwrap();
        let file = db.editor("Offline").unwrap();
        db.edit(&file, Some(0), Some(Fixture::entry("a", "Offline edit"))).unwrap();
        assert_eq!(db.pending().unwrap().len(), 1);
        assert!(snapshot.reload().unwrap().is_some());
        // A server snapshot does not discard the local pending edit.
        db.apply(&json!({"protocol":2,"cursor":3,"accessible":["0123456789abcdef01234567"],"libraries":[remote]}), None).unwrap();
        assert_eq!(db.editor("Offline").unwrap().entries[0].replace, "Offline edit");
        assert_eq!(db.pending().unwrap().len(), 1);
    }
    #[test]
    fn sync_metadata_does_not_interrupt_active_expansion_snapshots() {
        let fixture = Fixture::new(); let db = fixture.db();
        let file = db.create("Local").unwrap();
        db.edit(&file, None, Some(Fixture::entry("hi", "Hello"))).unwrap();
        let mut snapshot = DatabaseSnapshot::open(&fixture.directory).unwrap();
        db.set_meta("cursor", &json!(99)).unwrap();
        assert!(snapshot.reload().unwrap().is_none());
    }
    #[test]
    fn revocation_preserves_unsent_edits_outside_active_snapshot() {
        let fixture = Fixture::new(); let db = fixture.db();
        let remote = json!({"_id":"0123456789abcdef01234567","name":"Shared","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":false},"records":[{"id":"snippet-0000000001","trigger":"team","content":{"version":1,"type":"plain_text","text":"Server"},"revision":1,"state":"active","position":0}]});
        db.apply(&json!({"libraries":[remote],"accessible":["0123456789abcdef01234567"]}), None).unwrap();
        let file = db.editor("Shared").unwrap();
        db.edit(&file, Some(0), Some(Fixture::entry("team", "Unsent"))).unwrap();
        db.apply(&json!({"libraries":[],"accessible":[],"cursor":2}), None).unwrap();
        assert_eq!(db.snapshot().unwrap().len(), 0);
        assert!(db.pending().unwrap().is_empty());
        assert_eq!(db.connection.query_row("SELECT count(*) FROM recovery", [], |row|row.get::<_,i64>(0)).unwrap(), 1);
    }
    #[test]
    fn bulk_move_and_edit_keep_identity_order_and_rollback_collisions() {
        let fixture = Fixture::new(); let db = fixture.db();
        let source = db.import("Source", "matches: [{trigger: one, replace: One}, {trigger: two, replace: Two}]").unwrap();
        let destination = db.import("Destination", "matches: [{trigger: existing, replace: Existing}]").unwrap();
        let items = db.batch_items(&source, &source.ids.iter().rev().cloned().collect::<Vec<_>>()).unwrap();
        db.batch(&source.id, Some(&destination.id), &items).unwrap();
        assert!(db.editor("Source").unwrap().entries.is_empty());
        let moved = db.editor("Destination").unwrap();
        assert_eq!(&moved.ids[1..], &source.ids);
        assert_eq!(db.snapshot().unwrap().len(), 3);
        assert!(db.batch(&source.id, Some(&destination.id), &items).is_err());
        let destination2 = db.create("Other").unwrap();
        db.edit_move(&moved, 1, Fixture::entry("changed", "Edited\nText"), &destination2.id).unwrap();
        let edited = db.editor("Other").unwrap();
        assert_eq!(edited.ids[0], source.ids[0]);
        assert_eq!(edited.entries[0].replace, "Edited\nText");
        db.enroll("Other").unwrap();
        assert!(db.destinations(&destination.id).unwrap().iter().all(|row|row["_id"] != destination2.id));
        assert!(db.batch(&destination.id, Some(&destination2.id), &db.batch_items(&db.editor("Destination").unwrap(), &[source.ids[1].clone()]).unwrap()).is_err());
    }
    #[test]
    fn batch_outbox_and_pending_enrollment_references_are_atomic() {
        let fixture = Fixture::new(); let db = fixture.db();
        let source = db.import("Source", "matches: [{trigger: one, replace: One}]").unwrap();
        let destination = db.create("Destination").unwrap();
        db.enroll("Source").unwrap(); db.enroll("Destination").unwrap();
        let items = db.batch_items(&source, &source.ids).unwrap();
        db.batch(&source.id, Some(&destination.id), &items).unwrap();
        assert_eq!(db.pending().unwrap().len(), 3);
        let transaction = db.connection.unchecked_transaction().unwrap();
        db.remap(&source.id, "111111111111111111111111").unwrap();
        db.remap(&destination.id, "222222222222222222222222").unwrap();
        transaction.commit().unwrap();
        let operation = &db.pending().unwrap()[2].1;
        assert_eq!(operation["library"], "111111111111111111111111");
        assert_eq!(operation["body"]["source_library"], "111111111111111111111111");
        assert_eq!(operation["body"]["destination_library"], "222222222222222222222222");
        assert_eq!(db.records("222222222222222222222222").unwrap()[0]["id"], source.ids[0]);
    }

}
