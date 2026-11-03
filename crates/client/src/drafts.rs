use crate::{config::Match, database::Database, editor::OpenFile};
use anyhow::{Context, Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Draft {
    pub id: String,
    pub file: OpenFile,
    pub entry: Match,
    pub origin_library: String,
    pub origin_snippet: Option<String>,
    pub destination: Option<String>,
    pub conflict: Option<String>,
    pub updated_at: String,
}
impl Draft {
    pub fn new(file: &OpenFile, index: Option<usize>, entry: Match, destination: Option<String>) -> Self {
        let mut file = file.clone();
        file.entries = index.map(|i| vec![file.entries[i].clone()]).unwrap_or_default();
        file.ids = index.map(|i| vec![file.ids[i].clone()]).unwrap_or_default();
        file.revisions = index.map(|i| vec![file.revisions[i]]).unwrap_or_default();
        Self { id: uuid::Uuid::new_v4().to_string(), origin_library:file.id.clone(), origin_snippet:file.ids.first().cloned(), file, entry, destination, conflict: None, updated_at: chrono::Utc::now().to_rfc3339() }
    }
    pub fn available(directory: &Path, drafts: Vec<Self>) -> Result<Vec<Self>> {
        let mut available=Vec::new();
        for draft in drafts { match Self::claim(directory,&draft.id) { Ok(_lock)=>available.push(draft), Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error|error.kind()==std::io::ErrorKind::WouldBlock)=>(), Err(error)=>return Err(error) } }
        Ok(available)
    }
    pub fn identity(root: &Path) -> Result<Value> {
        let path = root.join("sync/credentials.json");
        let bytes = match fs::read(path) { Ok(bytes)=>bytes, Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(Value::Null), Err(error)=>return Err(error.into()) };
        let credentials: Value = serde_json::from_slice(&bytes)?;
        Ok(json!({"server":credentials["server"],"account":credentials.get("account").filter(|value|!value.is_null()).unwrap_or(&credentials["device"])}))
    }
    pub fn claim(directory: &Path, id: &str) -> Result<fs::File> {
        uuid::Uuid::parse_str(id)?;
        let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(directory.join(format!(".draft-{id}.lock")))?;
        fs2::FileExt::try_lock_exclusive(&lock).context("Draft is open in another terminal; finish there or quit with drafts preserved")?;
        Ok(lock)
    }
}
impl Database {
    pub fn drafts(&self, identity: &Value) -> Result<Vec<Draft>> {
        let mut statement = self.connection.prepare("SELECT data FROM tui_drafts WHERE identity=?1 ORDER BY json_extract(data,'$.updated_at'),id")?;
        statement.query_map([identity.to_string()], |row|row.get::<_,String>(0))?.map(|text|Ok(serde_json::from_str(&text?)?)).collect()
    }
    pub fn put_draft(&self, identity: &Value, draft: &Draft, previous: Option<&Draft>) -> Result<()> {
        let transaction = rusqlite::Transaction::new_unchecked(&self.connection,rusqlite::TransactionBehavior::Immediate)?;
        let purged:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND json_extract(data,'$.state') IN ('purged','purge_pending')) OR EXISTS(SELECT 1 FROM snippets WHERE id=?2 AND json_extract(data,'$.state') IN ('purged','purge_pending'))",params![draft.origin_library,draft.origin_snippet],|row|row.get(0))?;
        ensure!(!purged,"Original content was permanently removed; draft cannot be retained");
        let library = self.library(&draft.file.id)?;
        ensure!(library["state"]!="purged" && library["state"]!="purge_pending", "Library permanently removed; draft cannot be retained");
        if let Some(id) = draft.file.ids.first() {
            ensure!(!self.records(&draft.file.id)?.iter().any(|row|row["id"]==*id && matches!(row["state"].as_str(),Some("purged"|"purge_pending"))), "Snippet permanently removed; draft cannot be retained");
        }
        let data = serde_json::to_string(draft)?;
        if let Some(previous) = previous {
            ensure!(self.connection.execute("UPDATE tui_drafts SET data=?3 WHERE id=?1 AND identity=?2 AND data=?4", params![draft.id,identity.to_string(),data,serde_json::to_string(previous)?])?==1, "Draft changed or was removed; current text was not saved");
        } else { self.connection.execute("INSERT INTO tui_drafts(id,identity,data) VALUES(?1,?2,?3)",params![draft.id,identity.to_string(),data])?; }
        transaction.commit()?;
        Ok(())
    }
    pub fn discard_draft(&self, identity: &Value, draft: &Draft) -> Result<()> {
        ensure!(self.connection.execute("DELETE FROM tui_drafts WHERE id=?1 AND identity=?2 AND data=?3",params![draft.id,identity.to_string(),serde_json::to_string(draft)?])?==1,"Draft changed or was removed; reload Drafts");
        Ok(())
    }
    pub fn save_draft(&self, identity: &Value, draft: &Draft, as_new: bool) -> Result<OpenFile> {
        ensure!(draft.conflict.is_none()||as_new,"Resolve the conflict or save this draft as new");
        let transaction = rusqlite::Transaction::new_unchecked(&self.connection,rusqlite::TransactionBehavior::Immediate)?;
        let stored: Option<String> = self.connection.query_row("SELECT data FROM tui_drafts WHERE id=?1 AND identity=?2",params![draft.id,identity.to_string()],|row|row.get(0)).optional()?;
        ensure!(stored.as_deref()==Some(serde_json::to_string(draft)?.as_str()), "Draft changed or was already saved; reload Drafts");
        let file = if as_new {
            let file = self.editor_id(draft.destination.as_deref().unwrap_or(&draft.file.id))?;
            self.edit(&file,None,Some(draft.entry.clone()))?
        } else if let Some(destination)=&draft.destination {
            if draft.file.ids.is_empty() { self.edit(&self.editor_id(destination)?,None,Some(draft.entry.clone()))? } else { self.edit_move(&draft.file,0,draft.entry.clone(),destination)? }
        } else { self.edit(&draft.file,(!draft.file.ids.is_empty()).then_some(0),Some(draft.entry.clone()))? };
        self.discard_draft(identity,draft)?;
        transaction.commit()?;
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(text:&str)->Match {Match{replace:text.into(),..Default::default()}}
    #[test]
    fn drafts_survive_reopen_are_isolated_and_claimed_per_session() {
        let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let file=db.create("Local").unwrap();
        let one=json!({"server":"https://one.invalid","account":"alice"});let two=json!({"server":"https://two.invalid","account":"alice"});
        let draft=Draft::new(&file,None,entry("First session"),None);db.put_draft(&one,&draft,None).unwrap();let second=Draft::new(&file,None,entry("Second session"),None);db.put_draft(&one,&second,None).unwrap();
        let lock=Draft::claim(root.path(),&draft.id).unwrap();assert!(Draft::claim(root.path(),&draft.id).is_err());assert_eq!(Draft::available(root.path(),db.drafts(&one).unwrap()).unwrap().len(),1);
        drop(db);let db=Database::open(root.path()).unwrap();assert_eq!(db.drafts(&one).unwrap().len(),2);assert!(db.drafts(&two).unwrap().is_empty());assert!(db.drafts(&Value::Null).unwrap().is_empty());drop(lock);assert_eq!(Draft::available(root.path(),db.drafts(&one).unwrap()).unwrap().len(),2);
    }
    #[test]
    fn local_save_and_outbox_are_atomic_and_retry_does_not_duplicate() {
        let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let file=db.create("Offline").unwrap();db.enroll("Offline").unwrap();
        let draft=Draft::new(&file,None,entry("Offline draft"),None);db.put_draft(&Value::Null,&draft,None).unwrap();
        db.connection.execute_batch("CREATE TRIGGER fail_queue BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();assert!(db.save_draft(&Value::Null,&draft,false).is_err());assert!(db.editor("Offline").unwrap().entries.is_empty());assert_eq!(db.drafts(&Value::Null).unwrap().len(),1);
        db.connection.execute_batch("DROP TRIGGER fail_queue").unwrap();db.save_draft(&Value::Null,&draft,false).unwrap();assert!(db.drafts(&Value::Null).unwrap().is_empty());assert_eq!(db.pending().unwrap().len(),2);assert!(db.save_draft(&Value::Null,&draft,false).is_err());assert_eq!(db.editor("Offline").unwrap().entries.len(),1);
    }
    #[test]
    fn stale_target_is_preserved_but_unrelated_changes_and_new_saves_work() {
        let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let file=db.import("Local","matches: [{replace: First}, {replace: Second}]").unwrap();
        let draft=Draft::new(&file,Some(0),entry("My edit"),None);db.put_draft(&Value::Null,&draft,None).unwrap();db.edit(&file,Some(1),Some(entry("Unrelated edit"))).unwrap();db.save_draft(&Value::Null,&draft,false).unwrap();assert_eq!(db.editor("Local").unwrap().entries[1].replace,"Unrelated edit");
        let file=db.editor("Local").unwrap();let draft=Draft::new(&file,Some(0),entry("Older edit"),None);db.put_draft(&Value::Null,&draft,None).unwrap();db.edit(&file,Some(0),Some(entry("Newer saved edit"))).unwrap();assert!(db.save_draft(&Value::Null,&draft,false).is_err());assert_eq!(db.drafts(&Value::Null).unwrap().len(),1);db.save_draft(&Value::Null,&draft,true).unwrap();assert_eq!(db.editor("Local").unwrap().entries[0].replace,"Newer saved edit");assert_eq!(db.editor("Local").unwrap().entries[2].replace,"Older edit");
    }
    #[test]
    fn draft_update_rejects_stale_state_and_permission_failure_keeps_it() {
        let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let file=db.create("Local").unwrap();let draft=Draft::new(&file,None,entry("Original"),None);db.put_draft(&Value::Null,&draft,None).unwrap();let mut changed=draft.clone();changed.entry=entry("Changed");db.put_draft(&Value::Null,&changed,Some(&draft)).unwrap();assert!(db.put_draft(&Value::Null,&draft,Some(&draft)).is_err());assert!(db.discard_draft(&Value::Null,&draft).is_err());
        db.connection.execute("UPDATE libraries SET data=json_set(data,'$.permissions.edit',json('false'))",[]).unwrap();assert!(db.save_draft(&Value::Null,&changed,false).is_err());assert_eq!(db.drafts(&Value::Null).unwrap()[0].entry.replace,"Changed");
    }
    #[test]
    fn draft_images_survive_cleanup_and_export_but_purge_scrubs_draft() {
        let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let file=db.import("Local","matches: [{replace: Original}]").unwrap();let id="a".repeat(64);db.put_asset(&json!({"id":id,"mime_type":"image/png","width":1,"height":1,"source_urls":[]}),b"image",false).unwrap();db.connection.execute("UPDATE assets SET created_at=0",[]).unwrap();
        let draft=Draft::new(&file,Some(0),Match{kind:"rich_text".into(),replace:format!("<img src=\"typerelay-asset:{id}\" alt=\"Kept\">"),..Default::default()},None);db.put_draft(&Value::Null,&draft,None).unwrap();db.cleanup().unwrap();assert!(db.asset(&id).unwrap().is_some());let output=root.path().join("draft.typerelay.zip");db.export_entries("Draft",std::slice::from_ref(&draft.entry),&output).unwrap();assert!(output.exists());
        db.edit(&file,Some(0),None).unwrap();db.empty(&db.trash().unwrap()).unwrap();assert!(db.drafts(&Value::Null).unwrap().is_empty());assert!(db.put_draft(&Value::Null,&draft,None).is_err());assert!(db.save_draft(&Value::Null,&draft,true).is_err());db.cleanup().unwrap();assert!(db.asset(&id).unwrap().is_none());
    }
    #[test]
    fn draft_base_and_destination_follow_library_id_remapping() {
        let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let file=db.create("Local").unwrap();let draft=Draft::new(&file,None,entry("New"),None);db.put_draft(&Value::Null,&draft,None).unwrap();db.remap(&file.id,"remote-id").unwrap();let draft=db.drafts(&Value::Null).unwrap().remove(0);assert_eq!(draft.file.id,"remote-id");assert_eq!(draft.origin_library,"remote-id");db.save_draft(&Value::Null,&draft,false).unwrap();assert_eq!(db.editor_id("remote-id").unwrap().entries.len(),1);
    }
    #[test]
    fn moved_snippet_drafts_are_scrubbed_by_snippet_or_destination_library_purge() {
        for whole_library in [false,true] {
            let root=tempfile::tempdir().unwrap();let db=Database::open(root.path()).unwrap();let source=db.import("Source","matches: [{replace: Original}]").unwrap();let destination=db.create("Destination").unwrap();let unrelated=db.import("Unrelated","matches: [{replace: Keep}]").unwrap();let draft=Draft::new(&source,Some(0),entry("Forbidden after purge"),None);db.put_draft(&Value::Null,&draft,None).unwrap();let keep=Draft::new(&unrelated,None,entry("Keep"),None);db.put_draft(&Value::Null,&keep,None).unwrap();
            for file in [&source,&unrelated] {db.recover(&file.id,Some(&file.ids[0]),&file.entries[0].value(),"Rejected edit").unwrap();db.connection.execute("INSERT INTO base_snippets(id,library,data) VALUES(?1,?2,?3)",params![file.ids[0],file.id,db.records(&file.id).unwrap()[0].to_string()]).unwrap();}db.set_meta("conflicts",&json!([{"library":source.id,"snippet":source.ids[0],"local":source.entries[0].value()},{"library":unrelated.id,"snippet":unrelated.ids[0],"local":unrelated.entries[0].value()}])).unwrap();
            db.edit_move(&source,0,source.entries[0].clone(),&destination.id).unwrap();let moved=db.editor("Destination").unwrap();
            if whole_library {let library=db.library(&destination.id).unwrap();db.trash_action(&json!({"type":"library","id":destination.id,"library":destination.id,"revision":library["revision"]}),"trash").unwrap();}
            else {db.edit(&moved,Some(0),None).unwrap();}
            db.empty(&db.trash().unwrap()).unwrap();let remaining=db.drafts(&Value::Null).unwrap();assert_eq!(remaining.len(),1);assert_eq!(remaining[0].id,keep.id);assert_eq!(db.recovery().unwrap().iter().map(|row|row["snippet"].clone()).collect::<Vec<_>>(),vec![json!(unrelated.ids[0])]);assert_eq!(db.meta("conflicts").unwrap().unwrap()[0]["snippet"],unrelated.ids[0]);assert_eq!(db.meta("conflicts").unwrap().unwrap().as_array().unwrap().len(),1);assert_eq!(db.connection.query_row("SELECT count(*) FROM base_snippets WHERE id=?1",[&source.ids[0]],|row|row.get::<_,i64>(0)).unwrap(),0);assert_eq!(db.connection.query_row("SELECT count(*) FROM base_snippets",[],|row|row.get::<_,i64>(0)).unwrap(),1);assert!(db.save_draft(&Value::Null,&draft,true).is_err());assert!(db.put_draft(&Value::Null,&draft,None).is_err());
        }
    }

}
