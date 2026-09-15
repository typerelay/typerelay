//! Platform-independent matching. Neither keyboard devices nor snippet sources live here.
pub mod template;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snippet {
    pub trigger: String,
    pub replacement: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    snippets: BTreeMap<String, Snippet>,
    templates: BTreeMap<String, TemplateExpansion>,
}

impl Snapshot {
    pub fn new(snippets: Vec<Snippet>) -> Result<Self, String> {
        let mut indexed = BTreeMap::new();
        for mut snippet in snippets {
            let suffix = &snippet.trigger;
            if suffix.is_empty() || suffix.len() > 63 || !suffix.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
                return Err("Store only the abbreviation: 1–63 lowercase ASCII letters, digits or hyphens (no prefix). Run typerelay migrate for older files".into());
            }
            snippet.replacement = snippet.replacement.replace("\r\n", "\n");
            if snippet.replacement.is_empty() || snippet.replacement.len() > 65536 || snippet.replacement.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
                return Err("Replacements must be 1–65536 UTF-8 bytes of static text; only newline and tab controls are supported".into());
            }
            if indexed.insert(snippet.trigger.clone(), snippet).is_some() {
                return Err("Duplicate trigger".into());
            }
        }
        Ok(Self { snippets: indexed, templates: BTreeMap::new() })
    }

    pub fn set_template(&mut self, abbreviation: &str, template: template::Template) -> Result<(), String> { let template=template.normalize()?; let prompted=!template.fields()?.is_empty(); self.templates.insert(abbreviation.into(), TemplateExpansion { abbreviation: abbreviation.into(), identity: None, prompted }); Ok(()) }
    pub fn identify(&mut self, abbreviation: &str, identity: Identity) { if let Some(template) = self.templates.get_mut(abbreviation) { template.identity = Some(identity); } }
    pub fn len(&self) -> usize { self.snippets.len() }
    pub fn is_empty(&self) -> bool { self.snippets.is_empty() }
}

#[derive(Debug, Clone, Copy)]
pub enum Input { Character(char), Backspace, Space, Cancel }

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity { pub id: String, pub library: String, pub revision: i64 }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateExpansion { pub prompted: bool, pub abbreviation: String, pub identity: Option<Identity> }
#[derive(Debug, PartialEq, Eq)]
pub struct Expansion {
    pub template: Option<TemplateExpansion>,
    pub erase: usize,
    pub text: String,
}

impl Expansion {
    pub fn requires_paste(&self) -> bool { self.text.len() > 512 || !self.text.is_ascii() || self.text.contains(['\n', '\t']) }
}

pub struct Engine {
    snapshot: Snapshot,
    pending: String,
    prefix: char,
}

impl Engine {
    pub const DEFAULT_PREFIX: char = ';';
    pub fn new(snapshot: Snapshot) -> Self { Self { snapshot, pending: String::new(), prefix: Self::DEFAULT_PREFIX } }

    pub fn validate_prefix(value: &str) -> Result<char, String> {
        let mut chars = value.chars();
        let prefix = chars.next().ok_or("A trigger prefix is required")?;
        if chars.next().is_some() || !",;./'[]\\`=".contains(prefix) { return Err("Use one unshifted US punctuation character: , ; . / ' [ ] \\ ` =".into()); }
        Ok(prefix)
    }
    pub fn prefix(&self) -> char { self.prefix }
    pub fn set_prefix(&mut self, prefix: &str) -> Result<(), String> {
        let prefix = Self::validate_prefix(prefix)?;
        if prefix != self.prefix { self.prefix = prefix; self.pending.clear(); }
        Ok(())
    }

    /// Future sync publishes a complete validated snapshot through this same boundary.
    pub fn replace_snapshot(&mut self, snapshot: Snapshot) {
        self.snapshot = snapshot;
        self.pending.clear();
    }

