use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}};
use typerelay_core::{Snapshot, Snippet};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document { pub matches: Vec<Match> }

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Match { pub trigger: String, pub replace: String }

#[derive(Deserialize)]
struct LegacyDocument { matches: Vec<LegacyMatch> }

#[derive(Deserialize)]
struct LegacyMatch {
    trigger: Option<String>,
    replace: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

pub struct FileStore {
    path: PathBuf,
    directory: bool,
    last_files: Vec<(PathBuf, Vec<u8>)>,
    pub snapshot: Snapshot,
}

impl FileStore {
    pub(crate) fn read(path: &Path) -> Result<Vec<u8>> {
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(1_048_577).read_to_end(&mut bytes)?;
        if bytes.len() > 1_048_576 { bail!("Snippet file exceeds 1 MiB"); }
        Ok(bytes)
    }

    pub(crate) fn parse(bytes: &[u8]) -> Result<Snapshot> {
        Self::parse_files(&[(PathBuf::from("snippet file"), bytes.to_vec())])
    }

    pub(crate) fn parse_files(files: &[(PathBuf, Vec<u8>)]) -> Result<Snapshot> {
        let mut snippets = Vec::new();
        let mut origins = BTreeMap::new();
        for (path, bytes) in files {
            let document: Document = serde_saphyr::from_str(std::str::from_utf8(bytes)?).with_context(|| format!("Invalid YAML in {}", path.display()))?;
            for entry in document.matches {
                if let Some(previous) = origins.insert(entry.trigger.clone(), path) { bail!("Duplicate trigger '{}' in {} and {}", entry.trigger, previous.display(), path.display()); }
                snippets.push(Snippet { trigger: entry.trigger, replacement: entry.replace });
            }
        }
        Snapshot::new(snippets).map_err(anyhow::Error::msg)
    }

    pub(crate) fn read_files(path: &Path, directory: bool) -> Result<Vec<(PathBuf, Vec<u8>)>> {
        let mut paths = Vec::new();
        if directory {
            for entry in fs::read_dir(path).with_context(|| format!("Cannot read snippet directory {}", path.display()))? {
                let entry = entry?;
                let path = entry.path();
                if entry.file_type()?.is_file() && matches!(path.extension().and_then(|s| s.to_str()), Some("yml" | "yaml")) { paths.push(path); }
            }
            paths.sort();
            if paths.len() > 256 { bail!("Snippet directory exceeds 256 files"); }
        } else { paths.push(path.to_owned()); }
        let mut files = Vec::new();
        let mut total = 0;
        for path in paths {
            let bytes = Self::read(&path).with_context(|| format!("Cannot read {}", path.display()))?;
            total += bytes.len();
            if total > 8 * 1024 * 1024 { bail!("Combined snippet files exceed 8 MiB"); }
            files.push((path, bytes));
        }
        Ok(files)
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        let directory = path.is_dir();
        let last_files = Self::read_files(&path, directory)?;
        let snapshot = Self::parse_files(&last_files)?;
        Ok(Self { path, directory, last_files, snapshot })
    }

    pub fn reload(&mut self) -> Result<Option<Snapshot>> {
        let files = Self::read_files(&self.path, self.directory)?;
        if files == self.last_files { return Ok(None); }
        self.last_files = files;
        let snapshot = Self::parse_files(&self.last_files)?;
        self.snapshot = snapshot.clone();
        Ok(Some(snapshot))
    }

