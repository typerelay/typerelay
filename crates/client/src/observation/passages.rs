//! Incremental passage discovery inside the existing private observation store.
//! Only keyed fingerprints, opaque range receipts and qualifying cards reach disk.
use super::*;
use std::collections::{BTreeSet,HashMap};

#[derive(Clone,Debug)]
pub struct PassageRevision {pub id:String,pub revision:i64,pub base:i64,pub changed_from:i64,pub text:String,pub at_ms:i64}
#[derive(Clone,Default,Serialize)]
pub struct DiscoveryStatus {pub fingerprints:u64,pub capacity:u64,pub capacity_reached:bool}
pub enum PassageProgress {Pending,Complete(Vec<Change>)}
#[derive(Clone)]
struct Boundary {raw:usize,character:i64,normal:usize,nonspace:usize,letters:usize}
struct Span {fingerprint:String,start:i64,end:i64,raw_start:usize,raw_end:usize,characters:usize}
pub struct PassageWork {
    revision:PassageRevision,normal:String,starts:Vec<Boundary>,ends:Vec<Boundary>,start:usize,end:usize,hashed_to:usize,mac:Option<Hmac<sha2::Sha256>>,key:Vec<u8>,samples:HashMap<String,(usize,usize)>,last_end:HashMap<String,i64>,index_size:usize,prepared:bool,limit:usize,saturated:bool,
}
impl PassageWork {
    fn new(revision:PassageRevision,key:Vec<u8>,index_size:usize)->Self {
        let text=&revision.text;let mut normal=String::new();let mut mapping=HashMap::new();let mut character=0i64;let mut whitespace=false;
        for (byte,grapheme) in text.grapheme_indices(true){mapping.insert(byte,(normal.len(),character));for c in grapheme.nfc(){if c.is_whitespace(){if !whitespace&&!normal.is_empty(){normal.push(' ');}whitespace=true;}else{normal.push(c);whitespace=false;}}character+=grapheme.chars().count() as i64;mapping.insert(byte+grapheme.len(),(normal.len(),character));}
        let mut starts=BTreeSet::new();let mut ends=BTreeSet::new();
        for (at,word) in text.unicode_word_indices(){starts.insert(at);let end=at+word.len();ends.insert(end);let punctuation=text[end..].char_indices().take_while(|(_,c)|!c.is_whitespace()&&!c.is_alphanumeric()).map(|(offset,c)|end+offset+c.len_utf8()).last();if let Some(end)=punctuation{ends.insert(end);}}
        // Treat addresses/URLs as atoms, never mine their user/host/path fragments.
        let mut offset=0;for chunk in text.split_inclusive(char::is_whitespace){let piece=chunk.trim();let lead=chunk.len()-chunk.trim_start().len();let core=piece.trim_matches(|c:char|"\"'()[]{}<>.,!?;:".contains(c));let is_url=core.starts_with("https://")||core.starts_with("http://")||core.starts_with("www.");let is_email=core.split_once('@').is_some_and(|(user,host)|!user.is_empty()&&host.contains('.')&&!host.starts_with('.'));
            if is_url||is_email{let begin=offset+lead+piece.find(core).unwrap_or(0);let end=begin+core.len();starts.retain(|p|*p<=begin||*p>=end);ends.retain(|p|*p<=begin||*p>=end);starts.insert(begin);ends.insert(end);}offset+=chunk.len();}
        let mut counts=HashMap::new();let(mut nonspace,mut letters)=(0,0);counts.insert(0,(0,0));for(byte,c)in normal.char_indices(){if !c.is_whitespace(){nonspace+=1;}if c.is_alphabetic(){letters+=1;}counts.insert(byte+c.len_utf8(),(nonspace,letters));}
        let boundary=|raw:usize|mapping.get(&raw).map(|&(position,character)|{let(nonspace,letters)=counts[&position];Boundary{raw,character:revision.base+character,normal:position,nonspace,letters}});let starts=starts.into_iter().filter_map(boundary).collect();let ends=ends.into_iter().filter_map(boundary).collect();
        Self{revision,normal,starts,ends,start:0,end:0,hashed_to:0,mac:None,key,samples:HashMap::new(),last_end:HashMap::new(),index_size,prepared:false,limit:250_000,saturated:false}
    }
    pub fn same_window(&self,revision:&PassageRevision)->bool{self.revision.id==revision.id&&self.revision.base==revision.base}
    pub fn merge_changes(&self,revision:&mut PassageRevision){revision.changed_from=revision.changed_from.min(self.revision.changed_from);}
    fn next(&mut self)->Option<Span>{
        while self.start<self.starts.len(){let start=&self.starts[self.start];if self.mac.is_none(){self.mac=Some(Hmac::<sha2::Sha256>::new_from_slice(&self.key).expect("HMAC key"));self.hashed_to=start.normal;self.end=self.ends.partition_point(|end|end.raw<=start.raw);}
            while self.end<self.ends.len(){let end=&self.ends[self.end];self.end+=1;if end.character-start.character>1000{break;}let normal_end=self.normal[..end.normal].trim_end().len();if normal_end<=self.hashed_to{continue;}self.mac.as_mut().unwrap().update(&self.normal.as_bytes()[self.hashed_to..normal_end]);self.hashed_to=normal_end;let characters=end.nonspace-start.nonspace;if characters<12||end.letters==start.letters{continue;}
                let fingerprint=format!("{:x}",self.mac.as_ref().unwrap().clone().finalize().into_bytes());
                return Some(Span{fingerprint,start:start.character,end:end.character,raw_start:start.raw,raw_end:end.raw,characters});
            }
            self.start+=1;self.mac=None;
        }None
    }
}

