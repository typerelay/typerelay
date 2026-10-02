//! Device-private repetition detection. Never referenced by sync, export, or AI.
use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;
use crate::{config::Match, database::Database};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings { pub enabled: bool, pub native_capture: bool, pub notifications: bool, pub threshold: u32, pub retention_days: u32, pub excluded_apps: Vec<String> }
impl Default for Settings { fn default()->Self { Self { enabled:false, native_capture:false, notifications:false, threshold:4, retention_days:30, excluded_apps:vec![] } } }
impl Settings {
    pub fn validate(&self)->Result<()> { ensure!((2..=100).contains(&self.threshold),"Choose a repetition threshold between 2 and 100"); ensure!([7,30,90].contains(&self.retention_days),"Choose 7, 30 or 90 days"); ensure!(self.excluded_apps.len()<=200&&self.excluded_apps.iter().all(|s|!s.trim().is_empty()&&s.len()<=512),"Invalid excluded application"); Ok(()) }
    pub fn allows(&self,app:&str)->bool { self.enabled&&Self::supported_app(app)&&!self.excluded_apps.iter().any(|value|value.eq_ignore_ascii_case(app)) }
    pub fn supported_app(app:&str)->bool {
        let app=app.to_ascii_lowercase();
        !app.is_empty()&&!["typerelay-panel","typerelay-tui","com.typerelay.panel","com.apple.terminal","com.googlecode.iterm2","net.kovidgoyal.kitty","org.alacritty","com.mitchellh.ghostty","dev.warp.warp-stable","com.github.wez.wezterm","org.wezfurlong.wezterm","windowsterminal.exe","terminal.exe","wt.exe","conhost.exe","openconsole.exe","cmd.exe","powershell.exe","pwsh.exe","mintty.exe","putty.exe","wezterm-gui.exe","alacritty.exe","kitty.exe","foot","gnome-terminal-server","kgx","konsole","xterm","alacritty","kitty","ghostty","wezterm-gui","tilix","terminator"].contains(&app.as_str())
    }
}

