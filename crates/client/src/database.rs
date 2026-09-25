use crate::{bridge::Bridge, config::{Document, Match}, editor::{OpenFile, Paths}};
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{fs,io::{Read,Write}, path::{Path, PathBuf}, time::Duration as StdDuration};
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
            CREATE TABLE IF NOT EXISTS recovery(id TEXT PRIMARY KEY,library TEXT,snippet TEXT,data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,animated INTEGER NOT NULL DEFAULT 0,source_urls TEXT NOT NULL DEFAULT '[]',data BLOB NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS snippet_assets(snippet TEXT NOT NULL,asset TEXT NOT NULL,PRIMARY KEY(snippet,asset));
            CREATE INDEX IF NOT EXISTS snippet_asset_asset ON snippet_assets(asset);")?;
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
		let id=entry["id"].as_str().context("Missing snippet ID")?;
		self.connection.execute("INSERT INTO snippets(id,library,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET library=excluded.library,data=excluded.data", params![id, library, entry.to_string()])?;
		self.connection.execute("DELETE FROM snippet_assets WHERE snippet=?1",[id])?;
		if let Some(assets)=entry["content"]["assets"].as_array(){for asset in assets{self.connection.execute("INSERT OR IGNORE INTO snippet_assets(snippet,asset) VALUES(?1,?2)",params![id,asset.as_str().context("Invalid asset reference")?])?;}}
		Ok(())
    }
    fn put_library(&self, library: &Value, name: &str, synced: bool) -> Result<()> {
        self.connection.execute("INSERT INTO libraries(id,name,data,synced) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,synced=excluded.synced,version=version+1", params![library["_id"].as_str().context("Missing library ID")?, name, library.to_string(), synced])?;
        Ok(())
    }
    pub fn synced(&self, id: &str) -> Result<bool> { Ok(self.connection.query_row("SELECT synced FROM libraries WHERE id=?1", [id], |row| row.get(0))?) }
	fn sync_value(record:&Value)->Option<Value>{(record["state"]=="active").then(||json!({"trigger":record["trigger"],"title":record.get("title").cloned().unwrap_or(Value::Null),"content":record["content"]}))}
	fn preserve_collision(&self,id:&str)->Result<()> {let replacement=Uuid::new_v4().to_string();self.remap(id,&replacement)?;let mut library=self.library(&replacement)?;library["_id"]=json!(replacement);self.connection.execute("UPDATE libraries SET data=?2,synced=0,version=version+1 WHERE id=?1",params![replacement,library.to_string()])?;Ok(())}
	fn finish_local_merge(&self,id:&str)->Result<()> {let mut library=self.library(id)?;if library["state"]!="active"{return Ok(());}Self::mark_trash(&mut library,true);library["revision"]=json!(library["revision"].as_i64().unwrap_or(0)+1);self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1",params![id,library.to_string()])?;Ok(())}
	pub fn reconcile_detached(&self,response:&Value,server:&str,account:Option<&str>)->Result<()> {
		let Some(mut detached)=self.meta("detached")? else{return Ok(());};
		let provenance=detached["server"]==server&&!detached["account"].as_str().is_some_and(|stored|account!=Some(stored));
		let Some(ids)=detached["libraries"].as_array().cloned()else{return Ok(());};
		let remotes=response["libraries"].as_array().cloned().unwrap_or_default();
		let matched:Vec<String>=ids.iter().filter_map(Value::as_str).filter(|id|remotes.iter().any(|remote|remote["_id"]==*id)).map(str::to_owned).collect();
		if matched.is_empty(){return Ok(());}
		let backup=self.directory.parent().context("Missing configuration directory")?.join("backups").join(format!("reconnect-{}",Uuid::new_v4()));
		fs::create_dir_all(&backup)?;self.connection.backup(rusqlite::MAIN_DB,backup.join("typerelay.sqlite"),None)?;
		let transaction=self.connection.unchecked_transaction()?;
		let mut moved=std::collections::BTreeSet::new();
		if provenance {let mut bases=std::collections::BTreeMap::new();let mut locals=std::collections::BTreeMap::new();for library in &matched{let exists:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM base_libraries WHERE id=?1)",[library],|row|row.get(0))?;if !exists{continue;}let mut statement=self.connection.prepare("SELECT data FROM base_snippets WHERE library=?1")?;for text in statement.query_map([library],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?{let record:Value=serde_json::from_str(&text)?;if let Some(id)=record["id"].as_str(){bases.insert(id.to_owned(),(library.clone(),record));}}for record in self.records(library)?{if let Some(id)=record["id"].as_str(){locals.insert(id.to_owned(),(library.clone(),record));}}}for (id,(source,base)) in &bases{let Some((destination,local))=locals.get(id).filter(|(_,record)|Self::sync_value(record).is_some())else{continue;};if source==destination{continue;}let mut item=json!({"id":id,"base_revision":base["revision"]});if Self::sync_value(base)!=Self::sync_value(local){item["value"]=Self::sync_value(local).unwrap();}self.queue(&json!({"kind":"batch","library":source,"records":[base],"body":{"operation_id":Uuid::new_v4().to_string(),"action":"move","source_library":source,"destination_library":destination,"items":[item]}}))?;moved.insert(id.clone());}}
		for id in &matched {
			let base_library:Option<String>=self.connection.query_row("SELECT data FROM base_libraries WHERE id=?1",[id],|row|row.get(0)).optional()?;
			if !provenance||base_library.is_none(){self.preserve_collision(id)?;continue;}let base_library:Value=serde_json::from_str(base_library.as_ref().unwrap())?;
			let mut statement=self.connection.prepare("SELECT data FROM base_snippets WHERE library=?1")?;
			let bases=statement.query_map([id],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?.into_iter().map(|text|serde_json::from_str::<Value>(&text)).collect::<std::result::Result<Vec<_>,_>>()?;
			let locals=self.records(id)?;let mut record_ids=std::collections::BTreeSet::new();
			for record in bases.iter().chain(locals.iter()){if let Some(record_id)=record["id"].as_str(){record_ids.insert(record_id.to_owned());}}
			let mut changes=Vec::new();
			for record_id in record_ids {if moved.contains(&record_id){continue;}let base=bases.iter().find(|record|record["id"]==record_id);let local=locals.iter().find(|record|record["id"]==record_id);let base_value=base.and_then(Self::sync_value);let local_value=local.and_then(Self::sync_value);if base_value==local_value{continue;}changes.push(json!({"id":record_id,"base_revision":base.and_then(|record|record["revision"].as_i64()),"base":base.cloned().unwrap_or(Value::Null),"value":local_value}));}
			if !changes.is_empty(){self.queue(&json!({"kind":"edit","library":id,"body":{"operation_id":Uuid::new_v4().to_string(),"base_revision":base_library["revision"],"changes":changes}}))?;}
		}
		detached["libraries"]=Value::Array(ids.into_iter().filter(|id|!matched.iter().any(|matched|id==matched)).collect());self.set_meta("detached",&detached)?;self.set_meta("last_reconnect_backup",&json!(backup))?;
		transaction.commit()?;Ok(())
	}
    pub fn entries(records: &[Value]) -> Result<Vec<Match>> {
        records.iter().filter(|entry| entry["state"] == "active").map(|entry| {
            let content = &entry["content"];
            ensure!((content["version"] == 1 && matches!(content["type"].as_str(),Some("plain_text")|Some("code")|Some("template")))||(content["version"]==2&&content["type"]=="rich_text"), "Unsupported snippet content");
			Ok(Match { variables: serde_json::from_value(content.get("variables").cloned().unwrap_or_else(||json!({})))?, trigger: entry["trigger"].as_str().unwrap_or_default().into(), replace: if content["type"]=="rich_text"{content["markdown"].as_str().context("Missing rich text")?}else{content["text"].as_str().context("Missing text")?}.into(), title: entry["title"].as_str().unwrap_or_default().into(), kind: content["type"].as_str().unwrap().into(), language: content["language"].as_str().unwrap_or("plain_text").into() })
        }).collect()
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let transaction = self.connection.unchecked_transaction()?;
        let snapshot = self.validated_snapshot()?;
        transaction.commit()?;
        Ok(snapshot)
    }
    fn validated_snapshot(&self) -> Result<Snapshot> {
        let collisions = self.abbreviation_collisions()?;
        let mut entries = Vec::new();
        let mut total = 0;
        let mut count = 0;
        for library in self.libraries()? {
            if library["state"] != "active" { continue; }
            count += 1;
            let mut records = self.effective_records(library["_id"].as_str().unwrap())?;
            Bridge::validate(&Self::entries(&records)?)?;
            for record in &mut records { record["trigger"] = if collisions.contains(record["effective_trigger"].as_str().unwrap_or("")) { Value::Null } else { record["effective_trigger"].clone() }; }
            let next = Self::entries(&records)?;
            let bytes = serde_json::to_vec(&next)?;
            ensure!(bytes.len() <= 1048576, "Library exceeds 1 MiB");
            total += bytes.len(); entries.extend(next);
        }
        ensure!(count <= 256 && total <= 8 * 1048576, "Active library limits exceeded");
        let mut snapshot = Bridge::validate(&entries)?;
        for library in self.libraries()?.iter().filter(|library| library["state"] == "active") {
            for record in self.effective_records(library["_id"].as_str().unwrap())?.iter().filter(|record|record["state"] == "active" && !collisions.contains(record["effective_trigger"].as_str().unwrap_or("")) && matches!(record["content"]["type"].as_str(),Some("template")|Some("rich_text"))) {
				for asset in record["content"]["assets"].as_array().into_iter().flatten(){let exists:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",[asset.as_str().unwrap_or("")],|row|row.get(0))?;ensure!(exists,"Rich text image is not available locally");}
				snapshot.identify(record["effective_trigger"].as_str().unwrap_or_default(), typerelay_core::Identity { id: record["id"].as_str().context("Missing ID")?.into(), library: library["_id"].as_str().unwrap().into(), revision: record["revision"].as_i64().context("Missing revision")? });
			}
        }
        Ok(snapshot)
    }
    fn validate_transaction(&self) -> Result<()> {
        let mut entries = Vec::new();
        for library in self.libraries()?.iter().filter(|row|row["state"]=="active") { entries.extend(Self::entries(&self.records(library["_id"].as_str().unwrap())?)?); }
        Bridge::validate(&entries)?;
        self.validated_snapshot().map(|_| ())
    }
    fn personal_state(&self) -> Result<std::collections::BTreeMap<String,Value>> {
        let mut values=std::collections::BTreeMap::new();
        for row in self.meta("personal_abbreviations")?.and_then(|value|value.as_array().cloned()).unwrap_or_default() { if let Some(id)=row["snippet"].as_str() { values.insert(id.to_owned(),row); } }
        for (_,operation) in self.pending()? { if operation["kind"]=="personal" { let id=operation["snippet"].as_str().context("Missing personal snippet")?; let row=values.entry(id.into()).or_insert_with(||json!({"snippet":id,"revision":0,"conflicts":[]})); row["trigger"]=operation["body"]["trigger"].clone(); row["pending"]=json!(true); } }
        let mut statement=self.connection.prepare("SELECT key,value FROM meta WHERE key LIKE 'personal_rejected:%'")?;
        for value in statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))? { let (key,text)=value?; let rejected:Value=serde_json::from_str(&text)?; if !rejected.is_null() { let id=key.trim_start_matches("personal_rejected:"); values.entry(id.into()).or_insert_with(||json!({"snippet":id,"trigger":null,"revision":0,"conflicts":[]}))["rejected"]=rejected; } }
        Ok(values)
    }
    pub fn personal(&self, id: &str) -> Result<Value> {
        Ok(self.personal_state()?.remove(id).unwrap_or(json!({"snippet":id,"trigger":null,"revision":0,"conflicts":[]})))
    }
    pub fn personal_edit(&self, library: &str, id: &str, trigger: Option<&str>, base_revision: i64, conflict: Option<&str>) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        self.editable(library)?;
        let info = self.library(library)?;
        ensure!(info["shared"]==true && info["state"]=="active" && self.synced(library)?, "An active shared library is required");
        ensure!(self.meta("personal_capability")?==Some(json!(1)), "Sync with an updated server first");
        let record = self.records(library)?.into_iter().find(|row|row["id"]==id && row["state"]=="active").context("Snippet no longer exists")?;
        let trigger = trigger.map(|value|value.trim_start_matches([',',';'])).filter(|value|!value.is_empty());
        ensure!(trigger.is_none_or(|value|value.len()<=63 && value.bytes().all(|byte|byte.is_ascii_lowercase()||byte.is_ascii_digit()||byte==b'-')), "Use 1–63 lowercase letters, numbers or hyphens");
        let personal = self.personal(id)?;
        ensure!(personal["revision"].as_i64().unwrap_or(0)==base_revision, "Personal abbreviation changed; reopen it");
        ensure!(personal["pending"]!=true, "This abbreviation is waiting to sync");
        let effective = trigger.or(record["trigger"].as_str()).unwrap_or("");
        for other in self.libraries()?.iter().filter(|row|row["state"]=="active") { for row in self.effective_records(other["_id"].as_str().unwrap())? { ensure!(effective.is_empty() || row["state"]!="active" || row["id"]==id || row["effective_trigger"]!=effective, "Duplicate personal abbreviation"); } }
        self.queue(&json!({"kind":"personal","library":library,"snippet":id,"body":{"operation_id":Uuid::new_v4().to_string(),"trigger":trigger,"base_revision":base_revision,"conflict":conflict}}))?;
        self.set_meta(&format!("personal_rejected:{id}"), &Value::Null)?;
        transaction.commit()?;
        Ok(())
    }
    pub fn effective_records(&self, library: &str) -> Result<Vec<Value>> {
        let info = self.library(library)?;
        let mut records = self.records(library)?;
        let mut overrides=if info["shared"]==true && self.synced(library)? { self.personal_state()? } else { Default::default() };
        for record in &mut records {
            let personal = overrides.remove(record["id"].as_str().unwrap_or("")).unwrap_or(json!({"trigger":null,"revision":0,"conflicts":[]}));
            record["effective_trigger"] = personal.get("trigger").filter(|value|!value.is_null()).unwrap_or(&record["trigger"]).clone();
            record["personal"] = personal;
        }
        Ok(records)
    }
    pub fn abbreviation_collisions(&self) -> Result<std::collections::BTreeSet<String>> {
        let mut counts = std::collections::BTreeMap::new();
        for library in self.libraries()?.iter().filter(|row|row["state"]=="active") { for record in self.effective_records(library["_id"].as_str().unwrap())?.iter().filter(|row|row["state"]=="active") { if let Some(trigger)=record["effective_trigger"].as_str().filter(|value|!value.is_empty()) { *counts.entry(trigger.to_owned()).or_insert(0)+=1; } } }
        Ok(counts.into_iter().filter(|(_,count)|*count>1).map(|(trigger,_)|trigger).collect())
    }
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
	pub fn pending_merges(&self)->Result<std::collections::BTreeSet<String>>{Ok(self.pending()?.into_iter().filter(|(_,operation)|matches!(operation["kind"].as_str(),Some("merge_local"|"merge_synced"))).filter_map(|(_,operation)|operation["source"].as_str().map(str::to_owned)).collect())}
	pub fn pending_merge(&self,id:&str)->Result<bool>{Ok(self.pending_merges()?.contains(id))}
    pub fn editable(&self, id: &str) -> Result<()> { ensure!(!self.pending_merge(id)?,"Library merge is pending");ensure!(self.library(id)?["permissions"]["edit"] == true, "Library is read-only"); Ok(()) }
    pub fn queue(&self, operation: &Value) -> Result<()> { self.connection.execute("INSERT INTO outbox(operation) VALUES(?1)", [operation.to_string()])?; Ok(()) }
    pub fn pending(&self) -> Result<Vec<(i64, Value)>> {
        let mut statement = self.connection.prepare("SELECT seq,operation FROM outbox ORDER BY seq")?;
        statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?.map(|row| { let (seq, text) = row?; Ok((seq, serde_json::from_str(&text)?)) }).collect()
    }
	pub fn put_asset(&self,metadata:&Value,data:&[u8],uploaded:bool)->Result<()> {let id=metadata["id"].as_str().context("Missing asset ID")?;ensure!(id.len()==64&&id.bytes().all(|byte|byte.is_ascii_hexdigit()),"Invalid asset ID");ensure!(data.len()<=2*1048576,"Asset exceeds 2 MiB");self.connection.execute("INSERT INTO assets(id,mime_type,size,width,height,animated,source_urls,data,uploaded,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET mime_type=excluded.mime_type,size=excluded.size,width=excluded.width,height=excluded.height,animated=excluded.animated,source_urls=excluded.source_urls,data=excluded.data,uploaded=MAX(assets.uploaded,excluded.uploaded)",params![id,metadata["mime_type"].as_str().context("Missing asset MIME")?,data.len() as i64,metadata["width"].as_i64().unwrap_or(0),metadata["height"].as_i64().unwrap_or(0),metadata["animated"].as_bool().unwrap_or(false),metadata["source_urls"].to_string(),data,uploaded,Utc::now().timestamp()])?;Ok(())}
	pub fn asset(&self,id:&str)->Result<Option<(Value,Vec<u8>)>> {self.connection.query_row("SELECT mime_type,size,width,height,animated,source_urls,data,uploaded FROM assets WHERE id=?1",[id],|row|{let sources:String=row.get(5)?;Ok((json!({"id":id,"mime_type":row.get::<_,String>(0)?,"size":row.get::<_,i64>(1)?,"width":row.get::<_,i64>(2)?,"height":row.get::<_,i64>(3)?,"animated":row.get::<_,bool>(4)?,"source_urls":serde_json::from_str::<Value>(&sources).unwrap_or(json!([])),"uploaded":row.get::<_,bool>(7)?}),row.get(6)?))}).optional().map_err(Into::into)}
	pub fn pending_assets(&self)->Result<Vec<(Value,Vec<u8>)>> {let mut statement=self.connection.prepare("SELECT id FROM assets WHERE uploaded=0 ORDER BY id")?;let ids=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;ids.into_iter().map(|id|self.asset(&id)?.context("Asset disappeared")).collect()}
	pub fn mark_asset_uploaded(&self,id:&str)->Result<()> {self.connection.execute("UPDATE assets SET uploaded=1 WHERE id=?1",[id])?;Ok(())}
    pub fn edit(&self, file: &OpenFile, index: Option<usize>, entry: Option<Match>) -> Result<OpenFile> {
        let transaction = if self.connection.is_autocommit() { Some(self.connection.unchecked_transaction()?) } else { None };
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
        if let Some(transaction) = transaction { transaction.commit()?; }
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
	pub fn merge_destinations(&self,source:&str)->Result<Vec<Value>>{let library=self.library(source)?;ensure!(library["state"]=="active","Source library is unavailable");ensure!(library["permissions"]["manage"]==true,"Manage permission required to merge this library");let merging=self.pending_merges()?;ensure!(!merging.contains(source),"Library merge is pending");let synced=self.synced(source)?;let rows=self.libraries()?.into_iter().filter(|destination|{let id=destination["_id"].as_str().unwrap_or("");id!=source&&destination["state"]=="active"&&destination["permissions"]["edit"]==true&&!merging.contains(id)&&!(synced&&!self.synced(id).unwrap_or(false))}).collect();Ok(rows)}
	pub fn merge(&self,source:&str,destination:&str)->Result<bool>{let transaction=self.connection.unchecked_transaction()?;ensure!(source!=destination,"Choose another library");let mut source_library=self.library(source)?;let destination_library=self.library(destination)?;ensure!(source_library["state"]=="active"&&destination_library["state"]=="active","Library is unavailable");ensure!(source_library["permissions"]["manage"]==true,"Manage permission required to merge this library");ensure!(destination_library["permissions"]["edit"]==true,"Destination library is read-only");ensure!(!self.pending_merge(source)?&&!self.pending_merge(destination)?,"A library merge is already pending");let records:Vec<Value>=self.records(source)?.into_iter().filter(|record|record["state"]=="active").collect();ensure!(!records.is_empty(),"Source library has no active snippets");ensure!(records.len()<=10000,"Library merge exceeds 10,000 snippets");let source_synced=self.synced(source)?;let destination_synced=self.synced(destination)?;ensure!(!source_synced||destination_synced,"Upload the destination before merging a synced library into it");let queued=source_synced||destination_synced;if !queued{let items=records.iter().map(|record|json!({"id":record["id"],"base_revision":record["revision"]})).collect::<Vec<_>>();self.batch_inner(source,Some(destination),&items,false)?;source_library=self.library(source)?;Self::mark_trash(&mut source_library,true);source_library["revision"]=json!(source_library["revision"].as_i64().unwrap_or(0)+1);self.connection.execute("UPDATE libraries SET data=?2,version=version+1 WHERE id=?1",params![source,source_library.to_string()])?;}else if !source_synced{let changes=records.iter().map(|record|json!({"id":record["id"],"base_revision":Value::Null,"base":Value::Null,"value":Self::sync_value(record)})).collect::<Vec<_>>();self.queue(&json!({"kind":"merge_local","library":destination,"source":source,"records":records,"body":{"operation_id":Uuid::new_v4().to_string(),"base_revision":destination_library["revision"],"changes":changes}}))?;}else{let items=records.iter().map(|record|json!({"id":record["id"],"base_revision":record["revision"]})).collect::<Vec<_>>();self.queue(&json!({"kind":"merge_synced","library":source,"source":source,"destination":destination,"records":records,"move_body":{"operation_id":Uuid::new_v4().to_string(),"action":"move","source_library":source,"destination_library":destination,"items":items},"trash_operation_id":Uuid::new_v4().to_string()}))?;}self.set_meta("last_failure",&json!(""))?;self.validate_transaction()?;transaction.commit()?;Ok(queued)}
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
                if !Self::expired(&library) && can_manage { result.push(json!({"type":"library","id":id,"library":id,"name":library["name"],"revision":library["revision"],"can_restore":true,"can_purge":can_manage,"expires_at":library["expires_at"]})); }
                continue;
            }
            if library["state"] != "active" || library["permissions"]["edit"] != true { continue; }
            for record in self.records(id)? {
                if record["state"] == "trashed" && !Self::expired(&record) { result.push(json!({"type":"snippet","id":record["id"],"library":id,"name":record["title"].as_str().filter(|v|!v.is_empty()).or(record["trigger"].as_str()).unwrap_or("Untitled snippet"),"library_name":library["name"],"revision":record["revision"],"can_restore":true,"can_purge":can_manage,"expires_at":record["expires_at"]})); }
            }
        }
        Ok(result)
    }
    fn scrub(&self, library: &str, snippet: Option<&str>) -> Result<()> {
        for mut record in self.records(library)? {
            if snippet.is_some_and(|id| record["id"] != id) { continue; }
            let id=record["id"].as_str().unwrap_or("");
            let mut personal=self.meta("personal_abbreviations")?.unwrap_or(json!([]));
            if let Some(rows)=personal.as_array_mut() { rows.retain(|row|row["snippet"]!=id); }
            self.set_meta("personal_abbreviations", &personal)?;
            self.connection.execute("DELETE FROM meta WHERE key=?1", [format!("personal_rejected:{id}")])?;
            for (seq, operation) in self.pending()? { if operation["kind"]=="personal" && operation["snippet"]==id { self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?; } }
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
		ensure!(!self.pending_merge(id)?,"Library merge is pending");
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
		let cutoff=(Utc::now()-Duration::days(30)).timestamp();self.connection.execute("DELETE FROM assets WHERE created_at<=?1 AND NOT EXISTS(SELECT 1 FROM snippet_assets WHERE asset=assets.id) AND NOT EXISTS(SELECT 1 FROM base_snippets WHERE data LIKE '%'||assets.id||'%') AND NOT EXISTS(SELECT 1 FROM outbox WHERE operation LIKE '%'||assets.id||'%') AND NOT EXISTS(SELECT 1 FROM recovery WHERE data LIKE '%'||assets.id||'%')",[cutoff])?;
        transaction.commit()?;
        Ok(())
    }
	pub fn export(&self,name:&str,destination:&Path)->Result<()> {let file=self.editor(name)?;if destination.to_string_lossy().ends_with(".typerelay.zip"){let output=fs::File::create(destination)?;let mut zip=zip::ZipWriter::new(output);let options=zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);zip.start_file("bundle.json",options)?;let assets:[String;0]=[];let ids:std::collections::BTreeSet<String>=file.entries.iter().flat_map(|entry|entry.value()["content"]["assets"].as_array().cloned().unwrap_or_default()).filter_map(|id|id.as_str().map(str::to_owned)).collect();zip.write_all(serde_json::to_string(&json!({"version":1,"name":name,"assets":if ids.is_empty(){assets.to_vec()}else{ids.iter().cloned().collect()}}))?.as_bytes())?;zip.start_file("snippets.yml",options)?;zip.write_all(Bridge::export(&file.entries)?.as_bytes())?;for id in ids{let(metadata,bytes)=self.asset(&id)?.context("Bundle asset is missing")?;zip.start_file(format!("metadata/{id}.json"),options)?;zip.write_all(metadata.to_string().as_bytes())?;zip.start_file(format!("assets/{id}"),options)?;zip.write_all(&bytes)?;}zip.finish()?;Ok(())}else{Paths::atomic_write(destination,Bridge::export(&file.entries)?.as_bytes(),true)}}
	pub fn import_bundle(&self,name:&str,source:&Path)->Result<OpenFile>{let file=fs::File::open(source)?;let mut archive=zip::ZipArchive::new(file)?;ensure!(archive.len()<=1000,"Bundle has too many files");let mut manifest=String::new();archive.by_name("snippets.yml")?.take(1048577).read_to_string(&mut manifest)?;ensure!(manifest.len()<=1048576,"Bundle manifest exceeds 1 MiB");let document:Document=serde_saphyr::from_str(&manifest)?;Bridge::validate(&document.matches)?;let ids:std::collections::BTreeSet<String>=document.matches.iter().flat_map(|entry|entry.value()["content"]["assets"].as_array().cloned().unwrap_or_default()).filter_map(|id|id.as_str().map(str::to_owned)).collect();for id in ids{let mut bytes=Vec::new();archive.by_name(&format!("assets/{id}"))?.take(2*1048576+1).read_to_end(&mut bytes)?;ensure!(bytes.len()<=2*1048576,"Bundle asset exceeds 2 MiB");let mut metadata=crate::assets::Assets::accept(self,&bytes,&id,false)?;if let Ok(file)=archive.by_name(&format!("metadata/{id}.json")){let mut value=String::new();file.take(65537).read_to_string(&mut value)?;if let Ok(saved)=serde_json::from_str::<Value>(&value){metadata["source_urls"]=saved["source_urls"].clone();self.put_asset(&metadata,&bytes,false)?;}}}self.import(name,&manifest)}
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
		ensure!(!self.pending_merge(&file.id)?,"Library merge is pending");
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
        if operation["kind"]=="personal" { self.set_meta(&format!("personal_rejected:{}", operation["snippet"].as_str().unwrap_or("")), &operation["body"])?; return Ok(()); }
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
			for field in ["source","destination"]{if operation[field]==old{operation[field]=json!(new);}}
			for parent in ["body","move_body","trash_body"]{for field in ["source_library","destination_library"]{if operation[parent][field]==old{operation[parent][field]=json!(new);}}if operation[parent]["target"]["library"]==old{operation[parent]["target"]["library"]=json!(new);if operation[parent]["target"]["type"]=="library"{operation[parent]["target"]["id"]=json!(new);}}}
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
			if matches!(operation["kind"].as_str(),Some("merge_local"|"merge_synced"|"personal")){continue;}
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
		let mut merged_source=None;
        if let Some(rows)=response["personal_abbreviations"].as_array() {
            let mut stored=self.meta("personal_abbreviations")?.and_then(|value|value.as_array().cloned()).unwrap_or_default();
            for row in rows { let purged:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM snippets WHERE id=?1 AND json_extract(data,'$.state')='purged')",[row["snippet"].as_str().unwrap_or("")],|row|row.get(0))?; if purged { continue; } if let Some(old)=stored.iter_mut().find(|old|old["snippet"]==row["snippet"]) { if old["revision"].as_i64().unwrap_or(0)<=row["revision"].as_i64().unwrap_or(0) { *old=row.clone(); } } else { stored.push(row.clone()); } }
            self.set_meta("personal_abbreviations", &json!(stored))?;
        }
        if response["capabilities"]["personal_abbreviations"]==1 { self.set_meta("personal_capability", &json!(1))?; }
        if let Some((seq, operation)) = ack {
            if response["conflicts"].as_array().is_some_and(|rows| !rows.is_empty())
                && let Some(changes) = operation["body"]["changes"].as_array() { for change in changes { self.recover(operation["library"].as_str().unwrap_or(""), change["id"].as_str(), &change["value"])?; } }
            if operation["kind"] == "create" { self.remap(operation["library"].as_str().unwrap(), response["library"]["_id"].as_str().context("Missing created library")?)?; }
			if operation["kind"]=="merge_local"&&!response["conflicts"].as_array().is_some_and(|rows|!rows.is_empty()){merged_source=operation["source"].as_str().map(str::to_owned);}
            self.connection.execute("DELETE FROM outbox WHERE seq=?1", [seq])?;
        }
        if let Some(remote) = response.get("library") { self.accept_library(remote)?; }
        if let Some(remotes) = response["libraries"].as_array() { for remote in remotes { self.accept_library(remote)?; } }
		if let Some(source)=merged_source{self.finish_local_merge(&source)?;}
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
        self.validated_snapshot()?;
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
        self.validated_snapshot()?;
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
    #[test]
    fn personal_abbreviations_are_offline_overlays_with_independent_revisions() {
        let fixture=Fixture::new(); let db=fixture.db();
        let file=db.import("Shared", "matches: [{trigger: tw, replace: Shared}, {trigger: other, replace: Other}]").unwrap();
        let mut library=db.library(&file.id).unwrap(); library["shared"]=json!(true); library["records"]=json!(db.records(&file.id).unwrap());
        db.apply(&json!({"libraries":[library],"capabilities":{"personal_abbreviations":1},"personal_abbreviations":[]}),None).unwrap();
        let id=&file.ids[0]; let original=db.records(&file.id).unwrap();
        let mut live=DatabaseSnapshot::open(&fixture.directory).unwrap();
        db.personal_edit(&file.id,id,Some(";mine"),0,None).unwrap();
        assert!(live.reload().unwrap().is_some());
        assert_eq!(db.records(&file.id).unwrap(),original);
        assert_eq!(db.editor("Shared").unwrap().entries[0].trigger,"tw");
        let reopened=fixture.db(); assert_eq!(reopened.personal(id).unwrap()["pending"],true);
        let mut engine=typerelay_core::Engine::new(reopened.snapshot().unwrap());
        for c in ";mine".chars() { engine.feed(typerelay_core::Input::Character(c)); }
        assert_eq!(engine.feed(typerelay_core::Input::Space).unwrap().text,"Shared");
        for c in ";tw".chars() { engine.feed(typerelay_core::Input::Character(c)); }
        assert!(engine.feed(typerelay_core::Input::Space).is_none());
        let (seq,operation)=db.pending().unwrap().remove(0);
        db.apply(&json!({"personal_abbreviations":[{"snippet":id,"trigger":"mine","revision":1,"conflicts":[]}]}),Some((seq,&operation))).unwrap();
        assert!(db.pending().unwrap().is_empty());
        db.apply(&json!({"personal_abbreviations":[{"snippet":id,"trigger":"stale","revision":0,"conflicts":[]}]}),None).unwrap();
        assert_eq!(db.personal(id).unwrap()["trigger"],"mine");
        assert!(db.personal_edit(&file.id,id,Some("other"),1,None).is_err());
        db.personal_edit(&file.id,id,None,1,None).unwrap();
        assert_eq!(db.effective_records(&file.id).unwrap()[0]["effective_trigger"],"tw");
    }
    #[test]
    fn personal_collision_preserves_search_and_content_and_suspends_only_automatic_matching() {
        let fixture=Fixture::new(); let db=fixture.db();
        let file=db.import("Shared", "matches: [{trigger: tw, replace: Shared}, {trigger: other, replace: Other}]").unwrap();
        let mut library=db.library(&file.id).unwrap(); library["shared"]=json!(true); library["records"]=json!(db.records(&file.id).unwrap());
        let id=&file.ids[0];
        db.apply(&json!({"libraries":[library],"personal_abbreviations":[{"snippet":id,"trigger":"other","revision":1,"conflicts":[]}]}),None).unwrap();
        assert!(db.snapshot().unwrap().is_empty());
        assert_eq!(crate::panel::Panel::search(&fixture.directory,"other").unwrap().len(),2);
        assert_eq!(db.records(&file.id).unwrap()[0]["content"]["text"],"Shared");
        library["permissions"]["edit"]=json!(false);
        db.apply(&json!({"libraries":[library]}),None).unwrap();
        assert_eq!(db.effective_records(&file.id).unwrap()[0]["effective_trigger"],"other");
        assert!(db.personal_edit(&file.id,id,None,1,None).is_err());
        library["shared"]=json!(false);
        db.apply(&json!({"libraries":[library]}),None).unwrap();
        assert_eq!(db.snapshot().unwrap().len(),2);
        assert_eq!(db.effective_records(&file.id).unwrap()[0]["effective_trigger"],"tw");
        library["shared"]=json!(true);
        db.apply(&json!({"libraries":[library]}),None).unwrap();
        assert!(db.snapshot().unwrap().is_empty());
        db.apply(&json!({"tombstones":[{"library":file.id,"id":id,"revision":2}]}),None).unwrap();
        assert_eq!(db.personal(id).unwrap()["revision"],0);
        assert_eq!(db.snapshot().unwrap().len(),1);
    }
    #[test]
    fn shared_download_collisions_do_not_block_sync_and_an_override_can_disambiguate() {
        let fixture=Fixture::new(); let db=fixture.db();
        let library=|id:&str,name:&str|json!({"_id":id,"name":name,"shared":true,"state":"active","revision":1,"permissions":{"read":true,"edit":true},"records":[{"id":format!("{id}-snippet"),"trigger":"same","title":name,"content":{"version":1,"type":"plain_text","text":name},"revision":1,"state":"active","position":0}]});
        db.apply(&json!({"libraries":[library("first","First"),library("second","Second")],"capabilities":{"personal_abbreviations":1},"personal_abbreviations":[]}),None).unwrap();
        assert!(db.snapshot().unwrap().is_empty());
        assert_eq!(crate::panel::Panel::search(&fixture.directory,"same").unwrap().len(),2);
        db.personal_edit("first","first-snippet",Some("mine"),0,None).unwrap();
        assert_eq!(db.snapshot().unwrap().len(),2);
        assert_eq!(db.records("first").unwrap()[0]["trigger"],"same");
    }
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
	fn detached_reconnect_backs_up_and_overlays_local_edits_on_new_server_base() {
		let fixture=Fixture::new();let db=fixture.db();let id="0123456789abcdef01234567";
		let original=json!({"_id":id,"name":"Mine","revision":3,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-0000000001","trigger":"one","title":"","content":{"version":1,"type":"plain_text","text":"One"},"revision":1,"state":"active","position":0},{"id":"snippet-0000000002","trigger":"two","title":"","content":{"version":1,"type":"plain_text","text":"Two"},"revision":1,"state":"active","position":1}]});
		db.apply(&json!({"libraries":[original],"accessible":[id]}),None).unwrap();db.connection.execute("UPDATE libraries SET synced=0 WHERE id=?1",[id]).unwrap();db.set_meta("detached",&json!({"server":"https://app.example.test","account":"account-one","libraries":[id]})).unwrap();
		let file=db.editor("Mine").unwrap();db.edit(&file,Some(0),Some(Fixture::entry("one","Local one"))).unwrap();assert!(db.pending().unwrap().is_empty());
		let remote=json!({"_id":id,"name":"Mine","revision":4,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-0000000001","trigger":"one","title":"","content":{"version":1,"type":"plain_text","text":"One"},"revision":1,"state":"active","position":0},{"id":"snippet-0000000002","trigger":"two","title":"","content":{"version":1,"type":"plain_text","text":"Server two"},"revision":2,"state":"active","position":1}]});let response=json!({"libraries":[remote],"accessible":[id],"cursor":4});
		db.reconcile_detached(&response,"https://app.example.test",Some("account-one")).unwrap();assert_eq!(db.pending().unwrap().len(),1);let backup=PathBuf::from(db.meta("last_reconnect_backup").unwrap().unwrap().as_str().unwrap());assert!(backup.join("typerelay.sqlite").is_file());
		db.apply(&response,None).unwrap();let entries=db.editor("Mine").unwrap().entries;assert_eq!(entries[0].replace,"Local one");assert_eq!(entries[1].replace,"Server two");
	}
	#[test]
	fn detached_library_from_another_account_is_preserved_as_independent_local_data() {
		let fixture=Fixture::new();let db=fixture.db();let id="0123456789abcdef01234567";let original=json!({"_id":id,"name":"Mine","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-0000000001","trigger":"one","title":"","content":{"version":1,"type":"plain_text","text":"Local"},"revision":1,"state":"active","position":0}]});db.apply(&json!({"libraries":[original],"accessible":[id]}),None).unwrap();db.connection.execute("UPDATE libraries SET synced=0 WHERE id=?1",[id]).unwrap();db.set_meta("detached",&json!({"server":"https://app.example.test","account":"old-account","libraries":[id]})).unwrap();let remote=json!({"_id":id,"name":"Mine","revision":2,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-0000000002","trigger":"two","title":"","content":{"version":1,"type":"plain_text","text":"Remote"},"revision":1,"state":"active","position":0}]});let response=json!({"libraries":[remote],"accessible":[id]});db.reconcile_detached(&response,"https://app.example.test",Some("new-account")).unwrap();db.apply(&response,None).unwrap();let libraries=db.libraries().unwrap();assert_eq!(libraries.len(),2);assert_eq!(db.snapshot().unwrap().len(),2);assert_eq!(libraries.iter().filter(|library|db.synced(library["_id"].as_str().unwrap()).unwrap()).count(),1);
	}
	#[test]
	fn detached_reconnect_replays_a_local_move_as_one_revisioned_batch() {
		let fixture=Fixture::new();let db=fixture.db();let source="0123456789abcdef01234567";let destination="1123456789abcdef01234567";let record=json!({"id":"snippet-0000000001","trigger":"one","title":"","content":{"version":1,"type":"plain_text","text":"One"},"revision":1,"state":"active","position":0});let source_remote=json!({"_id":source,"name":"Source","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[record]});let destination_remote=json!({"_id":destination,"name":"Destination","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[]});db.apply(&json!({"libraries":[source_remote,destination_remote],"accessible":[source,destination]}),None).unwrap();db.connection.execute("UPDATE libraries SET synced=0",[]).unwrap();db.set_meta("detached",&json!({"server":"https://app.example.test","account":"account-one","libraries":[source,destination]})).unwrap();let file=db.editor("Source").unwrap();let items=db.batch_items(&file,&file.ids).unwrap();db.batch(source,Some(destination),&items).unwrap();let response=json!({"libraries":[source_remote,destination_remote],"accessible":[source,destination]});db.reconcile_detached(&response,"https://app.example.test",Some("account-one")).unwrap();let pending=db.pending().unwrap();assert_eq!(pending.len(),1);assert_eq!(pending[0].1["kind"],"batch");assert_eq!(pending[0].1["body"]["destination_library"],destination);db.apply(&response,None).unwrap();assert!(db.editor("Source").unwrap().entries.is_empty());assert_eq!(db.editor("Destination").unwrap().entries[0].trigger,"one");
	}
	#[test]
	fn local_library_merge_moves_ordered_records_and_trashes_source() {
		let fixture=Fixture::new();let db=fixture.db();let destination=db.import("Destination","matches: [{trigger: first, replace: First}]").unwrap();let source=db.import("Recovered","matches: [{trigger: second, replace: Second}, {trigger: third, replace: Third}]").unwrap();assert!(!db.merge(&source.id,&destination.id).unwrap());let merged=db.editor("Destination").unwrap();assert_eq!(merged.entries.iter().map(|entry|entry.trigger.as_str()).collect::<Vec<_>>(),vec!["first","second","third"]);assert_eq!(db.library(&source.id).unwrap()["state"],"trashed");assert!(db.pending().unwrap().is_empty());assert!(db.trash().unwrap().iter().any(|row|row["id"]==source.id));
	}
	#[test]
	fn local_to_synced_merge_waits_for_ack_then_trashes_source() {
		let fixture=Fixture::new();let db=fixture.db();let destination="0123456789abcdef01234567";let remote=json!({"_id":destination,"name":"Synced","revision":2,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-0000000001","trigger":"first","title":"","content":{"version":1,"type":"plain_text","text":"First"},"revision":1,"state":"active","position":0}]});db.apply(&json!({"libraries":[remote],"accessible":[destination]}),None).unwrap();let source=db.import("Recovered","matches: [{trigger: second, replace: Second}]").unwrap();assert!(db.merge(&source.id,destination).unwrap());assert_eq!(db.library(&source.id).unwrap()["state"],"active");assert_eq!(db.pending().unwrap()[0].1["kind"],"merge_local");assert!(db.editable(&source.id).is_err());assert!(db.enroll("Recovered").is_err());let (seq,operation)=db.pending().unwrap().remove(0);let mut accepted=remote.clone();accepted["revision"]=json!(3);let mut records=accepted["records"].as_array().unwrap().clone();let mut moved=db.records(&source.id).unwrap()[0].clone();moved["revision"]=json!(1);moved["position"]=json!(1);records.push(moved);accepted["records"]=json!(records);db.apply(&json!({"library":accepted,"conflicts":[]}),Some((seq,&operation))).unwrap();assert_eq!(db.library(&source.id).unwrap()["state"],"trashed");assert_eq!(db.editor("Synced").unwrap().entries.len(),2);assert!(db.pending().unwrap().is_empty());
	}
	#[test]
	fn enrollment_id_remap_updates_every_queued_merge_reference() {
		let fixture=Fixture::new();let db=fixture.db();let destination="0123456789abcdef01234567";db.apply(&json!({"libraries":[{"_id":destination,"name":"Destination","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[]}],"accessible":[destination]}),None).unwrap();let source=db.import("Source","matches: [{trigger: source, replace: Source}]").unwrap();db.enroll("Source").unwrap();assert!(db.merge(&source.id,destination).unwrap());let replacement="2123456789abcdef01234567";db.remap(&source.id,replacement).unwrap();let operation=&db.pending().unwrap()[1].1;assert_eq!(operation["library"],replacement);assert_eq!(operation["source"],replacement);assert_eq!(operation["move_body"]["source_library"],replacement);assert_eq!(operation["move_body"]["destination_library"],destination);
	}
	#[test]
	fn synced_merge_queues_stable_move_and_blocks_synced_to_local() {
		let fixture=Fixture::new();let db=fixture.db();let source="0123456789abcdef01234567";let destination="1123456789abcdef01234567";let library=|id:&str,name:&str,trigger:&str|json!({"_id":id,"name":name,"revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":format!("snippet-{trigger}-000000"),"trigger":trigger,"title":"","content":{"version":1,"type":"plain_text","text":trigger},"revision":1,"state":"active","position":0}]});db.apply(&json!({"libraries":[library(source,"Source","source"),library(destination,"Destination","destination")],"accessible":[source,destination]}),None).unwrap();let local=db.import("Local","matches: [{trigger: local, replace: Local}]").unwrap();assert!(db.merge(source,&local.id).is_err());assert!(db.merge(source,destination).unwrap());let operation=&db.pending().unwrap()[0].1;assert_eq!(operation["kind"],"merge_synced");assert!(operation["move_body"]["operation_id"].as_str().is_some());assert!(operation["trash_operation_id"].as_str().is_some());assert!(db.editable(source).is_err());assert!(db.merge_destinations(source).is_err());
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
	#[test]
	fn rich_text_assets_and_bundle_round_trip_without_inline_binary(){let source=tempfile::tempdir().unwrap();let db=Database::open(source.path()).unwrap();let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();use base64::Engine as _;let id=format!("{:x}",sha2::Sha256::digest(&png));use sha2::Digest as _;let metadata=json!({"id":id.clone(),"mime_type":"image/png","size":png.len(),"width":1,"height":1,"animated":false,"source_urls":[]});db.put_asset(&metadata,&png,false).unwrap();let file=db.create("Rich").unwrap();let markdown=format!("# Hello\n\n<img src=\"typerelay-asset:{id}\" alt=\"dot\">");let entry=Match{trigger:"rich".into(),replace:markdown.clone(),kind:"rich_text".into(),..Default::default()};db.edit(&file,None,Some(entry)).unwrap();let bundle=source.path().join("rich.typerelay.zip");db.export("Rich",&bundle).unwrap();let destination=tempfile::tempdir().unwrap();let target=Database::open(destination.path()).unwrap();let imported=target.import_bundle("Imported",&bundle).unwrap();assert_eq!(imported.entries[0].replace,markdown);assert!(target.asset(&id).unwrap().is_some());assert!(std::fs::metadata(bundle).unwrap().len()<100_000);}

}