impl Store {
    pub(super) fn migrate_passages(&self)->Result<()> {
        self.connection.execute_batch("CREATE TABLE IF NOT EXISTS passage_patterns(fingerprint TEXT PRIMARY KEY,characters INTEGER NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS passage_contexts(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS passage_receipts(context TEXT NOT NULL,revision INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,fingerprint TEXT NOT NULL REFERENCES passage_patterns(fingerprint) ON DELETE CASCADE,at INTEGER NOT NULL,committed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(context,revision,start,end,fingerprint));
            CREATE INDEX IF NOT EXISTS passage_receipt_pattern ON passage_receipts(fingerprint,committed,at);
            CREATE INDEX IF NOT EXISTS passage_receipt_context ON passage_receipts(context,start,end);
            CREATE TABLE IF NOT EXISTS passage_rejections(context TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(context,start,end));
            CREATE TABLE IF NOT EXISTS passage_cards(id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE);
            CREATE TEMP TABLE IF NOT EXISTS passage_existing(fingerprint TEXT PRIMARY KEY);")?;
        let version:Option<String>=self.connection.query_row("SELECT value FROM private WHERE key='passage-version'",[],|r|r.get(0)).optional()?;if version.as_deref()==Some("1"){return Ok(());}
        let settings=self.settings()?;let transaction=self.connection.unchecked_transaction()?;
        let records=self.connection.prepare("SELECT c.id,c.fingerprint,c.text,o.rowid,o.at FROM candidates c JOIN occurrences o ON o.candidate=c.id ORDER BY o.rowid")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for(id,fingerprint,text,row,at)in records{let length=Detector::normalize(&text).chars().count();self.connection.execute("INSERT OR IGNORE INTO passage_patterns VALUES(?1,?2,?3,?3,0)",params![fingerprint,length as i64,at])?;self.connection.execute("INSERT OR IGNORE INTO passage_receipts VALUES(?1,1,0,?2,?3,?4,1)",params![format!("legacy:{id}:{row}"),length as i64,fingerprint,at])?;self.connection.execute("INSERT OR IGNORE INTO passage_cards VALUES(?1)",[&id])?;}
        self.connection.execute("UPDATE passage_patterns SET total=(SELECT COUNT(*) FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint),last_at=(SELECT MAX(at) FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint)",[])?;
        self.connection.execute("DELETE FROM candidates WHERE id IN (SELECT id FROM passage_cards) AND (SELECT COUNT(*) FROM occurrences WHERE candidate=candidates.id)<?1",[settings.threshold])?;
        self.connection.execute("INSERT OR REPLACE INTO private VALUES('passage-version','1')",[])?;transaction.commit()?;Ok(())
    }
    pub fn recover_passages(&self)->Result<()>{self.connection.execute("DELETE FROM passage_receipts WHERE committed=0",[])?;self.connection.execute("DELETE FROM passage_patterns WHERE total=0 AND NOT EXISTS(SELECT 1 FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint)",[])?;Ok(())}
    pub fn discovery_status(&self)->Result<DiscoveryStatus>{let count=self.connection.query_row("SELECT COUNT(*) FROM passage_patterns",[],|r|r.get::<_,i64>(0))?;let pressure=self.connection.query_row("SELECT value='1' FROM private WHERE key='passage-pressure'",[],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(false);Ok(DiscoveryStatus{fingerprints:count as u64,capacity:250_000,capacity_reached:pressure||count>=250_000})}
    pub fn begin_passage(&self,revision:PassageRevision)->Result<PassageWork>{ensure!(!revision.id.is_empty()&&revision.id.len()<=128&&revision.text.chars().count()<=4096&&revision.revision>0&&revision.base>=0&&revision.changed_from>=0,"Invalid passage revision");let key:String=self.connection.query_row("SELECT value FROM private WHERE key='key'",[],|r|r.get(0))?;let count=self.connection.query_row("SELECT COUNT(*) FROM passage_patterns",[],|r|r.get::<_,i64>(0))?;Ok(PassageWork::new(revision,key.into_bytes(),count as usize))}
    pub fn cancel_passage(&self,work:&PassageWork)->Result<()>{self.connection.execute("DELETE FROM passage_receipts WHERE context=?1 AND revision=?2 AND committed=0",params![work.revision.id,work.revision.revision])?;Ok(())}
    pub fn advance_passage(&self,work:&mut PassageWork,settings:&Settings,now:i64)->Result<PassageProgress>{
        if !settings.enabled{self.cancel_passage(work)?;return Ok(PassageProgress::Complete(vec![]));}
        if !work.prepared{let previous=self.connection.query_row("SELECT revision FROM passage_contexts WHERE id=?1",[&work.revision.id],|r|r.get::<_,i64>(0)).optional()?.unwrap_or(0);if previous>=work.revision.revision{return Ok(PassageProgress::Complete(vec![]));}self.connection.execute("DELETE FROM passage_receipts WHERE context=?1 AND committed=0",[&work.revision.id])?;work.prepared=true;}
        let transaction=self.connection.unchecked_transaction()?;let mut exhausted=false;
        for _ in 0..256{let Some(span)=work.next()else{exhausted=true;break;};let known=self.connection.query_row("SELECT 1 FROM passage_patterns WHERE fingerprint=?1",[&span.fingerprint],|_|Ok(())).optional()?.is_some();
            if !known{
                if work.saturated{continue;}
                if work.index_size>=work.limit{let expired=self.connection.execute("DELETE FROM passage_patterns WHERE last_at<=?1 AND fingerprint NOT IN (SELECT fingerprint FROM candidates)",[now-i64::from(settings.retention_days)*86400])?;work.index_size=work.index_size.saturating_sub(expired);let empty=self.connection.execute("DELETE FROM passage_patterns WHERE total=0 AND NOT EXISTS(SELECT 1 FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint)",[])?;work.index_size=work.index_size.saturating_sub(empty);let evicted=self.connection.execute("DELETE FROM passage_patterns WHERE fingerprint IN (SELECT fingerprint FROM passage_patterns WHERE total=1 AND fingerprint NOT IN (SELECT fingerprint FROM candidates) AND NOT EXISTS(SELECT 1 FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint AND r.committed=0) ORDER BY last_at LIMIT 256)",[])?;work.index_size=work.index_size.saturating_sub(evicted);}
                if work.index_size>=work.limit{self.connection.execute("INSERT OR REPLACE INTO private VALUES('passage-pressure','1')",[])?;work.saturated=true;continue;}
                self.connection.execute("INSERT INTO passage_patterns VALUES(?1,?2,?3,?3,0)",params![span.fingerprint,span.characters as i64,work.revision.at_ms/1000])?;work.index_size+=1;
            }
            if work.last_end.get(&span.fingerprint).is_some_and(|previous|*previous>span.start){continue;}work.last_end.insert(span.fingerprint.clone(),span.end);
            let rejected=self.connection.query_row("SELECT 1 FROM passage_rejections WHERE context=?1 AND start<=?2 AND end>=?3 LIMIT 1",params![work.revision.id,span.start,span.end],|_|Ok(())).optional()?.is_some();if rejected{continue;}
            let prior=self.connection.query_row("SELECT MIN(at) FROM passage_receipts WHERE context=?1 AND start=?2 AND end=?3 AND fingerprint=?4 AND committed=1",params![work.revision.id,span.start,span.end,span.fingerprint],|r|r.get::<_,Option<i64>>(0))?.unwrap_or(work.revision.at_ms/1000);
            self.connection.execute("INSERT OR IGNORE INTO passage_receipts VALUES(?1,?2,?3,?4,?5,?6,0)",params![work.revision.id,work.revision.revision,span.start,span.end,span.fingerprint,prior])?;work.samples.entry(span.fingerprint).or_insert((span.raw_start,span.raw_end));
        }
        transaction.commit()?;
        if !exhausted{return Ok(PassageProgress::Pending);}
        let transaction=self.connection.unchecked_transaction()?;
        self.connection.execute("DELETE FROM passage_receipts WHERE context=?1 AND committed=1 AND (start>=?2 OR end>?3)",params![work.revision.id,work.revision.base,work.revision.changed_from])?;
        self.connection.execute("UPDATE passage_receipts SET committed=1 WHERE context=?1 AND revision=?2",params![work.revision.id,work.revision.revision])?;
        self.connection.execute("INSERT INTO passage_contexts VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,at=excluded.at",params![work.revision.id,work.revision.revision,now])?;
        // Recount committed receipts; staged revisions never affect visible counts.
        self.connection.execute("UPDATE passage_patterns SET total=(SELECT COUNT(*) FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint AND r.committed=1 AND r.at>?1)",params![now-i64::from(settings.retention_days)*86400])?;
        self.connection.execute("UPDATE passage_patterns SET last_at=MAX(last_at,?1) WHERE fingerprint IN (SELECT fingerprint FROM passage_receipts WHERE context=?2 AND committed=1)",params![work.revision.at_ms/1000,work.revision.id])?;
        let changes=self.reconcile_passages(Some(work),settings,now)?;transaction.commit()?;Ok(PassageProgress::Complete(changes))
    }
    pub(super) fn set_existing_passages(&self,existing:&HashSet<String>)->Result<()>{let transaction=self.connection.unchecked_transaction()?;self.connection.execute("DELETE FROM passage_existing",[])?;for text in existing{self.connection.execute("INSERT OR IGNORE INTO passage_existing VALUES(?1)",[self.fingerprint(text)?])?;}transaction.commit()?;Ok(())}
    fn reconcile_passages(&self,work:Option<&PassageWork>,settings:&Settings,now:i64)->Result<Vec<Change>>{
        let cutoff=now-i64::from(settings.retention_days)*86400;let mut independent=HashMap::<String,u32>::new();let mut context=String::new();let mut covered=Vec::<(i64,i64)>::new();
        let mut statement=self.connection.prepare("SELECT r.context,r.start,r.end,r.fingerprint,EXISTS(SELECT 1 FROM ignored i WHERE i.fingerprint=r.fingerprint) OR EXISTS(SELECT 1 FROM passage_existing e WHERE e.fingerprint=r.fingerprint) FROM passage_receipts r JOIN passage_patterns p ON p.fingerprint=r.fingerprint WHERE r.committed=1 AND r.at>?1 AND (p.total>=?2 OR EXISTS(SELECT 1 FROM ignored i WHERE i.fingerprint=r.fingerprint) OR EXISTS(SELECT 1 FROM passage_existing e WHERE e.fingerprint=r.fingerprint)) ORDER BY r.context,(r.end-r.start) DESC,r.start")?;
        let rows=statement.query_map(params![cutoff,settings.threshold],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?)))?;
        for row in rows{let(id,start,end,fp,blocked)=row?;if id!=context{context=id;covered.clear();}if !covered.iter().any(|&(left,right)|start<right&&end>left){if !blocked{*independent.entry(fp).or_default()+=1;}covered.push((start,end));}}
        let visible:HashSet<_>=independent.into_iter().filter_map(|(fp,count)|(count>=settings.threshold).then_some(fp)).collect();
        let old=self.connection.prepare("SELECT c.id,c.fingerprint,c.text,c.revision,c.notified FROM candidates c JOIN passage_cards p ON p.id=c.id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let normalized_old:HashMap<_,_>=old.iter().map(|(id,_,text,_,_)|(id.clone(),Detector::normalize(text))).collect();let extension_ids=self.connection.prepare("SELECT c.id FROM candidates c JOIN passage_patterns p ON p.fingerprint=c.fingerprint WHERE p.total>=?1 AND p.last_at>?2")?.query_map(params![settings.threshold,cutoff],|r|r.get::<_,String>(0))?.collect::<std::result::Result<HashSet<_>,_>>()?;
        let mut available:Vec<_>=visible.iter().filter_map(|fp|{if let Some((_,_,text,_,_))=old.iter().find(|(_,known,_,_,_)|known==fp){Some((fp.clone(),text.clone()))}else{work.and_then(|work|work.samples.get(fp).map(|&(start,end)|(fp.clone(),work.revision.text[start..end].trim().to_owned())))}}).collect();available.sort_by_key(|(_,text)|std::cmp::Reverse(text.chars().count()));available.truncate(5000);
        let mut changes=vec![];let mut keep=HashSet::new();let mut consumed=HashSet::new();
        for(fp,text)in available{
            let count=self.connection.query_row("SELECT total FROM passage_patterns WHERE fingerprint=?1",[&fp],|r|r.get::<_,u32>(0))?;
            let exact=old.iter().find(|(_,known,_,_,_)|known==&fp);
            if let Some((id,_,old_text,_,_))=exact{let total=self.connection.query_row("SELECT total FROM candidates WHERE id=?1",[id],|r|r.get::<_,u32>(0))?;let old_times=self.connection.prepare("SELECT at FROM occurrences WHERE candidate=?1 ORDER BY at")?.query_map([id],|r|r.get::<_,i64>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;let new_times=self.connection.prepare("SELECT at FROM passage_receipts WHERE fingerprint=?1 AND committed=1 AND at>?2 ORDER BY at")?.query_map(params![fp,cutoff],|r|r.get::<_,i64>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;if total==count&&old_text==&text&&old_times==new_times{keep.insert(id.clone());consumed.insert(id.clone());continue;}}
            let normalized=Detector::normalize(&text);let extended=if exact.is_none(){old.iter().filter(|(id,known,_,_,_)|extension_ids.contains(id)&&!consumed.contains(id)&&!visible.contains(known)&&normalized.contains(&normalized_old[id])).max_by_key(|(_,_,text,_,_)|text.len())}else{None};
            let (id,revision,notified)=if let Some((id,_,_,revision,notified))=exact.or(extended){consumed.insert(id.clone());(id.clone(),*revision+1,*notified)}else{(uuid::Uuid::new_v4().to_string(),1,0)};
            if let Some((_,known,_,_,_))=extended{self.connection.execute("UPDATE candidates SET fingerprint=?2 WHERE id=?1",params![id,fp])?;let _=known;}
            self.connection.execute("INSERT INTO candidates(id,fingerprint,text,revision,total,notified) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,text=excluded.text,revision=excluded.revision,total=excluded.total,notified=excluded.notified",params![id,fp,text,revision,count,notified])?;
            self.connection.execute("INSERT OR IGNORE INTO passage_cards VALUES(?1)",[&id])?;self.connection.execute("DELETE FROM occurrences WHERE candidate=?1",[&id])?;
            self.connection.execute("INSERT INTO occurrences SELECT ?1,at FROM passage_receipts WHERE fingerprint=?2 AND committed=1 AND at>?3",params![id,fp,cutoff])?;keep.insert(id.clone());let shown=self.connection.query_row("SELECT dismiss_until<=?2 AND (dismiss_total=0 OR total>=dismiss_total+4) FROM candidates WHERE id=?1",params![id,now],|r|r.get::<_,bool>(0))?;changes.push(Change{id:id.clone(),revision,candidate:shown.then_some(Candidate{id,revision,text,count})});
        }
        for(id,_,_,revision,_)in old{if !keep.contains(&id){self.connection.execute("DELETE FROM candidates WHERE id=?1",[&id])?;changes.push(Change{id,revision:revision+1,candidate:None});}}
        Ok(changes)
    }
    pub(super) fn reject_passage(&self,fingerprint:&str,action:&str)->Result<()>{if !["delete","ignore","saved"].contains(&action){return Ok(());}self.connection.execute("INSERT OR IGNORE INTO passage_rejections SELECT context,start,end,at FROM passage_receipts WHERE fingerprint=?1 AND committed=1",[fingerprint])?;
        self.connection.execute("DELETE FROM passage_receipts WHERE EXISTS(SELECT 1 FROM passage_rejections r WHERE r.context=passage_receipts.context AND r.start<=passage_receipts.start AND r.end>=passage_receipts.end)",[])?;self.connection.execute("UPDATE passage_patterns SET total=(SELECT COUNT(*) FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint AND r.committed=1)",[])?;Ok(())}
    pub(super) fn prune_passages(&self,now:i64,settings:&Settings)->Result<Vec<Change>>{let cutoff=now-i64::from(settings.retention_days)*86400;let transaction=self.connection.unchecked_transaction()?;self.connection.execute("DELETE FROM passage_receipts WHERE at<=?1",[cutoff])?;self.connection.execute("DELETE FROM passage_patterns WHERE last_at<=?1 AND fingerprint NOT IN (SELECT fingerprint FROM candidates)",[cutoff])?;self.connection.execute("DELETE FROM passage_rejections WHERE at<=?1",[cutoff])?;self.connection.execute("DELETE FROM passage_contexts WHERE at<=?1",[cutoff])?;self.connection.execute("UPDATE passage_patterns SET total=(SELECT COUNT(*) FROM passage_receipts r WHERE r.fingerprint=passage_patterns.fingerprint AND r.committed=1)",[])?;self.connection.execute("INSERT OR REPLACE INTO private SELECT 'passage-pressure','0' WHERE (SELECT COUNT(*) FROM passage_patterns)<250000",[])?;let changes=self.reconcile_passages(None,settings,now)?;transaction.commit()?;Ok(changes)}
}

#[cfg(test)]
mod tests {
    use super::*;
    const CLOSING:&str="I hope this help. Just reply and I'll help.";
    struct Harness {root:tempfile::TempDir,store:Store,settings:Settings,now:i64}
    impl Harness {
        fn new()->Self{let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,native_capture:true,notifications:true,threshold:2,..Default::default()};store.configure(&settings).unwrap();Self{root,store,settings,now:1_800_000_000}}
        fn write(&mut self,id:&str,revision:i64,text:&str)->Vec<Change>{self.now+=10;let revision=PassageRevision{id:id.into(),revision,base:0,changed_from:0,text:text.into(),at_ms:self.now*1000};let mut work=self.store.begin_passage(revision).unwrap();for _ in 0..20000{if let PassageProgress::Complete(changes)=self.store.advance_passage(&mut work,&self.settings,self.now).unwrap(){return changes;}}panic!("passage work did not finish")}
        fn ready(&self)->Vec<Candidate>{self.store.list(self.now,&self.settings).unwrap()}
    }
    #[test]
    fn recurring_closing_inside_different_messages_survives_days_and_restart(){
        let mut h=Harness::new();h.write("email-one",1,&format!("Alice asked about invoices. {CLOSING}\nSigned Clara."));assert!(h.ready().is_empty());let bytes=std::fs::read(h.root.path().join("observations/private.sqlite3")).unwrap();assert!(!bytes.windows(CLOSING.len()).any(|bytes|bytes==CLOSING.as_bytes()));
        h.now+=3*86400;h.store=Store::open(h.root.path()).unwrap();h.write("email-two",1,&format!("Boris needs delivery advice. {CLOSING}\nThanks Dennis."));let rows=h.ready();assert_eq!(rows.len(),1);assert_eq!(rows[0].text,CLOSING);assert_eq!(rows[0].count,2);
    }
    #[test]
    fn embedded_addresses_and_urls_remain_atomic(){let mut h=Harness::new();h.write("one",1,"Contact me@email.com regarding invoices. Browse https://example.org/help for details.");h.write("two",1,"Billing: me@email.com today. Visit https://example.org/help tomorrow.");let values:Vec<_>=h.ready().into_iter().map(|row|row.text).collect();assert!(values.contains(&"me@email.com".into()));assert!(values.contains(&"https://example.org/help".into()));assert!(!values.iter().any(|text|text=="example.org/help"));}
    #[test]
    fn revisions_and_corrections_do_not_inflate_counts(){let mut h=Harness::new();h.write("one",1,CLOSING);h.write("two",1,CLOSING);assert_eq!(h.ready()[0].count,2);h.write("two",1,CLOSING);h.write("two",2,CLOSING);assert_eq!(h.ready()[0].count,2);h.write("two",3,"Entirely different corrected material");assert!(h.ready().is_empty());h.write("two",2,CLOSING);assert!(h.ready().is_empty());h.write("two",4,CLOSING);assert_eq!(h.ready()[0].count,2);}
    #[test]
    fn longer_passage_upgrades_one_card_without_a_second_notification(){let mut h=Harness::new();h.write("one",1,CLOSING);h.write("two",1,"I hope this help.");let id=h.ready()[0].id.clone();assert!(h.store.notification(h.now,&h.settings).unwrap());h.write("two",2,"I hope this help.\nJust reply and I'll help.");let rows=h.ready();assert_eq!(rows.len(),1);assert_eq!(rows[0].id,id);assert_eq!(Detector::normalize(&rows[0].text),CLOSING);assert!(!h.store.notification(h.now,&h.settings).unwrap());}
    #[test]
    fn shorter_passage_needs_independent_uses(){let mut h=Harness::new();h.write("one",1,CLOSING);h.write("two",1,CLOSING);h.write("three",1,"I hope this help.");assert_eq!(h.ready().len(),1);h.write("four",1,"I hope this help.");let rows=h.ready();assert_eq!(rows.len(),2);assert!(rows.iter().any(|row|row.text=="I hope this help."&&row.count==4));}
    #[test]
    fn rejected_passages_do_not_reappear_as_their_fragments(){for action in ["delete","ignore"]{let mut h=Harness::new();h.write("one",1,CLOSING);h.write("two",1,CLOSING);let row=h.ready().remove(0);h.store.action(&row.id,row.revision,action,h.now).unwrap();h.write("two",2,CLOSING);assert!(h.ready().is_empty());h.write("three",1,CLOSING);assert!(h.ready().is_empty());h.write("four",1,CLOSING);assert_eq!(h.ready().is_empty(),action=="ignore");}}
    #[test]
    fn existing_snippets_suppress_overlapping_fragments(){let mut h=Harness::new();h.store.set_existing_passages(&HashSet::from([CLOSING.into()])).unwrap();h.write("one",1,CLOSING);h.write("two",1,CLOSING);assert!(h.ready().is_empty());}
    #[test]
    fn migration_seeds_only_exact_known_occurrences(){let mut h=Harness::new();h.store.observe(CLOSING,h.now,&h.settings,&HashSet::new()).unwrap();h.store.observe(CLOSING,h.now+1,&h.settings,&HashSet::new()).unwrap();let id=h.ready()[0].id.clone();h.store.connection.execute("DELETE FROM private WHERE key='passage-version'",[]).unwrap();h.store=Store::open(h.root.path()).unwrap();assert_eq!(h.ready()[0].id,id);assert_eq!(h.store.discovery_status().unwrap().fingerprints,1);h.write("later",1,"I hope this help.");assert!(h.ready().iter().all(|row|row.text==CLOSING));}
    #[test]
    fn retention_and_discovery_capacity_are_bounded(){let mut h=Harness::new();let mut work=h.store.begin_passage(PassageRevision{id:"large".into(),revision:1,base:0,changed_from:0,text:"Several different words provide enough combinations for a bounded discovery test.".into(),at_ms:h.now*1000}).unwrap();work.limit=3;while matches!(h.store.advance_passage(&mut work,&h.settings,h.now).unwrap(),PassageProgress::Pending){}assert!(h.store.discovery_status().unwrap().fingerprints<=3);assert!(h.store.discovery_status().unwrap().capacity_reached);h.now+=31*86400;h.store.prune(h.now,&h.settings).unwrap();assert_eq!(h.store.discovery_status().unwrap().fingerprints,0);}
    #[test]
    fn whitespace_unicode_are_normalized_but_case_and_words_are_exact(){let mut h=Harness::new();h.write("one",1,"Heute geht es über alles");h.write("two",1,"Heute  geht\nes u\u{308}ber alles");assert_eq!(h.ready().len(),1);assert_eq!(h.ready()[0].count,2);let mut h=Harness::new();h.write("one",1,"Confirmation");h.write("two",1,"confirmation");assert!(h.ready().is_empty());}
    #[test]
    fn idle_and_backspace_revise_the_same_observed_range(){let mut h=Harness::new();h.write("previous",1,"Heute geht es uber alles");let mut detector=Detector::default();for c in "Heute geht es uber allex".chars(){detector.event(Event{epoch:1,field:"editor".into(),app:"obsidian".into(),safe:true,direct:true,edit:Edit::Text(c.to_string())},&h.settings,1,h.now*1000);}detector.idle(h.now*1000+5000);let first=detector.take_passages().pop().unwrap();let id=first.id.clone();h.write(&id,first.revision,&first.text);detector.event(Event{epoch:1,field:"editor".into(),app:"obsidian".into(),safe:true,direct:true,edit:Edit::Backspace},&h.settings,1,h.now*1000+6000);detector.event(Event{epoch:1,field:"editor".into(),app:"obsidian".into(),safe:true,direct:true,edit:Edit::Text("s".into())},&h.settings,1,h.now*1000+6100);detector.idle(h.now*1000+12000);let corrected=detector.take_passages().pop().unwrap();assert_eq!(corrected.id,id);h.write(&id,corrected.revision,&corrected.text);assert!(h.ready().iter().any(|row|row.text=="Heute geht es uber alles"&&row.count==2));}
}

#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn long_documents_are_processed_in_batches_and_do_not_flood_cards(){
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,native_capture:true,threshold:2,..Default::default()};let text=(0..420).map(|index|format!("word{index:04}")).collect::<Vec<_>>().join(" ");let mut longest=std::time::Duration::ZERO;let mut batches=0;
        for id in ["first","second"]{let mut work=store.begin_passage(PassageRevision{id:id.into(),revision:1,base:0,changed_from:0,text:text.clone(),at_ms:100000}).unwrap();loop{let start=std::time::Instant::now();let step=store.advance_passage(&mut work,&settings,100).unwrap();longest=longest.max(start.elapsed());batches+=1;if matches!(step,PassageProgress::Complete(_)){break;}}}
        assert!(batches>10);let rows=store.list(100,&settings).unwrap();assert!(!rows.is_empty());assert!(rows.len()<=5,"overlapping long windows produced {} cards",rows.len());assert!(longest<std::time::Duration::from_secs(2),"batch took {longest:?}");println!("passage batches={batches}, slowest={longest:?}");
    }
    #[test]
    fn verified_range_replacement_corrects_without_new_occurrences(){
        let settings=Settings{enabled:true,native_capture:true,..Default::default()};let mut detector=Detector::default();let event=|edit|Event{epoch:1,field:"field".into(),app:"obsidian".into(),safe:true,direct:true,edit};for c in "Heute geht es uber allex".chars(){detector.event(event(Edit::Text(c.into())),&settings,1,1000);}detector.idle(6000);let first=detector.take_passages().pop().unwrap();detector.event(event(Edit::Replace{start:19,end:24,text:"alles".into()}),&settings,1,7000);detector.idle(12000);let corrected=detector.take_passages().pop().unwrap();assert_eq!(first.id,corrected.id);assert_eq!(corrected.text,"Heute geht es uber alles");assert!(corrected.revision>first.revision);
        detector.event(event(Edit::Replace{start:0,end:9999,text:"bad".into()}),&settings,1,13000);assert!(detector.pending.is_empty());
    }
    #[test]
    fn rolling_window_is_bounded_and_preserves_overlap(){let settings=Settings{enabled:true,..Default::default()};let mut detector=Detector::default();let mut snapshots=vec![];for i in 0..5500{detector.event(Event{epoch:1,field:"one".into(),app:"editor".into(),safe:true,direct:true,edit:Edit::Text(if i%9==0{" "}else{"a"}.into())},&settings,1,1000+i);snapshots.extend(detector.take_passages());assert!(detector.pending.chars().count()<=4096);}detector.idle(13000);snapshots.extend(detector.take_passages());assert!(snapshots.len()>=2);assert!(snapshots.windows(2).all(|pair|pair[0].id==pair[1].id&&pair[0].base+pair[0].text.chars().count() as i64-pair[1].base>=1000));}
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn interrupted_analysis_keeps_previous_committed_counts(){let root=tempfile::tempdir().unwrap();let settings=Settings{enabled:true,threshold:2,..Default::default()};let store=Store::open(root.path()).unwrap();let revision=PassageRevision{id:"context".into(),revision:1,base:0,changed_from:0,text:"A previously committed useful closing.".into(),at_ms:100000};let mut first=store.begin_passage(revision).unwrap();while matches!(store.advance_passage(&mut first,&settings,100).unwrap(),PassageProgress::Pending){}let before:i64=store.connection.query_row("SELECT COUNT(*) FROM passage_receipts WHERE committed=1",[],|r|r.get(0)).unwrap();let text=(0..100).map(|i|format!("different{i}")).collect::<Vec<_>>().join(" ");let mut interrupted=store.begin_passage(PassageRevision{id:"context".into(),revision:2,base:0,changed_from:0,text,at_ms:110000}).unwrap();assert!(matches!(store.advance_passage(&mut interrupted,&settings,110).unwrap(),PassageProgress::Pending));drop(store);let store=Store::open(root.path()).unwrap();store.recover_passages().unwrap();assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM passage_receipts WHERE committed=1",[],|r|r.get::<_,i64>(0)).unwrap(),before);assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM passage_receipts WHERE committed=0",[],|r|r.get::<_,i64>(0)).unwrap(),0);}
    #[test]
    fn repeat_analysis_emits_no_changes_to_unaffected_cards(){let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,threshold:2,..Default::default()};let write=|id:&str,revision,text:&str|{let mut work=store.begin_passage(PassageRevision{id:id.into(),revision,base:0,changed_from:0,text:text.into(),at_ms:100000}).unwrap();loop{if let PassageProgress::Complete(changes)=store.advance_passage(&mut work,&settings,100).unwrap(){break changes;}}};write("one",1,"A useful recurring phrase");write("two",1,"A useful recurring phrase");let original=store.list(100,&settings).unwrap().remove(0);assert!(write("two",2,"A useful recurring phrase").is_empty());assert!(write("unrelated",1,"Completely unrelated words today").is_empty());assert_eq!(store.list(100,&settings).unwrap()[0].revision,original.revision);}
    #[test]
    fn same_phrase_twice_in_one_context_has_two_distinct_occurrences(){let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,threshold:2,..Default::default()};let mut work=store.begin_passage(PassageRevision{id:"one".into(),revision:1,base:0,changed_from:0,text:"me@email.com\nme@email.com".into(),at_ms:100000}).unwrap();while matches!(store.advance_passage(&mut work,&settings,100).unwrap(),PassageProgress::Pending){}let rows=store.list(100,&settings).unwrap();assert_eq!(rows.len(),1);assert_eq!(rows[0].text,"me@email.com");assert_eq!(rows[0].count,2);}
    #[test]
    fn protected_and_excluded_input_never_enters_passage_index(){let settings=Settings{enabled:true,native_capture:true,excluded_apps:vec!["excluded".into()],..Default::default()};for(app,safe)in [("excluded",true),("editor",false)]{let mut detector=Detector::default();for c in "This must remain private".chars(){detector.event(Event{epoch:1,field:"one".into(),app:app.into(),safe,direct:true,edit:Edit::Text(c.into())},&settings,1,1000);}detector.idle(10000);assert!(detector.take_passages().is_empty());assert!(detector.pending.is_empty());}}
}

