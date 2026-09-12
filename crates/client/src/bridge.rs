use crate::{config::{Document, FileStore, Match}, editor::EditorStore};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, str::FromStr};

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
                let index = edit.index.context("Deletion requires an index")?;
                ensure!(index < file.entries.len(), "Snippet no longer exists");
                let source = fs::read_to_string(&path)?;
                let yaml = yaml_edit::YamlFile::from_str(&source)?;
                let document = yaml.documents().next().context("Missing document")?;
                let sequence = document.as_mapping().context("Missing mapping")?.get_sequence("matches").context("Missing matches")?;
                sequence.remove(index);
                let candidate = yaml.to_string();
                FileStore::parse(candidate.as_bytes())?;
                let parsed: Document = serde_saphyr::from_str(&candidate)?;
                let mut expected = file.entries;
                expected.remove(index);
                ensure!(parsed.matches == expected, "Cannot safely delete this YAML entry");
                fs::write(&path, candidate)?;
            }
        }
        let yaml = fs::read_to_string(path)?;
        let document: Document = serde_saphyr::from_str(&yaml)?;
        Ok(Response { yaml, matches: document.matches })
    }
}
