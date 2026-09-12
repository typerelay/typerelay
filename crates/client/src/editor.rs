use crate::config::{Document, FileStore, Match};
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use std::{fs, io::Write, path::{Path, PathBuf}, str::FromStr};

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
pub struct OpenFile {
    pub name: String,
    pub entries: Vec<Match>,
    original: Vec<u8>,
}

impl OpenFile {
    pub fn search(&self, query: &str) -> Vec<usize> {
        let query = query.to_lowercase();
        self.entries.iter().enumerate().filter(|(_, entry)| entry.trigger.to_lowercase().contains(&query) || entry.replace.to_lowercase().contains(&query)).map(|(index, _)| index).collect()
    }
}

pub struct EditorStore { pub directory: PathBuf }
impl EditorStore {
    pub fn new(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory)?;
        Ok(Self { directory: directory.canonicalize()? })
    }

    pub fn files(&self) -> Result<Vec<String>> {
        Ok(FileStore::read_files(&self.directory, true)?.iter().filter_map(|(path, _)| path.file_name()?.to_str().map(str::to_owned)).collect())
    }

    fn path(&self, name: &str) -> Result<PathBuf> {
        ensure!(!name.is_empty() && !name.contains(['/', '\\']) && matches!(Path::new(name).extension().and_then(|s| s.to_str()), Some("yml" | "yaml")), "Use a filename ending in .yml or .yaml, without directories");
        let path = self.directory.join(name);
        ensure!(!path.is_symlink(), "Symlink snippet files cannot be edited");
        Ok(path)
    }

    fn lock(&self) -> Result<fs::File> {
        let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(self.directory.join(".typerelay-edit.lock"))?;
        file.try_lock_exclusive().context("Another editor is saving; try again")?;
        Ok(file)
    }

    pub fn open(&self, name: &str) -> Result<OpenFile> {
        let original = FileStore::read(&self.path(name)?)?;
        FileStore::parse(&original)?;
        let document: Document = serde_saphyr::from_str(std::str::from_utf8(&original)?)?;
        Ok(OpenFile { name: name.to_owned(), entries: document.matches, original })
    }

    pub fn create(&self, name: &str) -> Result<OpenFile> {
        let name = if Path::new(name).extension().is_none() { format!("{name}.yml") } else { name.to_owned() };
        let path = self.path(&name)?;
        let _lock = self.lock()?;
        let mut files = FileStore::read_files(&self.directory, true)?;
        ensure!(!path.exists(), "File already exists");
        ensure!(files.len() < 256, "Snippet directory exceeds 256 files");
        files.push((path.clone(), b"matches: []\n".to_vec()));
        FileStore::parse_files(&files)?;
        Paths::atomic_write(&path, b"matches: []\n", true)?;
        self.open(&name)
    }

    pub(crate) fn rewrite_entries(source: &str, updates: &[(usize, Match)]) -> Result<Vec<u8>> {
        use yaml_edit::AsYaml;
        let original: Document = serde_saphyr::from_str(source)?;
        let yaml = yaml_edit::YamlFile::from_str(source)?;
        let document = yaml.documents().next().context("Expected YAML document")?;
        let matches = document.as_mapping().context("Expected mapping")?.get_sequence("matches").context("Expected matches sequence")?;
        let mut edits = Vec::new();
        for (index, entry) in updates {
            let mapping = matches.get(*index).and_then(|node| node.as_mapping().cloned()).context("Snippet no longer exists")?;
            let previous = original.matches.get(*index).context("Snippet no longer exists")?;
            for (key, value, old) in [("trigger", &entry.trigger, &previous.trigger), ("replace", &entry.replace, &previous.replace)] {
                if value == old { continue; }
                let node = mapping.get(key).context("Missing field")?;
                ensure!(node.as_scalar().is_some(), "Only direct scalar fields can be edited; resolve YAML aliases first");
                let range = node.as_node().context("Missing source range")?.text_range();
                let start: usize = range.start().into();
                let end: usize = range.end().into();
                let original = &source[start..end];
                let mut replacement = serde_json::to_string(value)?;
                if original.starts_with(['|', '>']) {
                    if let Some(comment) = original.lines().next().and_then(|line| line.find('#').map(|at| &line[at..])) { replacement.push(' '); replacement.push_str(comment); }
                    if original.ends_with('\n') { replacement.push('\n'); }
                }
                edits.push((start, end, replacement));
            }
        }
            edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
            let mut candidate = source.to_owned();
            for (start, end, replacement) in edits { candidate.replace_range(start..end, &replacement); }
            Ok(candidate.into_bytes())
    }

    pub fn save(&self, file: &OpenFile, index: Option<usize>, entry: Match) -> Result<OpenFile> {
        let _lock = self.lock()?;
        let path = self.path(&file.name)?;
        ensure!(!fs::metadata(&path)?.permissions().readonly(), "File is read-only; draft kept");
        let observed = FileStore::read_files(&self.directory, true)?;
        ensure!(observed.iter().any(|(p, bytes)| p == &path && bytes == &file.original), "File changed outside the TUI. Draft kept; reopen the file before applying your changes");
        use yaml_edit::AsYaml;
        let source = std::str::from_utf8(&file.original)?;
        let yaml = yaml_edit::YamlFile::from_str(source)?;
        let document = yaml.documents().next().context("Expected one YAML document")?;
        let matches = document.as_mapping().context("Expected YAML mapping")?.get_sequence("matches").context("Expected matches sequence")?;
        let candidate = if let Some(index) = index {
            Self::rewrite_entries(source, &[(index, entry.clone())])?
        } else {
            let encoded = serde_json::to_string(&entry)?;
            let sequence = matches.as_node().context("Missing sequence source range")?;
            if sequence.to_string().trim_start().starts_with('[') {
                let node = yaml_edit::Document::from_str(&encoded)?.as_mapping().context("Cannot encode snippet")?;
                matches.push(node);
                yaml.to_string().into_bytes()
            } else {
                // Preserve the actual dash column, including valid indentless YAML lists.
                let first = matches.get(0).context("Expected sequence item")?;
                let first_start: usize = first.as_node().context("Missing item range")?.text_range().start().into();
                let line_start = source[..first_start].rfind('\n').map_or(0, |at| at + 1);
                let line = &source[line_start..];
                let indentation = line.len() - line.trim_start_matches([' ', '\t']).len();
                ensure!(line[indentation..].starts_with('-'), "Cannot determine sequence indentation; original file unchanged");
                let mut end: usize = sequence.text_range().end().into();
                if source[end..].starts_with("\r\n") { end += 2; } else if source[end..].starts_with('\n') { end += 1; }
                let newline = if source.contains("\r\n") { "\r\n" } else { "\n" };
                let separator = if source[..end].ends_with('\n') { "" } else { newline };
                let addition = format!("{separator}{}- {encoded}{newline}", " ".repeat(indentation));
                let mut candidate = source.to_owned();
                candidate.insert_str(end, &addition);
                candidate.into_bytes()
            }
        };
        ensure!(candidate.len() <= 1_048_576, "Snippet file exceeds 1 MiB");
        let mut files = observed.clone();
        *files.iter_mut().find(|(p, _)| p == &path).context("File removed")? = (path.clone(), candidate.clone());
        ensure!(files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() <= 8 * 1024 * 1024, "Combined files exceed 8 MiB");
        FileStore::parse_files(&files)?;
        let parsed: Document = serde_saphyr::from_str(std::str::from_utf8(&candidate)?)?;
        let mut expected = file.entries.clone();
        if let Some(index) = index { expected[index] = entry; } else { expected.push(entry); }
        ensure!(parsed.matches == expected, "Lossless editor could not preserve snippet values; original file unchanged");
        if FileStore::read_files(&self.directory, true)? != observed { bail!("Snippet files changed during save; draft kept"); }
        Paths::atomic_write(&path, &candidate, false)?;
        self.open(&file.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn append_to_indentless_sequence_after_quoted_multiline_value() {
        let temp = tempfile::tempdir().unwrap();
        let store = EditorStore::new(temp.path().into()).unwrap();
        let original = "matches:\n- trigger: 'hth'\n  replace: 'First line\n\n    Second line\n\n\n    '\n";
        fs::write(temp.path().join("imported.yml"), original).unwrap();
        let file = store.open("imported.yml").unwrap();
        let saved = store.save(&file, None, Match { trigger: "hth2".into(), replace: "This is new for everyone".into() }).unwrap();
        assert_eq!(saved.entries.len(), 2);
        assert_eq!(saved.entries[0], file.entries[0]);
        assert!(fs::read_to_string(temp.path().join("imported.yml")).unwrap().starts_with(original));
    }
    #[test]
    fn append_handles_indentation_flow_and_document_endings() {
        for original in [
            "matches:\n- trigger: 'old'\n  replace: old",
            "matches:\n    - trigger: 'old'\n      replace: old\n",
            "matches:\r\n- trigger: 'old'\r\n  replace: old\r\n",
            "---\nmatches:\n- trigger: 'old'\n  replace: old\n...\n# footer\n",
            "matches: [{trigger: 'old', replace: old}] # keep\n",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let store = EditorStore::new(temp.path().into()).unwrap();
            fs::write(temp.path().join("test.yml"), original).unwrap();
            let file = store.open("test.yml").unwrap();
            let saved = store.save(&file, None, Match { trigger: "new".into(), replace: "New\nparagraph\n".into() }).unwrap();
            assert_eq!(saved.entries.len(), 2);
            assert_eq!(saved.entries[0], file.entries[0]);
            if original.contains("# footer") { assert!(fs::read_to_string(temp.path().join("test.yml")).unwrap().ends_with("...\n# footer\n")); }
        }
    }
    #[test]
    fn lossless_save_search_and_external_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let store = EditorStore::new(temp.path().into()).unwrap();
        let original = "# my notes\nmatches:\n  # greeting\n  - trigger: 'hi' # shorthand\n    replace: 'Hello'\n  # keep this exactly\n  - trigger: 'other'\n    replace: |+\n      Unchanged\n\n";
        fs::write(temp.path().join("mine.yml"), original).unwrap();
        let file = store.open("mine.yml").unwrap();
        assert_eq!(file.search("HELLO"), vec![0]);
        assert_eq!(file.search("other"), vec![1]);
        let file = store.save(&file, Some(0), Match { trigger: "hi".into(), replace: "Hello\n\nCafé\tworld\n\n".into() }).unwrap();
        let text = fs::read_to_string(temp.path().join("mine.yml")).unwrap();
        assert!(text.contains("# my notes") && text.contains("# greeting") && text.contains("# shorthand"));
        assert!(text.ends_with("  # keep this exactly\n  - trigger: 'other'\n    replace: |+\n      Unchanged\n\n"));
        fs::write(temp.path().join("mine.yml"), original).unwrap();
        assert!(store.save(&file, Some(0), file.entries[0].clone()).unwrap_err().to_string().contains("outside"));
        assert_eq!(fs::read_to_string(temp.path().join("mine.yml")).unwrap(), original);
    }
    #[test]
    fn creation_append_duplicates_and_failure_leave_files_intact() {
        let temp = tempfile::tempdir().unwrap();
        let store = EditorStore::new(temp.path().into()).unwrap();
        let file = store.create("sales").unwrap();
        let file = store.save(&file, None, Match { trigger: "sale".into(), replace: "Paragraph\nnext\n".into() }).unwrap();
        assert_eq!(file.entries.len(), 1);
        assert!(store.create("sales").is_err());
        assert!(store.create("../escape").is_err());
        let other = store.create("code.yaml").unwrap();
        assert!(store.save(&other, None, file.entries[0].clone()).is_err());
        assert!(store.open("code.yaml").unwrap().entries.is_empty());
        let _lock = store.lock().unwrap();
        assert!(store.save(&file, None, Match { trigger: "new".into(), replace: "text".into() }).is_err());
        assert_eq!(store.open("sales.yml").unwrap().entries.len(), 1);
    }
    #[test]
    fn edit_block_scalar_and_append_preserve_unrelated_text() {
        let temp = tempfile::tempdir().unwrap();
        let store = EditorStore::new(temp.path().into()).unwrap();
        let original = "# header\nmatches:\n  - trigger: 'block'\n    replace: |+ # signature\n      Original\n\n  # second\n  - trigger: 'two'\n    replace: 'Keep me' # trailing\n";
        fs::write(temp.path().join("blocks.yml"), original).unwrap();
        let file = store.open("blocks.yml").unwrap();
        let file = store.save(&file, Some(0), Match { trigger: "block".into(), replace: "New\n\nText\n".into() }).unwrap();
        let before = fs::read_to_string(temp.path().join("blocks.yml")).unwrap();
        assert!(before.contains("# signature"));
        assert!(before.contains("  # second\n  - trigger: 'two'\n    replace: 'Keep me' # trailing\n"));
        store.save(&file, None, Match { trigger: "third".into(), replace: "Third\nline\n".into() }).unwrap();
        let after = fs::read_to_string(temp.path().join("blocks.yml")).unwrap();
        assert!(after.starts_with(&before), "Appending must preserve existing entries and comments");
    }
    #[test]
    fn read_only_file_is_not_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let store = EditorStore::new(temp.path().into()).unwrap();
        let file = store.create("readonly").unwrap();
        let path = temp.path().join("readonly.yml");
        let original = fs::metadata(&path).unwrap().permissions();
        let mut permissions = original.clone(); permissions.set_readonly(true); fs::set_permissions(&path, permissions).unwrap();
        let result = store.save(&file, None, Match { trigger: "new".into(), replace: "draft".into() });
        fs::set_permissions(&path, original).unwrap();
        assert!(result.is_err());
        assert!(store.open("readonly.yml").unwrap().entries.is_empty());
    }
}
