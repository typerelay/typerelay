//! Shared, offline-only search and immutable selection validation for desktop panels.
use crate::{database::Database, editor::Paths};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use base64::{Engine as _,engine::general_purpose::STANDARD};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hit { pub id: String, pub library: String, pub library_name: String, pub revision: i64, pub title: String, pub abbreviation: String, pub preview: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PanelSettings { pub shortcut: String, pub launch_at_login: bool, pub keyboard: String, pub keyboard_fallback: String }
impl Default for PanelSettings { fn default() -> Self { Self { shortcut: "Ctrl+Shift+Semicolon".into(), launch_at_login: true, keyboard: String::new(), keyboard_fallback: String::new() } } }
pub struct Panel;
impl Panel {
	pub fn conflicts(directory:&Path)->Result<serde_json::Value>{let db=Database::open(directory)?;let rows=db.meta("conflicts")?.and_then(|value|value.as_array().cloned()).unwrap_or_default().into_iter().map(|mut conflict|{let name=conflict["library"].as_str().and_then(|id|db.library(id).ok()).and_then(|library|library["name"].as_str().map(str::to_owned)).unwrap_or_else(||"Library".into());conflict["library_name"]=serde_json::json!(name);conflict}).collect::<Vec<_>>();Ok(serde_json::json!(rows))}
    pub fn libraries(directory:&Path)->Result<serde_json::Value> {
		let db=Database::open(directory)?;let transaction=db.connection.unchecked_transaction()?;let mut rows=Vec::new();let merging=db.pending_merges()?;let libraries=db.libraries()?;let synced=libraries.iter().filter_map(|library|library["_id"].as_str().map(|id|(id.to_owned(),db.synced(id).unwrap_or(false)))).collect::<std::collections::BTreeMap<_,_>>();for library in &libraries{if library["state"]!="active"{continue;}let id=library["_id"].as_str().context("Missing library ID")?;let snippets=db.records(id)?.iter().filter(|record|record["state"]=="active").count();let merge_pending=merging.contains(id);let source_synced=synced.get(id).copied().unwrap_or(false);let destination=libraries.iter().any(|candidate|{let candidate_id=candidate["_id"].as_str().unwrap_or("");candidate_id!=id&&candidate["state"]=="active"&&candidate["permissions"]["edit"]==true&&!merging.contains(candidate_id)&&!(source_synced&&!synced.get(candidate_id).copied().unwrap_or(false))});rows.push(serde_json::json!({"id":id,"name":library["name"],"synced":source_synced,"snippets":snippets,"can_merge":snippets>0&&library["permissions"]["manage"]==true&&!merge_pending&&destination,"merge_pending":merge_pending}));}
        transaction.commit()?;Ok(serde_json::json!(rows))
    }
	pub fn merge_destinations(directory:&Path,source:&str)->Result<serde_json::Value>{let db=Database::open(directory)?;let mut rows=Vec::new();for library in db.merge_destinations(source)?{let id=library["_id"].as_str().context("Missing library ID")?;rows.push(serde_json::json!({"id":id,"name":library["name"],"synced":db.synced(id)?,"snippets":db.records(id)?.iter().filter(|record|record["state"]=="active").count()}));}Ok(serde_json::json!(rows))}
    pub fn settings(root: &Path) -> Result<PanelSettings> {
        match fs::read(root.join("panel.json")) { Ok(bytes) => Ok(serde_json::from_slice(&bytes)?), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PanelSettings::default()), Err(error) => Err(error.into()) }
    }
    pub fn save_settings(root: &Path, settings: &PanelSettings) -> Result<()> { Self::shortcut(&settings.shortcut)?; Paths::atomic_write(&root.join("panel.json"), &serde_json::to_vec(settings)?, false) }
    /// Linux evdev codes and modifier groups; portable validation shares the same supported keys.
    pub fn shortcut(value: &str) -> Result<(u16, Vec<&'static [u16]>)> {
        let parts: Vec<_> = value.split('+').collect(); ensure!((2..=5).contains(&parts.len()), "Use modifiers plus one key, e.g. Ctrl+Shift+Semicolon");
        let mut modifiers: Vec<&'static [u16]> = Vec::new();
        for part in &parts[..parts.len()-1] { let keys: &'static [u16] = match *part { "Ctrl" | "Control" => &[29,97], "Shift" => &[42,54], "Alt" => &[56,100], "Super" | "Meta" => &[125,126], _ => anyhow::bail!("Unknown shortcut modifier") }; ensure!(!modifiers.contains(&keys), "Repeated shortcut modifier"); modifiers.push(keys); }
        let key = *parts.last().unwrap();
        let code = match key { "Comma" => 51, "Space" => 57, "Period" => 52, "Slash" => 53, "Semicolon" => 39, _ => {
            let names = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","0","1","2","3","4","5","6","7","8","9","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"];
            let codes = [30,48,46,32,18,33,34,35,23,36,37,38,50,49,24,25,16,19,31,20,22,47,17,45,21,44,11,2,3,4,5,6,7,8,9,10,59,60,61,62,63,64,65,66,67,68,87,88];
            codes[names.iter().position(|name| *name == key).context("Unsupported shortcut key; use A–Z, 0–9, F1–F12, Comma, Period, Slash, Semicolon or Space")?]
        }};
        Ok((code, modifiers))
    }
    fn typo_distance(left: &str, right: &str, limit: usize) -> usize {
        let left:Vec<_>=left.chars().collect();let right:Vec<_>=right.chars().collect();if left.len().abs_diff(right.len())>limit{return limit+1;}
        let mut previous:Vec<_>=(0..=right.len()).collect();let mut before=previous.clone();
        for(i,a)in left.iter().enumerate(){let mut current=vec![limit+1;right.len()+1];current[0]=i+1;for j in i.saturating_sub(limit)..right.len().min(i+limit+1){current[j+1]=(previous[j+1]+1).min(current[j]+1).min(previous[j]+usize::from(*a!=right[j]));if i>0&&j>0&&*a==right[j-1]&&left[i-1]==right[j]{current[j+1]=current[j+1].min(before[j-1]+1);}}if *current.iter().min().unwrap()>limit{return limit+1;}before=previous;previous=current;}
        previous[right.len()]
    }
    pub fn search(directory: &Path, query: &str, scope: Option<&str>) -> Result<Vec<Hit>> {
        let query=query.trim().to_lowercase();if query.is_empty(){return Ok(Vec::new());}ensure!(query.len()<=512,"Search is too long");
        let db=Database::open(directory)?;let transaction=loop{db.search_index()?;let transaction=db.connection.unchecked_transaction()?;if db.connection.query_row("SELECT built=version FROM search_state WHERE id=1",[],|row|row.get::<_,bool>(0))?{break transaction;}transaction.rollback()?;};
        db.connection.execute_batch("CREATE VIRTUAL TABLE temp.search_query USING fts5(text,tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE temp.query_vocab USING fts5vocab(search_query,'row');")?;db.connection.execute("INSERT INTO temp.search_query(text) VALUES(?1)",[&query])?;
        let tokens=db.connection.prepare("SELECT term FROM temp.query_vocab ORDER BY term")?.query_map([],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;ensure!(tokens.len()<=32,"Use at most 32 search words");if tokens.is_empty(){return Ok(Vec::new());}
        let mut values:Vec<rusqlite::types::Value>=vec![query.clone().into(),scope.map(str::to_owned).map(Into::into).unwrap_or(rusqlite::types::Value::Null)];let mut clauses=Vec::new();let mut counts=Vec::new();let mut exact=Vec::new();
        for token in tokens {
            let literal=format!("\"{}\"*",token.replace('"',"\"\""));values.push(literal.clone().into());exact.push(format!("(rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?{}))",values.len()));
            let length=token.chars().count();let limit=if length>=8{2}else if length>=4{1}else{0};let mut alternatives=vec![literal];
            if limit>0 {let mut statement=db.connection.prepare("SELECT term FROM search_vocab WHERE length(term) BETWEEN ?1 AND ?2")?;let candidates=statement.query_map(rusqlite::params![(length-limit) as i64,(length+limit) as i64],|row|row.get::<_,String>(0))?;let mut corrections=Vec::new();for term in candidates{let term=term?;let distance=Self::typo_distance(&token,&term,limit);if distance>0&&distance<=limit{corrections.push((distance,term));}}corrections.sort();for(_,term)in corrections.into_iter().take(8){alternatives.push(format!("\"{}\"",term.replace('"',"\"\"")));}}
            let clause=format!("({})",alternatives.join(" OR "));values.push(clause.clone().into());counts.push(format!("(rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?{}))",values.len()));clauses.push(clause);
        }
        values.push(clauses.join(" OR ").into());let sql=format!("SELECT id,library,library_name,revision,title,abbreviation,substr(body,1,800) FROM search_fts WHERE search_fts MATCH ?{} AND (?2 IS NULL OR library=?2) ORDER BY CASE WHEN lower(abbreviation)=?1 THEN 0 WHEN substr(lower(abbreviation),1,length(?1))=?1 THEN 1 WHEN instr(lower(title),?1)>0 OR instr(lower(body),?1)>0 THEN 2 ELSE 3 END, ({}) DESC, ({}) DESC, bm25(search_fts,0,0,0,0,10,5,1),id LIMIT 50",values.len(),counts.join("+"),exact.join("+"));
        let hits=db.connection.prepare(&sql)?.query_map(rusqlite::params_from_iter(values),|row|Ok(Hit{id:row.get(0)?,library:row.get(1)?,library_name:row.get(2)?,revision:row.get(3)?,title:row.get(4)?,abbreviation:row.get(5)?,preview:row.get(6)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;transaction.commit()?;Ok(hits)
    }
    pub fn personal_rows(directory: &Path, hits: &[Hit]) -> Result<serde_json::Value> {
        let db=Database::open(directory)?;let transaction=db.connection.unchecked_transaction()?;let mut rows=Vec::new();let mut records=std::collections::HashMap::new();let mut counts=std::collections::HashMap::<String,usize>::new();let mut libraries=std::collections::HashMap::new();
        for library in db.libraries()?.into_iter().filter(|library|library["state"]=="active"&&library["permissions"]["read"]==true){let id=library["_id"].as_str().context("Invalid library ID")?.to_owned();for record in db.effective_records(&id)?.into_iter().filter(|record|record["state"]=="active"){let trigger=record["effective_trigger"].as_str().unwrap_or("");if !trigger.is_empty(){*counts.entry(trigger.to_owned()).or_default()+=1;}records.insert((id.clone(),record["id"].as_str().unwrap_or("").to_owned()),record);}libraries.insert(id,library);}
        for hit in hits {
            let Some(library)=libraries.get(&hit.library)else{continue;};
            let Some(record)=records.get(&(hit.library.clone(),hit.id.clone())).filter(|record|record["revision"].as_i64()==Some(hit.revision))else{continue;};
            let mut value=serde_json::to_value(hit)?;
            value["abbreviation"]=serde_json::json!(record["effective_trigger"].as_str().unwrap_or_default()); value["shared_trigger"]=record["trigger"].clone(); value["personal"]=record["personal"].clone();
            value["can_personal"]=serde_json::json!(library["shared"]==true && library["permissions"]["edit"]==true && db.synced(&hit.library)? && db.meta("personal_capability")?==Some(serde_json::json!(1)));
            value["review_personal"]=serde_json::json!(record["personal"]["rejected"].is_object() || record["personal"]["conflicts"].as_array().is_some_and(|rows|!rows.is_empty()));
            value["abbreviation_collision"]=serde_json::json!(counts.get(record["effective_trigger"].as_str().unwrap_or("")).copied().unwrap_or(0)>1);
            rows.push(value);
        }
        transaction.commit()?; Ok(serde_json::json!(rows))
    }
    pub fn content(directory: &Path, hit: &Hit) -> Result<serde_json::Value> {
        let db = Database::open(directory)?;
        let transaction = db.connection.unchecked_transaction()?;
        let library = db.library(&hit.library)?;
        ensure!(library["state"] == "active" && library["permissions"]["read"] == true, "Library is no longer available");
        let records = db.records(&hit.library)?;
        let entry = records.iter().find(|entry|entry["id"] == hit.id && entry["state"] == "active").context("Snippet moved or was removed; search again")?;
        ensure!(entry["revision"] == hit.revision, "Snippet changed; search again");
        let content = entry["content"].clone();
        transaction.commit()?; Ok(content)
    }
    pub fn record_usage(directory: &Path, hit: &Hit, action: &str, client: &str, characters: usize) {
        if let Err(error) = Database::open(directory).and_then(|db| db.usage(&hit.library, &hit.id, action, client, characters)) { eprintln!("TypeRelay usage could not be queued: {error}"); }
    }
    pub fn usage_characters(steps: &[crate::clipboard_payload::ClipboardStep], erase: usize) -> usize { steps.iter().map(|step| match step { crate::clipboard_payload::ClipboardStep::Payload(payload) => payload.characters, crate::clipboard_payload::ClipboardStep::Enter => 0 }).sum::<usize>().saturating_sub(erase) }
    pub fn selected(directory: &Path, hit: &Hit) -> Result<String> { let content = Self::content(directory, hit)?; ensure!(content["type"] != "template", "Fill this template before copying/inserting"); Ok(content["text"].as_str().context("Missing text")?.into()) }
    pub fn render(directory: &Path, hit: &Hit, values: std::collections::BTreeMap<String,String>, preview: bool) -> Result<typerelay_core::template::Rendered> { Self::render_at(directory,hit,values,preview,crate::templates::Templates::clock()) }

    pub fn render_at(directory:&Path,hit:&Hit,values:std::collections::BTreeMap<String,String>,preview:bool,clock:(i64,i32))->Result<typerelay_core::template::Rendered>{crate::templates::Templates::render_at(&Self::content(directory,hit)?,values,preview,clock)}
	pub fn rich_render(directory:&Path,content:&serde_json::Value,values:std::collections::BTreeMap<String,String>,preview:bool,clock:(i64,i32))->Result<typerelay_core::rich_text::RichRendered>{ensure!(content["type"]=="rich_text","Snippet is not rich text");let db=Database::open(directory)?;let mut assets=std::collections::BTreeMap::new();for id in content["assets"].as_array().into_iter().flatten(){let id=id.as_str().context("Invalid asset ID")?;let(metadata,bytes)=db.asset(id)?.context("Rich-text image is unavailable")?;assets.insert(id.into(),format!("data:{};base64,{}",metadata["mime_type"].as_str().context("Missing asset MIME")?,STANDARD.encode(bytes)));}typerelay_core::rich_text::RichText::render(typerelay_core::rich_text::RichRequest{markdown:content["markdown"].as_str().context("Missing rich text")?.into(),variables:serde_json::from_value(content.get("variables").cloned().unwrap_or_else(||serde_json::json!({})))?,values,assets,now_ms:clock.0,offset_minutes:clock.1,preview}).map_err(anyhow::Error::msg)}
	pub fn rich_payload(directory:&Path,content:&serde_json::Value,values:std::collections::BTreeMap<String,String>,preview:bool)->Result<(typerelay_core::rich_text::RichRendered,crate::clipboard_payload::ClipboardPayload)>{let rendered=Self::rich_render(directory,content,values,preview,crate::templates::Templates::clock())?;let payload=crate::clipboard_payload::ClipboardPayload{characters:rendered.characters,plain:rendered.text.clone(),html:Some(rendered.html.clone()),rtf:Some(rendered.rtf.clone())};Ok((rendered,payload))}
	pub fn steps_at(directory:&Path,hit:&Hit,values:std::collections::BTreeMap<String,String>,preview:bool,clock:(i64,i32))->Result<Vec<crate::clipboard_payload::ClipboardStep>>{let content=Self::content(directory,hit)?;if content["type"]=="rich_text"{let rendered=Self::rich_render(directory,&content,values,preview,clock)?;Ok(rendered.steps.into_iter().map(|step|match step{typerelay_core::rich_text::RichStep::Content{text,html,rtf,characters,..}=>crate::clipboard_payload::ClipboardStep::Payload(crate::clipboard_payload::ClipboardPayload{characters,plain:text,html:Some(html),rtf:Some(rtf)}),typerelay_core::rich_text::RichStep::Enter=>crate::clipboard_payload::ClipboardStep::Enter}).collect())}else{Ok(crate::templates::Templates::render_at(&content,values,preview,clock)?.steps.into_iter().map(|step|match step{typerelay_core::template::Step::Text{text}=>crate::clipboard_payload::ClipboardStep::Payload(crate::clipboard_payload::ClipboardPayload::text(text)),typerelay_core::template::Step::Enter=>crate::clipboard_payload::ClipboardStep::Enter}).collect())}}

}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexed_words_typos_unicode_scope_and_refresh() {
        let temp=tempfile::tempdir().unwrap();let db=Database::open(temp.path()).unwrap();let local=db.import("Local","matches: [{trigger: missed, title: Missed meeting, replace: Please reschedule our meeting}, {trigger: cafe, replace: Café résumé}]").unwrap();let other=db.import("Other","matches: [{trigger: other, replace: Missed meeting elsewhere}]").unwrap();
        for query in ["meeting missed","meeitng","reschedlue","cafe resume",r#""meeting" OR :*"#] {assert!(!Panel::search(temp.path(),query,Some(&local.id)).unwrap().is_empty(),"{query}");}
        assert_eq!(Panel::search(temp.path(),"missed",None).unwrap()[0].abbreviation,"missed");assert!(Panel::search(temp.path(),"meeting",Some(&local.id)).unwrap().iter().all(|hit|hit.library==local.id));
        let before:i64=db.connection.query_row("SELECT built FROM search_state",[],|r|r.get(0)).unwrap();Panel::search(temp.path(),"meeting",None).unwrap();assert_eq!(db.connection.query_row("SELECT built FROM search_state",[],|r|r.get::<_,i64>(0)).unwrap(),before);
        db.connection.execute("UPDATE libraries SET synced=1,data=json_set(data,'$.shared',json('true')) WHERE id=?1",[&local.id]).unwrap();db.set_meta("personal_abbreviations",&serde_json::json!([{ "snippet":local.ids[0],"trigger":"mine","revision":1 }])).unwrap();assert_eq!(Panel::search(temp.path(),"mine",Some(&local.id)).unwrap()[0].abbreviation,"mine");
        db.edit(&local,Some(0),None).unwrap();assert!(Panel::search(temp.path(),"meeting",Some(&local.id)).unwrap().is_empty());
        db.connection.execute("UPDATE libraries SET data=json_set(data,'$.permissions.read',json('false')) WHERE id=?1",[other.id]).unwrap();assert!(Panel::search(temp.path(),"meeting",None).unwrap().is_empty());
        assert!(!temp.path().join("native-ai/endpoint.json").exists());
    }
    #[test]
    fn indexed_scope_precedes_limit() {
        let temp=tempfile::tempdir().unwrap();let db=Database::open(temp.path()).unwrap();let entries:Vec<_>=(0..70).map(|n|serde_json::json!({"trigger":format!("a{n}"),"replace":"Meeting"})).collect();let other=db.import("Other",&serde_json::json!({"matches":entries}).to_string()).unwrap();let local=db.import("Selected","matches: [{trigger: z, replace: Meeting}]").unwrap();assert_eq!(Panel::search(temp.path(),"meeting",None).unwrap().len(),50);assert_eq!(Panel::search(temp.path(),"meeting",Some(&local.id)).unwrap().len(),1);db.edit_move(&local,0,local.entries[0].clone(),&other.id).unwrap();assert!(Panel::search(temp.path(),"meeting",Some(&local.id)).unwrap().is_empty());assert_eq!(Panel::search(temp.path(),"z",Some(&other.id)).unwrap()[0].library,other.id);
    }
    #[test]
    fn library_inventory_includes_synced_and_local_libraries_with_active_counts() {
        let dir=tempfile::tempdir().unwrap();let db=Database::open(dir.path()).unwrap();
        let synced=db.import("mysnippets.yml","matches: [{trigger: rw, replace: First}, {trigger: old, replace: Old}]").unwrap();
        db.edit(&synced,Some(1),None).unwrap();db.connection.execute("UPDATE libraries SET synced=1 WHERE id=?1",[&synced.id]).unwrap();
        db.import("test","matches: [{trigger: local, replace: Local}]").unwrap();
        let rows=Panel::libraries(dir.path()).unwrap();let rows=rows.as_array().unwrap();assert_eq!(rows.len(),2);
        let row=rows.iter().find(|row|row["id"]==synced.id).unwrap();assert_eq!(row["name"],"mysnippets.yml");assert_eq!(row["synced"],true);assert_eq!(row["snippets"],1);
        assert_eq!(rows.iter().find(|row|row["name"]=="test").unwrap()["synced"],false);
    }
    #[test]
    fn search_rank_optional_abbreviation_and_stale_selection() {
        let dir = tempfile::tempdir().unwrap(); let db = Database::open(dir.path()).unwrap();
        let file = db.import("Library", "matches: [{trigger: abc, replace: First}, {trigger: abcd, replace: Second}, {trigger: '', replace: ABC body}]").unwrap();
        let hits = Panel::search(dir.path(), "AbC", None).unwrap(); assert_eq!(hits.len(),3); assert_eq!(hits[0].abbreviation,"abc"); assert_eq!(hits[1].abbreviation,"abcd"); assert!(hits[2].abbreviation.is_empty());
        assert_eq!(Panel::selected(dir.path(),&hits[0]).unwrap(),"First"); db.edit(&file,Some(0),None).unwrap(); assert!(Panel::selected(dir.path(),&hits[0]).is_err());
        assert_eq!(Panel::search(dir.path(),"abc", None).unwrap().len(),2);
    }
    #[test]
    fn personal_refresh_preserves_search_hits_without_abbreviations() {
        let dir=tempfile::tempdir().unwrap();let db=Database::open(dir.path()).unwrap();
        let file=db.import("Library","matches: [{trigger: '', replace: Searchable body}]").unwrap();
        db.connection.execute("UPDATE snippets SET data=json_set(data,'$.trigger',NULL) WHERE library=?1",[&file.id]).unwrap();
        let hits=Panel::search(dir.path(),"Searchable", None).unwrap();assert_eq!(hits.len(),1);
        let rows=Panel::personal_rows(dir.path(),&hits).unwrap();let refreshed:Vec<Hit>=serde_json::from_value(rows).unwrap();
        assert_eq!(refreshed[0].abbreviation,"");assert_eq!(Panel::selected(dir.path(),&refreshed[0]).unwrap(),"Searchable body");
        assert!(serde_json::from_value::<Vec<Hit>>(Panel::personal_rows(dir.path(),&refreshed).unwrap()).is_ok());
    }
    #[test]
    fn keyboard_settings_migrate_and_survive_restart() {
        let root=tempfile::tempdir().unwrap();fs::write(root.path().join("panel.json"),br#"{"shortcut":"Ctrl+Shift+Semicolon","launch_at_login":false}"#).unwrap();
        let mut settings=Panel::settings(root.path()).unwrap();assert!(settings.keyboard.is_empty());settings.keyboard="Any USB keyboard".into();Panel::save_settings(root.path(),&settings).unwrap();
        let saved=Panel::settings(root.path()).unwrap();assert_eq!(saved.keyboard,"Any USB keyboard");assert_eq!(saved.shortcut,settings.shortcut);assert!(!saved.launch_at_login);
    }
    #[test]
    fn validates_shortcuts() { assert_eq!(PanelSettings::default().shortcut,"Ctrl+Shift+Semicolon");assert_eq!(Panel::shortcut("Ctrl+Shift+Semicolon").unwrap().0,39); for bad in ["Semicolon","Ctrl+Ctrl+A","Ctrl+Unknown", "Fake+A"] { assert!(Panel::shortcut(bad).is_err()); } }
}