#[cfg(test)]
mod rollover_tests {
    use super::*;
    #[test]
    fn passage_crossing_rolling_windows_counts_once_per_message(){
        let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,threshold:2,..Default::default()};let closing="I hope this help. Just reply and I'll help.";
        for (index,label) in ["alpha","bravo"].iter().enumerate(){let mut detector=Detector::default();let mut text=(0..480).map(|i|format!("{label}{i:03}")).collect::<Vec<_>>().join(" ");text.push_str("\n");text.push_str(closing);let mut revisions=vec![];for c in text.chars(){detector.event(Event{epoch:1,field:"editor".into(),app:"obsidian".into(),safe:true,direct:true,edit:Edit::Text(c.into())},&settings,1,100000+index as i64*10000);revisions.extend(detector.take_passages());}detector.idle(116000+index as i64*10000);revisions.extend(detector.take_passages());for revision in revisions{assert!(revision.text.chars().count()<=4096);let mut work=store.begin_passage(revision).unwrap();while matches!(store.advance_passage(&mut work,&settings,130).unwrap(),PassageProgress::Pending){}}}
        let rows=store.list(130,&settings).unwrap();let row=rows.iter().find(|row|row.text==closing).expect("closing across rolling window");assert_eq!(row.count,2);
    }
}

#[cfg(test)]
mod dismissal_tests {
    use super::*;
    #[test]
    fn migrated_dismissal_is_respected_by_incremental_changes(){let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();let settings=Settings{enabled:true,threshold:2,..Default::default()};let write=|id:&str|{let mut work=store.begin_passage(PassageRevision{id:id.into(),revision:1,base:0,changed_from:0,text:"A complete recurring closing.".into(),at_ms:100000}).unwrap();loop{if let PassageProgress::Complete(changes)=store.advance_passage(&mut work,&settings,100).unwrap(){break changes;}}};write("first");write("second");let row=store.list(100,&settings).unwrap().remove(0);store.action(&row.id,row.revision,"dismiss",100).unwrap();assert!(write("third").iter().all(|change|change.candidate.is_none()));assert!(store.list(100,&settings).unwrap().is_empty());}
}
