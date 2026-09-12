use crate::{config::{Document, FileStore, Match}, editor::EditorStore};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Deserialize)]
pub struct Request { pub yaml: String, #[serde(default)] pub edits: Vec<Edit> }
#[derive(Deserialize)]
pub struct Edit { pub index: Option<usize>, pub entry: Option<Match> }
#[derive(Serialize)]
pub struct Response { pub yaml: String, pub matches: Vec<Match> }
pub struct Bridge;
impl Bridge {
    pub fn execute(request: Request) -> Result<Response> {
        ensure!(request.yaml.len() <= 1_048_576, "Snippet file exceeds 1 MiB");
        FileStore::parse(request.yaml.as_bytes())?;
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("library.yml");
        fs::write(&path, &request.yaml)?;
        let store = EditorStore::new(directory.path().into())?;
        for edit in request.edits {
            let file = store.open("library.yml")?;
            if let Some(entry) = edit.entry { store.save(&file, edit.index, entry)?; }
            else {
                store.delete(&file, edit.index.context("Deletion requires an index")?)?;
            }
        }
        let yaml = fs::read_to_string(path)?;
        let document: Document = serde_saphyr::from_str(&yaml)?;
        Ok(Response { yaml, matches: document.matches })
    }
}