/// Adapters must attest focus, editable/non-protected field, and bounded new input.
/// Input can come from native keys or a committed edit; never replay document values.
/// No document values or surrounding text belong in this interface.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub enum Edit { Text(String), Commit(String), Backspace, Enter, Boundary, CompositionStart, CompositionEnd, CompositionCancel, Reset }
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum CaptureSource { #[default] Keyboard, Accessibility, Ime, Bridge }
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum Protection { Protected, Unprotected, #[default] Unknown }
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CaptureContext { pub generation:u64, pub app:String, pub window:String, pub field:Option<String>, pub protection:Protection, pub active:bool, pub layout:String, pub ime:Option<String>, pub authority:CaptureSource }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureFrame { pub version:u32, pub session:String, pub source_id:String, pub sequence:u64, pub at_ms:i64, pub context:CaptureContext, pub source:CaptureSource, pub edit:Edit }
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(default,deny_unknown_fields)]
pub struct CaptureHealth { pub device:String,pub desktop:String,pub layout:String,pub ime:Option<String>,pub app:Option<String>,pub source:String,pub blocked:Option<String>,pub at_ms:i64 }
impl CaptureFrame {
    pub const VERSION:u32=1;
    pub fn valid(&self)->bool {self.version==Self::VERSION&&self.session.len()<=128&&!self.session.is_empty()&&!self.source_id.is_empty()&&self.source_id.len()<=128&&self.sequence>0&&self.context.app.len()<=512&&self.context.window.len()<=256&&self.context.field.as_ref().is_none_or(|field|field.len()<=256)&&self.context.layout.len()<=256&&self.context.ime.as_ref().is_none_or(|ime|ime.len()<=256)&&match &self.edit{Edit::Text(text)=>text.chars().count()<=16,Edit::Commit(text)=>text.chars().count()<=1000,_=>true}}
}
#[derive(Default)]
struct CaptureState { session:String, sequences:std::collections::HashMap<String,u64>, context:Option<CaptureContext>, at_ms:i64, generation:u64, composing:bool, accepted:bool }

pub struct Event { pub epoch:u64, pub field:String, pub app:String, pub safe:bool, pub direct:bool, pub edit:Edit }
#[derive(Default)]
pub struct Detector { field:String, pending:String, last_ms:i64, last_input_ms:i64, paused:bool, capture:CaptureState }
impl Detector {
    pub fn normalize(text:&str)->String { text.nfc().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ") }
    pub fn reset(&mut self) { self.field.clear();self.pending.clear();self.paused=false;self.last_ms=0; }
    pub fn event(&mut self,event:Event,settings:&Settings,epoch:u64,now_ms:i64)->Option<String> {
        if event.epoch!=epoch||!event.safe||!event.direct||!settings.allows(&event.app)||matches!(event.edit,Edit::Reset) {self.reset();return None;}
        if self.field!=event.field {self.reset();self.field=event.field;}
        self.last_ms=now_ms;
        self.last_input_ms=now_ms;
        match event.edit {
            Edit::Text(text)=>{
                if text.chars().any(|c|c.is_control()&&!c.is_whitespace())||text.chars().count()>16 {self.reset();return None;}
                // A pause is a boundary. Continued input starts a new burst; prior words are not replayed.
                if self.paused {self.pending.clear();self.paused=false;}
                self.pending.push_str(&text);
                if self.pending.chars().count()>1000 {self.reset();return None;}
                if text.chars().last().is_some_and(char::is_whitespace)&&self.pending.trim_end().ends_with(['.','!','?','。','！','？']) {return self.complete();}
            },
            Edit::Backspace=>{if self.paused {self.pending.clear();return None;}if let Some((index,_))=self.pending.grapheme_indices(true).next_back(){self.pending.truncate(index);}else{self.reset();}},
            Edit::Enter|Edit::Boundary=>{let value=self.complete();self.pending.clear();self.paused=false;return value;},
            Edit::Commit(_)|Edit::CompositionStart|Edit::CompositionEnd|Edit::CompositionCancel=>{self.reset();return None;},
            Edit::Reset=>unreachable!(),
        }
        None
    }
    pub fn capture(&mut self,frame:CaptureFrame,settings:&Settings,epoch:u64,session:&str,now:i64)->Vec<String> {
        let mut completed=vec![];self.capture.accepted=false;
        if frame.session!=session||!frame.valid()||!(0..=1000).contains(&(now-frame.at_ms)){return completed;}
        if self.capture.session!=session {self.reset();self.capture=CaptureState{session:session.into(),..Default::default()};}
        let previous=self.capture.sequences.get(&frame.source_id).copied();
        if previous.is_some_and(|previous|frame.sequence<=previous){return completed;}
        if !self.capture.sequences.contains_key(&frame.source_id)&&self.capture.sequences.len()>=16{self.reset();return completed;}
        self.capture.sequences.insert(frame.source_id.clone(),frame.sequence);
        if previous.is_some_and(|previous|frame.sequence!=previous+1){self.reset();self.capture.composing=false;return completed;}
        if frame.context.generation<self.capture.generation||frame.at_ms<self.capture.at_ms{return completed;}
        self.capture.at_ms=frame.at_ms;self.capture.generation=frame.context.generation;
        if !settings.enabled||!frame.context.active||frame.context.window.is_empty()||!settings.allows(&frame.context.app)||frame.context.protection==Protection::Protected||frame.context.protection==Protection::Unknown&&!settings.native_capture {self.reset();self.capture.composing=false;self.capture.context=None;return completed;}
        if !settings.native_capture&&frame.source!=CaptureSource::Accessibility {return completed;}
        if matches!(frame.edit,Edit::Reset){self.reset();self.capture.composing=false;self.capture.context=Some(frame.context);return completed;}
        self.last_input_ms=now;
        if frame.source!=frame.context.authority{return completed;}
        if let Some(previous)=&self.capture.context {
            let changed=previous.generation!=frame.context.generation||previous.window!=frame.context.window||previous.field!=frame.context.field||previous.app!=frame.context.app;
            let layout=previous.layout!=frame.context.layout;
            if changed||layout {if changed&&!layout&&!self.capture.composing&&let Some(text)=self.complete(){completed.push(text);}self.reset();self.capture.composing=false;}
        }
        self.capture.context=Some(frame.context.clone());
        self.capture.accepted=matches!(&frame.edit,Edit::Text(text) if !text.is_empty()&&!self.capture.composing)||matches!(&frame.edit,Edit::Commit(text) if !text.is_empty()&&frame.source!=CaptureSource::Keyboard);
        match frame.edit {
            Edit::CompositionStart=>{self.capture.composing=true;return completed;},
            Edit::CompositionEnd|Edit::CompositionCancel=>{self.capture.composing=false;return completed;},
            Edit::Commit(text)=>{
                if !matches!(frame.source,CaptureSource::Ime|CaptureSource::Bridge|CaptureSource::Accessibility){self.reset();return completed;}
                self.capture.composing=false;
                for c in text.chars(){let edit=if c=='\n'{Edit::Enter}else if c=='\r'{continue;}else{Edit::Text(c.to_string())};let event=Event{epoch,field:frame.context.field.clone().unwrap_or_else(||frame.context.window.clone()),app:frame.context.app.clone(),safe:true,direct:true,edit};if let Some(text)=self.event(event,settings,epoch,now){completed.push(text);}}
                return completed;
            },
            Edit::Text(_) if self.capture.composing=>return completed,
            _=>{},
        }
        let event=Event{epoch,field:frame.context.field.unwrap_or(frame.context.window),app:frame.context.app,safe:true,direct:true,edit:frame.edit};
        if let Some(text)=self.event(event,settings,epoch,now){completed.push(text);}completed
    }
    pub fn accepted_input(&self)->bool{self.capture.accepted}
    pub fn idle(&mut self,now_ms:i64)->Option<String> {if self.capture.composing{return None;}if !self.paused&&self.last_ms>0&&now_ms-self.last_ms>=5000 {self.paused=true;return self.complete();}None}
    pub fn quiet(&self,now_ms:i64)->bool {self.last_input_ms>0&&now_ms-self.last_input_ms>=5000}
    fn complete(&mut self)->Option<String> {
        // Taking the buffer makes completion idempotent; subsequent newly typed
        // sentences remain distinct occurrences even in the same field.
        let original=std::mem::take(&mut self.pending).trim().to_owned();let normalized=Self::normalize(&original);
        let length=normalized.chars().filter(|c|!c.is_whitespace()).count();
        if !(12..=1000).contains(&length)||!normalized.chars().any(char::is_alphabetic) {return None;}
        Some(original)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate { pub id:String, pub revision:i64, pub text:String, pub count:u32 }
#[derive(Serialize)]
pub struct Change { pub id:String, pub revision:i64, pub candidate:Option<Candidate> }
pub struct Store { connection:Connection }
impl Store {
    pub fn open(root:&Path)->Result<Self> {
        let directory=root.join("observations");std::fs::create_dir_all(&directory)?;
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&directory,std::fs::Permissions::from_mode(0o700))?;}
        #[cfg(windows)] Self::restrict_windows(&directory)?;
        let path=directory.join("private.sqlite3");let connection=Connection::open(&path)?;
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600))?;}
        #[cfg(windows)] Self::restrict_windows(&path)?;
        connection.busy_timeout(std::time::Duration::from_secs(2))?;
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS private(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,total INTEGER NOT NULL DEFAULT 0,dismiss_total INTEGER NOT NULL DEFAULT 0,dismiss_until INTEGER NOT NULL DEFAULT 0,notified INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS occurrences(candidate TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS occurrence_time ON occurrences(at);
            CREATE TABLE IF NOT EXISTS ignored(fingerprint TEXT PRIMARY KEY);")?;
        connection.execute("INSERT OR IGNORE INTO private VALUES('key',?1)",[uuid::Uuid::new_v4().to_string()+&uuid::Uuid::new_v4().to_string()])?;
        Ok(Self{connection})
    }
    #[cfg(windows)]
    fn restrict_windows(path:&Path)->Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::{w,PCWSTR,BOOL},Win32::{Foundation::{LocalFree,HLOCAL},Security::{Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW,SetNamedSecurityInfoW,SE_FILE_OBJECT,SDDL_REVISION_1},GetSecurityDescriptorDacl,PSECURITY_DESCRIPTOR,DACL_SECURITY_INFORMATION,PROTECTED_DACL_SECURITY_INFORMATION}}};
        unsafe {
            let mut descriptor=PSECURITY_DESCRIPTOR::default();ConvertStringSecurityDescriptorToSecurityDescriptorW(w!("D:P(A;OICI;FA;;;OW)"),SDDL_REVISION_1,&mut descriptor,None)?;
            let result=(||->Result<()>{let mut present=BOOL::default();let mut defaulted=BOOL::default();let mut acl=std::ptr::null_mut();GetSecurityDescriptorDacl(descriptor,&mut present,&mut acl,&mut defaulted)?;ensure!(present.as_bool()&&!acl.is_null(),"Private file permissions unavailable");let name=path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();SetNamedSecurityInfoW(PCWSTR(name.as_ptr()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,None,None,Some(acl),None).ok()?;Ok(())})();
            let _=LocalFree(Some(HLOCAL(descriptor.0)));result
        }
    }
    pub fn settings(&self)->Result<Settings> {let value:Option<String>=self.connection.query_row("SELECT value FROM settings WHERE id=1",[],|r|r.get(0)).optional()?;value.map(|value|serde_json::from_str(&value).map_err(Into::into)).unwrap_or(Ok(Settings::default()))}
    pub fn configure(&self,settings:&Settings)->Result<()> {settings.validate()?;self.connection.execute("INSERT INTO settings VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value",[serde_json::to_string(settings)?])?;self.connection.execute("UPDATE candidates SET revision=revision+1",[])?;Ok(())}
    fn fingerprint(&self,text:&str)->Result<String> {let key:String=self.connection.query_row("SELECT value FROM private WHERE key='key'",[],|r|r.get(0))?;let mut mac=Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts this key length");mac.update(Detector::normalize(text).as_bytes());Ok(format!("{:x}",mac.finalize().into_bytes()))}
    pub fn existing(database:&Database)->Result<HashSet<String>> {let mut result=HashSet::new();for library in database.libraries()? {let Some(id)=library["_id"].as_str()else{continue;};for record in database.records(id)? {if record["state"]=="active"&&let Some(text)=record["content"]["text"].as_str(){result.insert(Detector::normalize(text));}}}Ok(result)}
    pub fn prune(&self,now:i64,settings:&Settings)->Result<Vec<Change>> {
        let cutoff=now-i64::from(settings.retention_days)*86400;let transaction=self.connection.unchecked_transaction()?;
        let affected=self.connection.prepare("SELECT DISTINCT c.id,c.revision FROM candidates c JOIN occurrences o ON o.candidate=c.id WHERE o.at<=?1")?.query_map([cutoff],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        self.connection.execute("DELETE FROM occurrences WHERE at<=?1",[cutoff])?;
        for (id,_) in &affected {self.connection.execute("UPDATE candidates SET revision=revision+1 WHERE id=?1",[id])?;}
        self.connection.execute("DELETE FROM candidates WHERE id NOT IN (SELECT candidate FROM occurrences)",[])?;
        let ready=self.list(now,settings)?;transaction.commit()?;
        Ok(affected.into_iter().map(|(id,revision)|Change{candidate:ready.iter().find(|row|row.id==id).cloned(),id,revision:revision+1}).collect())
    }
    pub fn changes(&self,now:i64,settings:&Settings)->Result<Vec<Change>> {
        let ready=self.list(now,settings)?;
        Ok(self.connection.prepare("SELECT id,revision FROM candidates")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?.into_iter().map(|(id,revision)|Change{candidate:ready.iter().find(|row|row.id==id).cloned(),id,revision}).collect())
    }
    pub fn suppress_existing(&self,existing:&HashSet<String>)->Result<Vec<Change>> {
        let records=self.connection.prepare("SELECT id,revision,text FROM candidates")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut changes=vec![];for (id,revision,text) in records {if existing.contains(&Detector::normalize(&text)){self.connection.execute("DELETE FROM candidates WHERE id=?1",[&id])?;changes.push(Change{id,revision:revision+1,candidate:None});}}Ok(changes)
    }
    pub fn observe(&self,text:&str,now:i64,settings:&Settings,existing:&HashSet<String>)->Result<Option<Change>> {
        if !settings.enabled||existing.contains(&Detector::normalize(text)){return Ok(None);}
        let fingerprint=self.fingerprint(text)?;
        if self.connection.query_row("SELECT 1 FROM ignored WHERE fingerprint=?1",[&fingerprint],|_|Ok(())).optional()?.is_some(){return Ok(None);}
        let transaction=self.connection.unchecked_transaction()?;
        let known=self.connection.query_row("SELECT 1 FROM candidates WHERE fingerprint=?1",[&fingerprint],|_|Ok(())).optional()?.is_some();
        let count:i64=self.connection.query_row("SELECT COUNT(*) FROM candidates",[],|r|r.get(0))?;
        if !known&&count>=5000 {
            let victim:Option<String>=self.connection.query_row("SELECT c.id FROM candidates c JOIN occurrences o ON o.candidate=c.id GROUP BY c.id HAVING COUNT(*)<?1 OR c.dismiss_until>?2 OR c.total<c.dismiss_total+4 AND c.dismiss_total>0 ORDER BY MAX(o.at) LIMIT 1",params![settings.threshold,now],|r|r.get(0)).optional()?;
            let Some(victim)=victim else{return Ok(None);};self.connection.execute("DELETE FROM candidates WHERE id=?1",[victim])?;
        }
        self.connection.execute("INSERT OR IGNORE INTO candidates(id,fingerprint,text) VALUES(?1,?2,?3)",params![uuid::Uuid::new_v4().to_string(),fingerprint,text])?;
        let id:String=self.connection.query_row("SELECT id FROM candidates WHERE fingerprint=?1",[&fingerprint],|r|r.get(0))?;
        self.connection.execute("INSERT INTO occurrences VALUES(?1,?2)",params![id,now])?;
        self.connection.execute("UPDATE candidates SET total=total+1,revision=revision+1 WHERE id=?1",[&id])?;
        transaction.commit()?;
        Ok(self.list(now,settings)?.into_iter().find(|row|row.id==id).map(|candidate|Change{id:candidate.id.clone(),revision:candidate.revision,candidate:Some(candidate)}))
    }
    pub fn list(&self,now:i64,settings:&Settings)->Result<Vec<Candidate>> {
        let mut statement=self.connection.prepare("SELECT c.id,c.revision,c.text,COUNT(*) FROM candidates c JOIN occurrences o ON o.candidate=c.id WHERE o.at>?1 AND c.dismiss_until<=?2 AND (c.dismiss_total=0 OR c.total>=c.dismiss_total+4) GROUP BY c.id HAVING COUNT(*)>=?3 ORDER BY MAX(o.at) DESC")?;
        Ok(statement.query_map(params![now-i64::from(settings.retention_days)*86400,now,settings.threshold],|row|Ok(Candidate{id:row.get(0)?,revision:row.get(1)?,text:row.get(2)?,count:row.get(3)?}))?.collect::<std::result::Result<Vec<_>,_>>()?)
    }
    pub fn action(&self,id:&str,revision:i64,action:&str,now:i64)->Result<Change> {
        let transaction=self.connection.unchecked_transaction()?;
        let (current,fingerprint):(i64,String)=self.connection.query_row("SELECT revision,fingerprint FROM candidates WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).context("Suggestion is no longer available")?;
        ensure!(current==revision,"Suggestion changed; review the latest suggestion");
        match action {
            "dismiss"=>{self.connection.execute("UPDATE candidates SET dismiss_total=total,dismiss_until=?2,revision=revision+1,notified=0 WHERE id=?1",params![id,now+7*86400])?;},
            "ignore"|"delete"|"saved"=>{if action=="ignore"{self.connection.execute("INSERT OR IGNORE INTO ignored VALUES(?1)",[fingerprint])?;}self.connection.execute("DELETE FROM candidates WHERE id=?1",[id])?;},
            _=>anyhow::bail!("Unknown suggestion action"),
        }
        transaction.commit()?;Ok(Change{id:id.into(),revision:revision+1,candidate:None})
    }
    pub fn notification(&self,now:i64,settings:&Settings)->Result<bool> {
        if !settings.enabled||!settings.notifications{return Ok(false);}
        let pending=self.list(now,settings)?.into_iter().any(|row|self.connection.query_row("SELECT notified=0 FROM candidates WHERE id=?1",[row.id],|r|r.get::<_,bool>(0)).unwrap_or(false));
        if !pending{return Ok(false);}
        for candidate in self.list(now,settings)? {self.connection.execute("UPDATE candidates SET notified=1 WHERE id=?1",[candidate.id])?;}
        Ok(true)
    }
    pub fn forget(&self)->Result<()> {self.connection.execute_batch("BEGIN IMMEDIATE; DELETE FROM occurrences; DELETE FROM candidates; DELETE FROM ignored; DELETE FROM private; COMMIT; VACUUM;")?;self.connection.execute("INSERT INTO private VALUES('key',?1)",[uuid::Uuid::new_v4().to_string()+&uuid::Uuid::new_v4().to_string()])?;Ok(())}
    /// Save receipt and normal snippet/outbox mutation share the snippet transaction.
    /// Receipts contain random IDs only, never observed text or fingerprints.
    pub fn save(&self,database:&Database,id:&str,revision:i64,library:&str,draft:Match,now:i64)->Result<Change> {
        ensure!(!draft.replace.trim().is_empty(),"Snippet text is required");ensure!(draft.replace.chars().count()<=65536&&draft.title.len()<=1000,"Snippet is too long");
        let receipt=format!("observation-save:{id}");
        if database.meta(&receipt)?.is_some(){if let Some(current)=self.connection.query_row("SELECT revision FROM candidates WHERE id=?1",[id],|r|r.get::<_,i64>(0)).optional()?{return self.action(id,current,"saved",now);}return Ok(Change{id:id.into(),revision:revision+1,candidate:None});}
        let current:i64=self.connection.query_row("SELECT revision FROM candidates WHERE id=?1",[id],|r|r.get(0)).context("Suggestion is no longer available")?;
        ensure!(current==revision,"Suggestion changed; review the latest suggestion");
        let transaction=database.connection.unchecked_transaction()?;
        database.editable(library)?;let name=database.library(library)?["name"].as_str().context("Missing library name")?.to_owned();let file=database.editor(&name)?;
        database.edit(&file,None,Some(draft))?;database.set_meta(&receipt,&serde_json::json!(true))?;transaction.commit()?;
        self.action(id,revision,"saved",now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings()->Settings {Settings{enabled:true,..Settings::default()}}
    fn event(edit:Edit)->Event {Event{epoch:1,field:"field".into(),app:"editor".into(),safe:true,direct:true,edit}}
    fn type_text(detector:&mut Detector,text:&str)->Option<String> {let mut result=None;for c in text.chars(){result=detector.event(event(Edit::Text(c.to_string())),&settings(),1,1000).or(result);}result}
    struct CaptureFixture { detector:Detector,settings:Settings,sequence:u64,context:CaptureContext,now:i64 }
    impl CaptureFixture {
        fn new()->Self {Self{detector:Detector::default(),settings:Settings{enabled:true,native_capture:true,..Default::default()},sequence:0,context:CaptureContext{generation:1,app:"zed-editor".into(),window:"one".into(),active:true,layout:"us".into(),..Default::default()},now:1000}}
        fn frame(&mut self,edit:Edit)->CaptureFrame {self.sequence+=1;self.now+=10;CaptureFrame{version:1,session:"session".into(),source_id:"keyboard".into(),sequence:self.sequence,at_ms:self.now,context:self.context.clone(),source:self.context.authority,edit}}
        fn send(&mut self,edit:Edit)->Vec<String> {let frame=self.frame(edit);self.detector.capture(frame,&self.settings,1,"session",self.now)}
        fn text(&mut self,text:&str){for c in text.chars(){assert!(self.send(Edit::Text(c.to_string())).is_empty());}}
    }
    #[test]
    fn native_stream_rejects_replay_gaps_and_retired_contexts() {
        let mut f=CaptureFixture::new();f.text("me@email.com");let boundary=f.frame(Edit::Boundary);
        assert_eq!(f.detector.capture(boundary.clone(),&f.settings,1,"session",f.now),vec!["me@email.com"]);assert!(f.detector.capture(boundary,&f.settings,1,"session",f.now).is_empty());
        f.text("discard this text");f.sequence+=1;assert!(f.send(Edit::Boundary).is_empty());
        f.context.generation=2;f.text("another@site.com");let mut stale=f.frame(Edit::Boundary);stale.context.generation=1;assert!(f.detector.capture(stale,&f.settings,1,"session",f.now).is_empty());assert_eq!(f.send(Edit::Boundary),vec!["another@site.com"]);
        let frame=f.frame(Edit::Text("x".into()));assert!(f.detector.capture(frame,&f.settings,1,"new-session",f.now).is_empty());
    }
    #[test]
    fn native_scope_protection_exclusion_lock_and_layout_reset() {
        for mode in 0..5 {
            let mut f=CaptureFixture::new();f.text("unfinished words");match mode{0=>f.context.protection=Protection::Protected,1=>f.context.active=false,2=>f.settings.native_capture=false,3=>f.settings.excluded_apps.push("zed-editor".into()),_=>f.context.layout="de".into()};assert!(f.send(Edit::Boundary).is_empty());
        }
        let mut f=CaptureFixture::new();f.text("me@email.com");f.context.generation+=1;f.context.window="two".into();assert_eq!(f.send(Edit::Text("a".into())),vec!["me@email.com"]);
    }
    #[test]
    fn authoritative_ime_commits_replace_preedit_and_allow_long_unicode_text() {
        let mut f=CaptureFixture::new();f.context.authority=CaptureSource::Ime;f.context.ime=Some("ibus".into());
        f.send(Edit::CompositionStart);let mut raw=f.frame(Edit::Text("preedit".into()));raw.source=CaptureSource::Keyboard;raw.source_id="physical".into();f.sequence-=1;assert!(f.detector.capture(raw,&f.settings,1,"session",f.now).is_empty());assert!(f.detector.idle(f.now+6000).is_none());
        let text="これは確定された入力の文章です。";assert!(f.send(Edit::Commit(text.into())).is_empty());assert_eq!(f.send(Edit::Boundary),vec![text]);
        f.send(Edit::Commit("A committed prefix ".into()));f.send(Edit::CompositionStart);f.send(Edit::CompositionCancel);f.send(Edit::Commit("and its suffix".into()));assert_eq!(f.send(Edit::Boundary),vec!["A committed prefix and its suffix"]);
    }
    #[test]
    fn native_edits_idle_autocomplete_and_expansion_reset() {
        let mut f=CaptureFixture::new();f.text("repeatable sentencx");f.send(Edit::Backspace);f.send(Edit::Text("e".into()));
        // A popup is not a field change: context identity stays stable.
        f.context.generation+=1;f.context.generation-=1;
        assert_eq!(f.detector.idle(f.now+5000),Some("repeatable sentence".into()));assert!(f.detector.idle(f.now+6000).is_none());
        f.text("discard expansion trigger");f.send(Edit::Reset);assert!(f.send(Edit::Boundary).is_empty());
        f.text("verified typed text");let old=f.frame(Edit::Text("stale".into()));assert!(f.detector.capture(old,&f.settings,1,"session",f.now+2000).is_empty());assert!(!f.detector.accepted_input());
        f.send(Edit::Boundary);let old_generation=f.context.generation;f.context.generation+=1;f.context.protection=Protection::Protected;f.send(Edit::Reset);f.context.generation=old_generation;f.context.protection=Protection::Unknown;f.send(Edit::Text("late".into()));assert!(!f.detector.accepted_input());
    }
    #[test]
    fn boundaries_edits_and_untrusted_input() {
        let mut detector=Detector::default();let phrase="This is a repeated sentence.";
        assert_eq!(type_text(&mut detector,&format!("{phrase} ")),Some(phrase.into()));assert_eq!(type_text(&mut detector,&format!("{phrase} ")),Some(phrase.into()));
        detector.event(event(Edit::Enter),&settings(),1,1100);assert_eq!(type_text(&mut detector,&format!("{phrase} ")),Some(phrase.into()));
        type_text(&mut detector,"This is another long phrase");assert!(detector.idle(5999).is_none());assert!(detector.idle(6000).is_some());assert!(detector.idle(9000).is_none());
        for unsafe_event in [Event{safe:false,..event(Edit::Text("secret".into()))},Event{direct:false,..event(Edit::Text("paste".into()))},Event{epoch:0,..event(Edit::Text("stale".into()))}] {type_text(&mut detector,"Discard this pending phrase");detector.event(unsafe_event,&settings(),1,1000);assert!(detector.idle(6000).is_none());}
        assert_eq!(Detector::normalize("cafe\u{301}  is\n nice"),"café is nice");
    }
    #[test]
    fn twelve_character_words_emails_and_urls_are_candidates() {
        for phrase in ["confirmation","me@email.com","https://x.io","tomorrow we go"] {
            let mut detector=Detector::default();type_text(&mut detector,phrase);assert_eq!(detector.event(event(Edit::Enter),&settings(),1,1100),Some(phrase.into()));
        }
        for phrase in ["abcdefghijk","please send","............."] {
            let mut detector=Detector::default();type_text(&mut detector,phrase);assert!(detector.event(event(Edit::Enter),&settings(),1,1100).is_none());
        }
    }
    #[test]
    fn new_email_and_url_candidates_notify_without_an_hourly_cooldown() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,notifications:true,threshold:2,..Default::default()};
        // A timestamp left by an older installation must not suppress new alerts.
        store.connection.execute("INSERT INTO private VALUES('notification','100')",[]).unwrap();
        for (index,phrase) in ["me@email.com","https://x.io"].into_iter().enumerate() {
            for _ in 0..2 {
                let mut detector=Detector::default();type_text(&mut detector,phrase);let text=detector.event(event(Edit::Enter),&settings,1,1100).unwrap();store.observe(&text,101+index as i64,&settings,&HashSet::new()).unwrap();
            }
            assert!(store.notification(101+index as i64,&settings).unwrap());assert!(!store.notification(101+index as i64,&settings).unwrap());
        }
        assert_eq!(store.list(103,&settings).unwrap().len(),2);
        store.observe("me@email.com",103,&settings,&HashSet::new()).unwrap();assert!(!store.notification(103,&settings).unwrap());
    }
    #[test]
    fn separate_bursts_in_one_field_count_once_each_without_revisiting_old_text() {
        let mut detector=Detector::default();let phrase="A useful repeated typing burst";
        for _ in 0..4{assert!(type_text(&mut detector,phrase).is_none());assert_eq!(detector.idle(6000),Some(phrase.into()));assert!(detector.idle(7000).is_none());}
        detector.event(event(Edit::Reset),&settings(),1,8000);assert!(detector.idle(14000).is_none());
    }
    #[test]
    fn completed_sentence_can_notify_after_focus_moves_to_settings() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let mut detector=Detector::default();let settings=Settings{enabled:true,notifications:true,threshold:2,..Settings::default()};
        for at in [1000,2000] {
            for c in "Please send the purple notebook tomorrow.".chars(){detector.event(event(Edit::Text(c.to_string())),&settings,1,at);}
            let text=detector.event(event(Edit::Enter),&settings,1,at).unwrap();store.observe(&text,at/1000,&settings,&HashSet::new()).unwrap();
        }
        detector.event(event(Edit::Reset),&settings,1,2100);
        assert!(!detector.quiet(6999));assert!(detector.quiet(7000));assert!(detector.idle(7000).is_none());
        assert!(store.notification(7,&settings).unwrap());assert!(!store.notification(8,&settings).unwrap());
    }
    #[test]
    fn threshold_retention_ignore_forget_and_notifications() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let mut settings=settings();settings.notifications=true;let phrase="This is a repeated sentence.";
        for i in 0..3 {assert!(store.observe(phrase,100+i,&settings,&HashSet::new()).unwrap().is_none());}
        let row=store.observe(phrase,103,&settings,&HashSet::new()).unwrap().unwrap().candidate.unwrap();assert_eq!(row.count,4);
        assert!(store.notification(105,&settings).unwrap());assert!(!store.notification(110,&settings).unwrap());assert!(!store.notification(4000,&settings).unwrap());
        store.action(&row.id,row.revision,"ignore",110).unwrap();assert!(store.list(110,&settings).unwrap().is_empty());assert!(store.observe(phrase,111,&settings,&HashSet::new()).unwrap().is_none());
        store.forget().unwrap();for i in 0..4{store.observe(phrase,200+i,&settings,&HashSet::new()).unwrap();}assert_eq!(store.list(204,&settings).unwrap().len(),1);
        store.prune(204+31*86400,&settings).unwrap();assert!(store.list(204+31*86400,&settings).unwrap().is_empty());
    }
    #[test]
    fn deleting_a_suggestion_removes_counts_without_permanent_suppression() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{threshold:2,..settings()};let text="A captured reusable sentence.";
        for at in 100..102{store.observe(text,at,&settings,&HashSet::new()).unwrap();}let row=store.list(102,&settings).unwrap().remove(0);
        let change=store.action(&row.id,row.revision,"delete",103).unwrap();assert!(change.candidate.is_none());assert!(store.list(103,&settings).unwrap().is_empty());
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM ignored",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(store.observe(text,104,&settings,&HashSet::new()).unwrap().is_none());let new=store.observe(text,105,&settings,&HashSet::new()).unwrap().unwrap().candidate.unwrap();assert_ne!(row.id,new.id);assert_eq!(new.count,2);
    }
    #[test]
    fn dismissal_requires_time_and_four_more_occurrences() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=settings();let text="This is another useful sentence.";
        for i in 0..4{store.observe(text,100+i,&settings,&HashSet::new()).unwrap();}let row=store.list(104,&settings).unwrap().remove(0);store.action(&row.id,row.revision,"dismiss",105).unwrap();
        for i in 0..4{store.observe(text,106+i,&settings,&HashSet::new()).unwrap();}assert!(store.list(110,&settings).unwrap().is_empty());assert_eq!(store.list(105+7*86400,&settings).unwrap().len(),1);
    }
    #[test]
    fn save_is_idempotent_and_keeps_observation_out_of_snippet_store() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let db=Database::open(&root.path().join("snippets")).unwrap();let library=db.create("Local").unwrap();let settings=settings();let text="This is a repeated sentence.";
        for i in 0..4{store.observe(text,100+i,&settings,&HashSet::new()).unwrap();}let row=store.list(105,&settings).unwrap().remove(0);
        assert!(db.records(&library.id).unwrap().is_empty());assert!(db.pending().unwrap().is_empty());
        for _ in 0..2{store.save(&db,&row.id,row.revision,&library.id,Match{replace:text.into(),..Match::default()},106).unwrap();}assert_eq!(db.records(&library.id).unwrap().len(),1);assert!(db.pending().unwrap().is_empty());assert!(store.observe(text,107,&settings,&Store::existing(&db).unwrap()).unwrap().is_none());
    }
    #[test]
    fn excluded_disabled_and_ambiguous_edits_discard_pending_text() {
        let mut detector=Detector::default();let mut settings=settings();settings.excluded_apps=vec!["EDITOR".into()];
        assert!(!settings.allows("WindowsTerminal.exe"));assert!(!settings.allows("com.apple.Terminal"));assert!(!settings.allows("foot"));
        type_text(&mut detector,"This pending phrase must disappear");detector.event(event(Edit::Text("x".into())),&settings,1,1100);assert!(detector.idle(10000).is_none());
        settings.excluded_apps.clear();settings.enabled=false;type_text(&mut detector,"Another phrase that must disappear");detector.event(event(Edit::Enter),&settings,1,1100);assert!(detector.idle(10000).is_none());
        settings.enabled=true;type_text(&mut detector,"Another phrase before a click");detector.event(event(Edit::Reset),&settings,1,1100);assert!(detector.idle(10000).is_none());
        type_text(&mut detector,"This is some edited texx");detector.event(event(Edit::Backspace),&settings,1,1000);type_text(&mut detector,"t");assert_eq!(detector.idle(6000),Some("This is some edited text".into()));
        assert!(type_text(&mut Detector::default(),"aaaaaaaaaaaaaaaaaaaaaaaaaaa ").is_none());
    }
    #[test]
    fn expiry_reduces_counts_and_emits_removal_with_monotonic_revision() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{retention_days:7,..settings()};let text="This is an expiring repeated sentence.";
        for at in [100,200,300,400]{store.observe(text,at,&settings,&HashSet::new()).unwrap();}let row=store.list(401,&settings).unwrap().remove(0);
        let changes=store.prune(100+7*86400,&settings).unwrap();assert_eq!(changes.len(),1);assert!(changes[0].candidate.is_none());assert!(changes[0].revision>row.revision);
        let next=store.observe(text,101+7*86400,&settings,&HashSet::new()).unwrap().unwrap();assert!(next.revision>changes[0].revision);assert_eq!(next.candidate.unwrap().count,4);
    }
    #[test]
    fn settings_and_ignored_fingerprints_survive_restart_without_plaintext() {
        let root=tempfile::tempdir().unwrap();let settings=Settings{notifications:true,retention_days:7,..settings()};let text="Very distinctive confidential test wording.";
        {let store=Store::open(root.path()).unwrap();store.configure(&settings).unwrap();for at in 100..104{store.observe(text,at,&settings,&HashSet::new()).unwrap();}let row=store.list(105,&settings).unwrap().remove(0);store.action(&row.id,row.revision,"ignore",106).unwrap();}
        let bytes=std::fs::read(root.path().join("observations/private.sqlite3")).unwrap();assert!(!bytes.windows(text.len()).any(|part|part==text.as_bytes()));
        let store=Store::open(root.path()).unwrap();assert_eq!(store.settings().unwrap(),settings);assert!(store.observe(text,110,&settings,&HashSet::new()).unwrap().is_none());store.forget().unwrap();assert_eq!(store.settings().unwrap(),settings);
        assert!(!root.path().join("observations/private.sqlite3-wal").exists());assert!(!root.path().join("observations/private.sqlite3-journal").exists());
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;assert_eq!(std::fs::metadata(root.path().join("observations")).unwrap().permissions().mode()&0o777,0o700);assert_eq!(std::fs::metadata(root.path().join("observations/private.sqlite3")).unwrap().permissions().mode()&0o777,0o600);}
    }
    #[test]
    fn reviewed_synced_save_queues_only_the_edited_draft() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let db=Database::open(&root.path().join("snippets")).unwrap();
        db.apply(&serde_json::json!({"libraries":[{"_id":"remote","name":"Shared","state":"active","shared":true,"revision":1,"permissions":{"read":true,"edit":true,"manage":true},"records":[]}]}),None).unwrap();
        let settings=settings();for at in 100..104{store.observe("Private original observed words.",at,&settings,&HashSet::new()).unwrap();}let row=store.list(105,&settings).unwrap().remove(0);assert!(db.pending().unwrap().is_empty());
        store.save(&db,&row.id,row.revision,"remote",Match{replace:"Reviewed and edited before upload.".into(),title:"My snippet".into(),trigger:"reply".into(),..Match::default()},106).unwrap();
        let pending=db.pending().unwrap();assert_eq!(pending.len(),1);let serialized=serde_json::to_string(&pending).unwrap();assert!(serialized.contains("Reviewed and edited before upload."));assert!(!serialized.contains("Private original observed words."));assert!(!serialized.contains("fingerprint"));assert!(!serialized.contains("occurrences"));
    }
    #[test]
    fn stale_actions_readonly_libraries_and_invalid_drafts_preserve_suggestion() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let db=Database::open(&root.path().join("snippets")).unwrap();let settings=settings();
        db.apply(&serde_json::json!({"libraries":[{"_id":"readonly","name":"Read only","state":"active","revision":1,"permissions":{"read":true,"edit":false},"records":[]}]}),None).unwrap();
        for at in 100..104{store.observe("Keep this original text for later.",at,&settings,&HashSet::new()).unwrap();}let row=store.list(105,&settings).unwrap().remove(0);
        assert!(store.action(&row.id,row.revision-1,"ignore",106).is_err());assert!(store.save(&db,&row.id,row.revision,"readonly",Match{replace:row.text.clone(),..Match::default()},106).is_err());
        let library=db.create("Local").unwrap();assert!(store.save(&db,&row.id,row.revision,&library.id,Match::default(),106).is_err());assert!(db.records(&library.id).unwrap().is_empty());assert_eq!(store.list(107,&settings).unwrap().len(),1);
    }
    #[test]
    fn candidate_limit_evicts_inactive_entries_without_removing_ready_cards() {
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=settings();
        let transaction=store.connection.unchecked_transaction().unwrap();
        for index in 0..5000 {let id=index.to_string();store.connection.execute("INSERT INTO candidates(id,fingerprint,text,total) VALUES(?1,?1,'A repeated seeded phrase.',?2)",params![id,if index==0{1}else{4}]).unwrap();for _ in 0..if index==0{1}else{4}{store.connection.execute("INSERT INTO occurrences VALUES(?1,100)",[&id]).unwrap();}}
        transaction.commit().unwrap();store.observe("An entirely new candidate phrase.",101,&settings,&HashSet::new()).unwrap();
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM candidates",[],|r|r.get::<_,i64>(0)).unwrap(),5000);assert!(store.connection.query_row("SELECT 1 FROM candidates WHERE id='0'",[],|_|Ok(())).optional().unwrap().is_none());assert_eq!(store.list(102,&settings).unwrap().len(),4999);
    }
}
