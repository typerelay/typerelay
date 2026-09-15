//! Shared, offline-only search and immutable selection validation for desktop panels.
use crate::{database::Database, editor::Paths};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hit { pub id: String, pub library: String, pub library_name: String, pub revision: i64, pub title: String, pub abbreviation: String, pub preview: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PanelSettings { pub shortcut: String, pub launch_at_login: bool }
impl Default for PanelSettings { fn default() -> Self { Self { shortcut: "Ctrl+Shift+Semicolon".into(), launch_at_login: true } } }
pub struct Panel;
impl Panel {
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
    pub fn search(directory: &Path, query: &str) -> Result<Vec<Hit>> {
        let query = query.trim().to_lowercase(); if query.is_empty() { return Ok(Vec::new()); }
        ensure!(query.len() <= 512, "Search is too long");
        let db = Database::open(directory)?;
        let transaction = db.connection.unchecked_transaction()?;
        let mut ranked = Vec::new();
        for library in db.libraries()? {
            if library["state"] != "active" || library["permissions"]["read"] != true { continue; }
            let id = library["_id"].as_str().context("Invalid library ID")?;
            for entry in db.records(id)?.into_iter().filter(|entry| entry["state"] == "active") {
                let abbreviation = entry["trigger"].as_str().unwrap_or_default();
                let text = entry["content"]["text"].as_str().context("Missing snippet content")?;
                let needle = abbreviation.to_lowercase();
                let rank = if needle == query { 0 } else if needle.starts_with(&query) { 1 } else if needle.contains(&query) { 2 } else if text.to_lowercase().contains(&query) { 3 } else { continue; };
                ranked.push((rank, Hit { id: entry["id"].as_str().context("Missing snippet ID")?.into(), library: id.into(), library_name: library["name"].as_str().unwrap_or_default().into(), revision: entry["revision"].as_i64().context("Missing revision")?, title: entry["title"].as_str().unwrap_or_default().into(), abbreviation: abbreviation.into(), preview: text.chars().take(800).collect() }));
            }
        }
        transaction.commit()?;
        ranked.sort_by(|(a,x),(b,y)| a.cmp(b).then(x.abbreviation.cmp(&y.abbreviation)).then(x.library_name.cmp(&y.library_name)).then(x.id.cmp(&y.id)));
        Ok(ranked.into_iter().take(50).map(|(_, hit)|hit).collect())
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
    pub fn selected(directory: &Path, hit: &Hit) -> Result<String> { let content = Self::content(directory, hit)?; ensure!(content["type"] != "template", "Fill this template before copying/inserting"); Ok(content["text"].as_str().context("Missing text")?.into()) }
    pub fn render(directory: &Path, hit: &Hit, values: std::collections::BTreeMap<String,String>, preview: bool) -> Result<typerelay_core::template::Rendered> { Self::render_at(directory,hit,values,preview,crate::templates::Templates::clock()) }

    pub fn render_at(directory:&Path,hit:&Hit,values:std::collections::BTreeMap<String,String>,preview:bool,clock:(i64,i32))->Result<typerelay_core::template::Rendered>{crate::templates::Templates::render_at(&Self::content(directory,hit)?,values,preview,clock)}

}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_rank_optional_abbreviation_and_stale_selection() {
        let dir = tempfile::tempdir().unwrap(); let db = Database::open(dir.path()).unwrap();
        let file = db.import("Library", "matches: [{trigger: abc, replace: First}, {trigger: abcd, replace: Second}, {trigger: '', replace: ABC body}]").unwrap();
        let hits = Panel::search(dir.path(), "AbC").unwrap(); assert_eq!(hits.len(),3); assert_eq!(hits[0].abbreviation,"abc"); assert_eq!(hits[1].abbreviation,"abcd"); assert!(hits[2].abbreviation.is_empty());
        assert_eq!(Panel::selected(dir.path(),&hits[0]).unwrap(),"First"); db.edit(&file,Some(0),None).unwrap(); assert!(Panel::selected(dir.path(),&hits[0]).is_err());
        assert_eq!(Panel::search(dir.path(),"abc").unwrap().len(),2);
    }
    #[test]
    fn validates_shortcuts() { assert_eq!(PanelSettings::default().shortcut,"Ctrl+Shift+Semicolon");assert_eq!(Panel::shortcut("Ctrl+Shift+Semicolon").unwrap().0,39); for bad in ["Semicolon","Ctrl+Ctrl+A","Ctrl+Unknown", "Fake+A"] { assert!(Panel::shortcut(bad).is_err()); } }
}
