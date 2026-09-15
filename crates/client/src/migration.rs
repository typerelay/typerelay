use crate::{config::{Document, FileStore}, editor::{EditorStore, Paths}, settings::SettingsStore};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use std::{fs, path::{Path, PathBuf}, str::FromStr};

pub struct Migration;
#[derive(serde::Serialize)]
pub struct Report { pub files: usize, pub snippets: usize, pub backup: Option<PathBuf> }
struct Change { path: PathBuf, before: Option<Vec<u8>>, after: Vec<u8> }

impl Migration {
    pub fn run(path: &Path, settings_path: &Path, check: bool) -> Result<Report> {
        let root = if path.is_dir() { path } else { path.parent().context("Missing source parent")? };
        let _edit_lock = Self::lock(&root.join(".typerelay-edit.lock"), check)?;
        let settings = SettingsStore::open(settings_path.to_owned())?;
        let originals = FileStore::read_files(path, path.is_dir())?;
        let original_settings = match fs::read(settings_path) { Ok(bytes) => Some(bytes), Err(error) if error.kind() == std::io::ErrorKind::NotFound => None, Err(error) => return Err(error.into()) };
        let mut candidates = Vec::new();
        let mut changes = Vec::new();
        let mut count = 0;
        for (file, bytes) in &originals {
            let source = std::str::from_utf8(bytes)?;
            let document: Document = serde_saphyr::from_str(source)?;
            let mut expected = document.matches.clone();
            let mut updates = Vec::new();
            for (index, entry) in expected.iter_mut().enumerate() {
                if let Some(abbreviation) = entry.trigger.strip_prefix(',') {
                    entry.trigger = abbreviation.to_owned();
                    updates.push((index, entry.clone()));
                    count += 1;
                }
            }
            let candidate = if updates.is_empty() { bytes.clone() } else { EditorStore::rewrite_entries(source, &updates)? };
            let parsed: Document = serde_saphyr::from_str(std::str::from_utf8(&candidate)?)?;
            ensure!(parsed.matches == expected, "Migration changed unexpected snippet data in {}", file.display());
            candidates.push((file.clone(), candidate.clone()));
            if candidate != *bytes { changes.push(Change { path: file.clone(), before: Some(bytes.clone()), after: candidate }); }
        }
        FileStore::parse_files(&candidates)?;
        let settings_bytes = if let Some(bytes) = &original_settings {
            let yaml = yaml_edit::YamlFile::from_str(std::str::from_utf8(bytes)?)?;
            let document = yaml.documents().next().context("Expected settings mapping")?;
            let mapping = document.as_mapping().context("Expected settings mapping")?;
            if mapping.get("trigger_prefix").is_none() { mapping.set("trigger_prefix", settings.settings.trigger_prefix.as_str()); }
            yaml.to_string().into_bytes()
        } else { serde_saphyr::to_string(&settings.settings)?.into_bytes() };
        let parsed: crate::settings::Settings = serde_saphyr::from_str(std::str::from_utf8(&settings_bytes)?)?;
        ensure!(parsed == settings.settings, "Migration changed existing settings");
        if original_settings.as_ref() != Some(&settings_bytes) { changes.push(Change { path: settings_path.to_owned(), before: original_settings.clone(), after: settings_bytes }); }
        for change in &changes {
            ensure!(!change.path.is_symlink(), "Refusing to migrate symlink {}", change.path.display());
            if change.path.exists() { ensure!(!fs::metadata(&change.path)?.permissions().readonly(), "Read-only migration target {}", change.path.display()); }
        }
        let mut report = Report { files: changes.len(), snippets: count, backup: None };
        if check || changes.is_empty() { return Ok(report); }
        let settings_parent = settings_path.parent().context("Missing settings parent")?;
        fs::create_dir_all(settings_parent)?;
        let _settings_lock = Self::lock(&settings_path.with_extension("lock"), false)?;
        ensure!(FileStore::read_files(path, path.is_dir())? == originals && fs::read(settings_path).ok() == original_settings, "Files changed during migration; retry after closing other editors");
        let backups = settings_parent.join("backups");
        fs::create_dir_all(&backups)?;
        let backup = tempfile::Builder::new().prefix("prefix-migration-").tempdir_in(backups)?.keep();
        let mut manifest = Vec::new();
        for (index, change) in changes.iter().enumerate() {
            let saved = backup.join(format!("{index}.bak"));
            if let Some(before) = &change.before { Paths::atomic_write(&saved, before, true)?; }
            manifest.push(serde_json::json!({"path": change.path, "backup": change.before.as_ref().map(|_| saved)}));
        }
        Paths::atomic_write(&backup.join("manifest.json"), &serde_json::to_vec_pretty(&manifest)?, true)?;
        for (index, change) in changes.iter().enumerate() {
            if let Err(error) = Paths::atomic_write(&change.path, &change.after, change.before.is_none()) {
                for previous in changes[..index].iter().rev() {
                    let restored = if let Some(before) = &previous.before { Paths::atomic_write(&previous.path, before, false) } else { fs::remove_file(&previous.path).map_err(Into::into) };
                    restored.with_context(|| format!("Rollback failed; recover originals from {}", backup.display()))?;
                }
                return Err(error).context("Migration failed; completed writes rolled back");
            }
        }
        report.backup = Some(backup);
        Ok(report)
    }
    fn lock(path: &Path, check: bool) -> Result<Option<fs::File>> {
        if check { return Ok(None); }
        let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
        file.try_lock_exclusive().context("Another editor is saving; retry migration")?;
        Ok(Some(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrate_preserves_text_comments_settings_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let snippets = temp.path().join("snippets"); fs::create_dir(&snippets).unwrap();
        let file = snippets.join("mine.yml");
        let original = "# keep\nmatches:\n- trigger: ',naf' # signature\n  replace: |+\n    Regards,\n    Person\n\n";
        fs::write(&file, original).unwrap();
        let settings = temp.path().join("settings.yml"); fs::write(&settings, "# local\nsync_url: 'https://example.invalid/sync'\n").unwrap();
        assert_eq!(Migration::run(&snippets, &settings, true).unwrap().snippets, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        let report = Migration::run(&snippets, &settings, false).unwrap();
        assert_eq!(report.snippets, 1);
        assert_eq!(fs::read_to_string(report.backup.unwrap().join("0.bak")).unwrap(), original);
        let current = fs::read_to_string(&file).unwrap();
        assert!(current.contains("# keep") && current.contains("# signature") && current.contains("Regards,"));
        assert_eq!(FileStore::open(snippets.clone()).unwrap().snapshot.len(), 1);
        assert_eq!(SettingsStore::open(settings.clone()).unwrap().settings.trigger_prefix, ";");
        assert!(fs::read_to_string(&settings).unwrap().contains("# local"));
        assert_eq!(Migration::run(&snippets, &settings, false).unwrap().files, 0);
    }
    #[test]
    fn collisions_and_double_prefix_leave_everything_untouched() {
        for text in ["matches:\n- trigger: ',one'\n  replace: one\n- trigger: one\n  replace: two\n", "matches:\n- trigger: ',,one'\n  replace: one\n"] {
            let temp = tempfile::tempdir().unwrap(); let file = temp.path().join("test.yml"); let settings = temp.path().join("settings.yml");
            fs::write(&file, text).unwrap();
            assert!(Migration::run(&file, &settings, false).is_err());
            assert_eq!(fs::read_to_string(file).unwrap(), text);
            assert!(!settings.exists());
            assert!(!temp.path().join("backups").exists());
        }
    }
}
