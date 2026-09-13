use crate::{config::Match, database::Database};
use anyhow::{Context, Result};
use std::{fs, io::Write, path::{Path, PathBuf}};

pub struct Paths;
impl Paths {
    pub fn config_dir() -> Result<PathBuf> {
        let root = match std::env::var_os("XDG_CONFIG_HOME") {
            Some(path) => PathBuf::from(path),
            None => PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".config"),
        };
        Ok(root.join("typerelay"))
    }

    pub fn atomic_write(path: &Path, bytes: &[u8], new: bool) -> Result<()> {
        let parent = path.parent().context("Missing parent directory")?;
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        if !new && let Ok(metadata) = fs::metadata(path) { temporary.as_file().set_permissions(metadata.permissions())?; }
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        if new { temporary.persist_noclobber(path)?; } else { temporary.persist(path)?; }
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct OpenFile { pub name: String, pub entries: Vec<Match>, pub id: String, pub revision: i64, pub ids: Vec<String> }
impl OpenFile {
    pub fn search(&self, query: &str) -> Vec<usize> {
        let query = query.to_lowercase();
        self.entries.iter().enumerate().filter(|(_, entry)| entry.title.to_lowercase().contains(&query) || entry.trigger.to_lowercase().contains(&query) || entry.replace.to_lowercase().contains(&query)).map(|(index, _)| index).collect()
    }
}
pub struct EditorStore { pub directory: PathBuf }
impl EditorStore {
    pub fn new(directory: PathBuf) -> Result<Self> { Database::open(&directory)?.cleanup()?; Ok(Self { directory: directory.canonicalize()? }) }
    pub fn files(&self) -> Result<Vec<String>> { Database::open(&self.directory)?.names() }
    pub fn open(&self, name: &str) -> Result<OpenFile> { Database::open(&self.directory)?.editor(name) }
    pub fn create(&self, name: &str) -> Result<OpenFile> { Database::open(&self.directory)?.create(name) }
    pub fn save(&self, file: &OpenFile, index: Option<usize>, entry: Match) -> Result<OpenFile> { Database::open(&self.directory)?.edit(file, index, Some(entry)) }
    pub fn delete(&self, file: &OpenFile, index: usize) -> Result<OpenFile> { Database::open(&self.directory)?.edit(file, Some(index), None) }
    pub(crate) fn rewrite_entries(source: &str, updates: &[(usize, Match)]) -> Result<Vec<u8>> { crate::legacy_yaml::LegacyYaml::rewrite_entries(source, updates) }
}