    /// The adapter suppresses the confirming Space only when an expansion is returned.
    pub fn feed(&mut self, input: Input) -> Option<Expansion> {
        match input {
            Input::Cancel => self.pending.clear(),
            Input::Backspace => { self.pending.pop(); }
            Input::Space => {
                let expansion = self.pending.strip_prefix(self.prefix).and_then(|abbreviation| self.snapshot.snippets.get(abbreviation)).map(|s| Expansion { template: self.snapshot.templates.get(&s.trigger).cloned(), erase: self.pending.len(), text: s.replacement.clone() });
                self.pending.clear();
                return expansion;
            }
            Input::Character(c) if c == self.prefix => self.pending = c.to_string(),
            Input::Character(c) if !self.pending.is_empty() && (c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') => {
                self.pending.push(c);
                if self.pending.len() > 64 { self.pending.clear(); }
            }
            Input::Character(_) => self.pending.clear(),
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture;
    impl Fixture {
        fn snapshot() -> Snapshot {
            Snapshot::new(vec![Snippet { trigger: "brb".into(), replacement: "Be right back.".into() }, Snippet { trigger: "brbmore".into(), replacement: "Later".into() }]).unwrap()
        }
        fn type_text(engine: &mut Engine, text: &str) {
            for c in text.chars() { assert!(engine.feed(Input::Character(c)).is_none()); }
        }
    }
    #[test]
    fn waits_for_space_and_allows_overlap() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brbmore");
        assert_eq!(engine.feed(Input::Space), Some(Expansion { template: None, erase: 8, text: "Later".into() }));
        Fixture::type_text(&mut engine, ";brb");
        assert_eq!(engine.feed(Input::Space), Some(Expansion { template: None, erase: 4, text: "Be right back.".into() }));
        assert_eq!(engine.feed(Input::Space), None);
    }
    #[test]
    fn edits_and_cancellation() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brbm");
        engine.feed(Input::Backspace);
        assert_eq!(engine.feed(Input::Space).unwrap().erase, 4);
        Fixture::type_text(&mut engine, ";brb");
        engine.feed(Input::Cancel);
        assert_eq!(engine.feed(Input::Space), None);
        Fixture::type_text(&mut engine, "ordinary;unknown");
        assert_eq!(engine.feed(Input::Space), None);
        Fixture::type_text(&mut engine, ";brx");
        engine.feed(Input::Backspace);
        engine.feed(Input::Character('b'));
        assert!(engine.feed(Input::Space).is_some());
    }
    #[test]
    fn snapshot_swap_cancels_partial_trigger() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brb");
        engine.replace_snapshot(Snapshot::new(vec![]).unwrap());
        assert_eq!(engine.feed(Input::Space), None);
    }
    #[test]
    fn prefix_changes_do_not_change_snippets_and_cancel_pending_matches() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brb");
        engine.set_prefix(",").unwrap();
        assert!(engine.feed(Input::Space).is_none());
        Fixture::type_text(&mut engine, ";brb");
        assert!(engine.feed(Input::Space).is_none());
        Fixture::type_text(&mut engine, ",brb");
        assert_eq!(engine.feed(Input::Space).unwrap(), Expansion { template: None, erase: 4, text: "Be right back.".into() });
        for prefix in ["", "::", "a", "-", " ", ":"] { assert!(engine.set_prefix(prefix).is_err()); }
        assert_eq!(engine.prefix(), ',');
    }
    #[test]
    fn rejects_unsafe_or_ambiguous_configuration() {
        for (trigger, replacement) in [("", "text"), (",BRB", "text"), (",a b", "text"), (",brb", "command\r"), (",brb", "command\u{1b}"), (",brb", "{{shell}}"), (",brb", "") ] {
            assert!(Snapshot::new(vec![Snippet { trigger: trigger.into(), replacement: replacement.into() }]).is_err());
        }
        let duplicate = Snippet { trigger: "brb".into(), replacement: "text".into() };
        assert!(Snapshot::new(vec![duplicate.clone(), duplicate]).is_err());
    }

    #[test]
    fn multiline_preserves_paragraphs_tabs_and_trailing_newlines() {
        let text = "Sincerely,\r\nNitai\r\nCeo & Founder\r\n\r\n\tCafé\n";
        let snapshot = Snapshot::new(vec![Snippet { trigger: "naf".into(), replacement: text.into() }]).unwrap();
        let mut engine = Engine::new(snapshot);
        Fixture::type_text(&mut engine, ";naf");
        let expansion = engine.feed(Input::Space).unwrap();
        assert_eq!(expansion.text, "Sincerely,\nNitai\nCeo & Founder\n\n\tCafé\n");
        assert!(expansion.requires_paste());
        assert_eq!(expansion.erase, 4);
    }

    #[test]
    fn long_paragraphs_use_paste_and_short_text_stays_native() {
        assert!(Expansion { template: None, erase: 4, text: "a".repeat(600) }.requires_paste());
        assert!(!Expansion { template: None, erase: 4, text: "Be right back.".into() }.requires_paste());
        assert!(Snapshot::new(vec![Snippet { trigger: "long".into(), replacement: "a".repeat(65536) }]).is_ok());
        assert!(Snapshot::new(vec![Snippet { trigger: "long".into(), replacement: "a".repeat(65537) }]).is_err());
    }
}
