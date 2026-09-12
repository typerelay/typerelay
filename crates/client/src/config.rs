use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}};
use typerelay_core::{Snapshot, Snippet};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document { matches: Vec<Match> }

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Match { trigger: String, replace: String }

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
    last_bytes: Vec<u8>,
    pub snapshot: Snapshot,
}

impl FileStore {
    fn read(path: &Path) -> Result<Vec<u8>> {
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(1_048_577).read_to_end(&mut bytes)?;
        if bytes.len() > 1_048_576 { bail!("Snippet file exceeds 1 MiB"); }
        Ok(bytes)
    }

    fn parse(bytes: &[u8]) -> Result<Snapshot> {
        let document: Document = serde_saphyr::from_str(std::str::from_utf8(bytes)?).context("Invalid snippet YAML")?;
        Snapshot::new(document.matches.into_iter().map(|m| Snippet { trigger: m.trigger, replacement: m.replace }).collect()).map_err(anyhow::Error::msg)
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        let last_bytes = Self::read(&path)?;
        let snapshot = Self::parse(&last_bytes)?;
        Ok(Self { path, last_bytes, snapshot })
    }

    pub fn reload(&mut self) -> Result<Option<Snapshot>> {
        let bytes = Self::read(&self.path)?;
        if bytes == self.last_bytes { return Ok(None); }
        self.last_bytes = bytes;
        let snapshot = Self::parse(&self.last_bytes)?;
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