    pub fn import(source: &Path, destination: &Path) -> Result<()> {
        let document: LegacyDocument = serde_saphyr::from_str(std::str::from_utf8(&Self::read(source)?)?)?;
        let mut matches = Vec::new();
        let mut skipped = 0;
        for (index, entry) in document.matches.into_iter().enumerate() {
            let Some(trigger) = entry.trigger else { eprintln!("Skipped entry {}: missing simple trigger", index + 1); skipped += 1; continue; };
            let Some(replace) = entry.replace else { eprintln!("Skipped entry {}: missing static replacement", index + 1); skipped += 1; continue; };
            let normalized = format!(",{}", trigger.trim_start_matches([';', ':', ',']));
            let invalid = Snapshot::new(vec![Snippet { trigger: normalized.clone(), replacement: replace.clone() }]).is_err();
            let supported_options = entry.extra.iter().all(|(key, value)| key == "force_mode" && value.as_str() == Some("clipboard"));
            if invalid || !supported_options {
                eprintln!("Skipped entry {}: unsupported content or options", index + 1);
                skipped += 1;
                continue;
            }
            matches.push(Match { trigger: normalized, replace });
        }
        let output = Document { matches };
        let yaml = serde_saphyr::to_string(&output)?;
        Self::parse(yaml.as_bytes())?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(destination).context("Destination must not already exist")?;
        file.write_all(yaml.as_bytes())?;
        file.sync_all()?;
        println!("Imported {} static snippets with comma prefixes; skipped {skipped}. Source unchanged.", output.matches.len());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_reload_add_edit_remove_and_duplicate_recovery() {
        let directory = std::env::temp_dir().join(format!("typerelay-directory-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let personal = directory.join("mysnippets.yml");
        let sales = directory.join("sales.yaml");
        fs::write(&personal, "matches:\n- trigger: ',mine'\n  replace: personal\n").unwrap();
        fs::write(directory.join("ignored.txt"), "not YAML").unwrap();
        let mut store = FileStore::open(directory.clone()).unwrap();
        assert_eq!(store.snapshot.len(), 1);
        fs::write(&sales, "matches:\n- trigger: ',sale'\n  replace: sales\n").unwrap();
        assert_eq!(store.reload().unwrap().unwrap().len(), 2);
        fs::write(&sales, "matches:\n- trigger: ',mine'\n  replace: duplicate\n").unwrap();
        let error = store.reload().unwrap_err().to_string();
        assert!(error.contains("mysnippets.yml") && error.contains("sales.yaml") && error.contains(",mine"));
        assert_eq!(store.snapshot.len(), 2);
        fs::write(&sales, "matches:\n- trigger: ',sale'\n  replace: updated\n").unwrap();
        let mut engine = typerelay_core::Engine::new(store.reload().unwrap().unwrap());
        for c in ",sale".chars() { engine.feed(typerelay_core::Input::Character(c)); }
        assert_eq!(engine.feed(typerelay_core::Input::Space).unwrap().text, "updated");
        fs::remove_file(sales).unwrap();
        assert_eq!(store.reload().unwrap().unwrap().len(), 1);
        fs::remove_file(personal).unwrap();
        assert!(store.reload().unwrap().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn rejects_dynamic_and_unknown_yaml() {
        assert!(FileStore::parse(b"matches:\n  - trigger: ',a'\n    replace: ok\n    vars: []\n").is_err());
        assert!(FileStore::parse(b"matches:\n  - trigger: ',a'\n    replace: ok\n").is_ok());
    }
    #[test]
    fn yaml_block_scalar_keeps_linebreaks() {
        let snapshot = FileStore::parse(b"matches:\n  - trigger: ',naf'\n    replace: |\n      Sincerely,\n      Nitai\n\n      Ceo & Founder\n").unwrap();
        let mut engine = typerelay_core::Engine::new(snapshot);
        for c in ",naf".chars() { engine.feed(typerelay_core::Input::Character(c)); }
        assert_eq!(engine.feed(typerelay_core::Input::Space).unwrap().text, "Sincerely,\nNitai\n\nCeo & Founder\n");
    }
    #[test]
    fn invalid_reload_preserves_previous_snapshot_and_recovers() {
        let path = std::env::temp_dir().join(format!("typerelay-test-{}.yml", std::process::id()));
        fs::write(&path, "matches:\n  - trigger: ',a'\n    replace: ok\n").unwrap();
        let mut store = FileStore::open(path.clone()).unwrap();
        fs::write(&path, "bad yaml [").unwrap();
        assert!(store.reload().is_err());
        assert_eq!(store.snapshot.len(), 1);
        assert!(store.reload().unwrap().is_none());
        fs::write(&path, "matches: []").unwrap();
        assert!(store.reload().unwrap().unwrap().is_empty());
        fs::remove_file(path).unwrap();
    }
}
