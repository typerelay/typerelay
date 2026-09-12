use crate::editor::Paths;
use anyhow::{Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use typerelay_core::Engine;
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings { pub sync_url: String, pub trigger_prefix: String }
impl Default for Settings { fn default() -> Self { Self { sync_url: String::new(), trigger_prefix: Engine::DEFAULT_PREFIX.to_string() } } }

pub struct SettingsStore { path: PathBuf, original: Option<Vec<u8>>, pub settings: Settings }
impl SettingsStore {
    pub fn config_dir(&self) -> &std::path::Path { self.path.parent().unwrap_or(std::path::Path::new(".")) }
    pub fn open(path: PathBuf) -> Result<Self> {
        let original = match fs::read(&path) { Ok(bytes) => Some(bytes), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(e.into()) };
        let settings: Settings = if let Some(bytes) = &original { serde_saphyr::from_str(std::str::from_utf8(bytes)?)? } else { Settings::default() };
        Engine::validate_prefix(&settings.trigger_prefix).map_err(anyhow::Error::msg)?;
        Ok(Self { path, original, settings })
    }
    pub fn reload(&mut self) -> Result<bool> { let next = Self::open(self.path.clone())?; let changed = next.settings != self.settings; *self = next; Ok(changed) }
    pub fn save(&mut self, value: &str, prefix: &str) -> Result<()> {
        Engine::validate_prefix(prefix).map_err(anyhow::Error::msg)?;
        let value = value.trim();
        if !value.is_empty() {
            let url = url::Url::parse(value)?;
            ensure!(matches!(url.scheme(), "http" | "https") && url.host_str().is_some(), "Use an absolute HTTP(S) URL");
        }
        fs::create_dir_all(self.path.parent().unwrap())?;
        let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(self.path.with_extension("lock"))?;
        lock.try_lock_exclusive()?;
        let current = Self::open(self.path.clone())?;
        ensure!(current.original == self.original, "Settings changed externally; reopen Settings before saving");
        let settings = Settings { sync_url: value.into(), trigger_prefix: prefix.into() };
        let bytes = serde_saphyr::to_string(&settings)?.into_bytes();
        Paths::atomic_write(&self.path, &bytes, false)?;
        self.original = Some(bytes);
        self.settings = settings;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_validate_persist_clear_and_detect_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.yml");
        let mut settings = SettingsStore::open(path.clone()).unwrap();
        assert!(settings.save("file:///tmp/snippets", ",").is_err());
        assert!(!path.exists());
        settings.save("https://example.invalid/sync", ",").unwrap();
        assert_eq!(SettingsStore::open(path.clone()).unwrap().settings.sync_url, "https://example.invalid/sync");
        let mut second = SettingsStore::open(path.clone()).unwrap();
        settings.save("", ",").unwrap();
        assert!(second.save("https://elsewhere.invalid", ",").is_err());
        assert_eq!(SettingsStore::open(path).unwrap().settings.sync_url, "");
    }
    #[test]
    fn prefix_is_local_validated_and_reloaded() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("settings.yml");
        fs::write(&path, "sync_url: https://example.invalid/sync\n").unwrap();
        let mut reader = SettingsStore::open(path.clone()).unwrap();
        assert_eq!(reader.settings.trigger_prefix, ",");
        let mut writer = SettingsStore::open(path.clone()).unwrap();
        writer.save("https://example.invalid/sync", ";").unwrap();
        assert!(reader.reload().unwrap()); assert_eq!(reader.settings.trigger_prefix, ";");
        assert!(!reader.reload().unwrap());
        assert!(writer.save("https://example.invalid/sync", "bad").is_err());
        assert_eq!(SettingsStore::open(path).unwrap().settings.trigger_prefix, ";");
    }
}
