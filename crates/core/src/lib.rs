//! Platform-independent matching. Neither keyboard devices nor snippet sources live here.
pub mod template;
pub mod rich_text;
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

    pub fn set_template(&mut self, abbreviation: &str, template: template::Template) -> Result<(), String> { let template=template.normalize()?; let prompted=!template.fields()?.is_empty(); self.templates.insert(abbreviation.into(), TemplateExpansion { abbreviation: abbreviation.into(), identity: None, prompted, rich:false }); Ok(()) }
    pub fn set_rich(&mut self, abbreviation: &str, prompted: bool) { self.templates.insert(abbreviation.into(), TemplateExpansion { abbreviation: abbreviation.into(), identity: None, prompted, rich:true }); }
    pub fn identify(&mut self, abbreviation: &str, identity: Identity) { if let Some(template) = self.templates.get_mut(abbreviation) { template.identity = Some(identity); } }
    pub fn len(&self) -> usize { self.snippets.len() }
    pub fn is_empty(&self) -> bool { self.snippets.is_empty() }
}

#[derive(Debug, Clone, Copy)]
pub enum Input { Character(char), Backspace, Delete, Left, Right, Space, Cancel }

pub enum FeedResult { Forward, Suppress, Expand(Expansion) }

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity { pub id: String, pub library: String, pub revision: i64 }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateExpansion { pub prompted: bool, pub rich: bool, pub abbreviation: String, pub identity: Option<Identity> }
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
    cursor: usize,
    edited: bool,
    spare_right_used: bool,
    prefix: char,
}

impl Engine {
    pub const DEFAULT_PREFIX: char = ';';
    pub fn new(snapshot: Snapshot) -> Self { Self { snapshot, pending: String::new(), cursor: 0, edited: false, spare_right_used: false, prefix: Self::DEFAULT_PREFIX } }

    fn clear_pending(&mut self) { self.pending.clear(); self.cursor = 0; self.edited = false; self.spare_right_used = false; }
    fn mark_internal_edit(&mut self) { self.edited = true; self.spare_right_used = false; }

    pub fn validate_prefix(value: &str) -> Result<char, String> {
        let mut chars = value.chars();
        let prefix = chars.next().ok_or("A trigger prefix is required")?;
        if chars.next().is_some() || !",;./'[]\\`=".contains(prefix) { return Err("Use one unshifted US punctuation character: , ; . / ' [ ] \\ ` =".into()); }
        Ok(prefix)
    }
    pub fn prefix(&self) -> char { self.prefix }
    pub fn set_prefix(&mut self, prefix: &str) -> Result<(), String> {
        let prefix = Self::validate_prefix(prefix)?;
        if prefix != self.prefix { self.prefix = prefix; self.clear_pending(); }
        Ok(())
    }

    /// Future sync publishes a complete validated snapshot through this same boundary.
    pub fn replace_snapshot(&mut self, snapshot: Snapshot) {
        self.snapshot = snapshot;
        self.clear_pending();
    }

    /// The adapter suppresses the confirming Space only when an expansion is returned.
    pub fn feed(&mut self, input: Input) -> Option<Expansion> {
        match self.feed_event(input) { FeedResult::Expand(expansion) => Some(expansion), FeedResult::Forward | FeedResult::Suppress => None }
    }

    pub fn feed_event(&mut self, input: Input) -> FeedResult {
        match input {
            Input::Cancel => self.clear_pending(),
            Input::Backspace if self.cursor > 0 => {
                if self.cursor < self.pending.len() { self.mark_internal_edit(); }
                self.cursor -= 1;
                self.pending.remove(self.cursor);
                if self.cursor == 0 { self.clear_pending(); }
            }
            Input::Backspace => self.clear_pending(),
            Input::Delete if self.cursor < self.pending.len() => {
                self.mark_internal_edit();
                self.pending.remove(self.cursor);
                if self.cursor == 0 { self.clear_pending(); }
            }
            Input::Delete => self.clear_pending(),
            Input::Left if self.cursor > 0 => self.cursor -= 1,
            Input::Right if self.cursor < self.pending.len() => self.cursor += 1,
            Input::Right if self.edited && !self.spare_right_used && self.pending.strip_prefix(self.prefix).is_some_and(|abbreviation| self.snapshot.snippets.contains_key(abbreviation)) => {
                self.spare_right_used = true;
                return FeedResult::Suppress;
            }
            Input::Left | Input::Right => self.clear_pending(),
            Input::Space => {
                let abbreviation = if self.cursor == self.pending.len() { self.pending.strip_prefix(self.prefix) } else { None };
                let expansion = abbreviation.and_then(|abbreviation| self.snapshot.snippets.get(abbreviation)).map(|s| Expansion { template: self.snapshot.templates.get(&s.trigger).cloned(), erase: self.pending.len(), text: s.replacement.clone() });
                self.clear_pending();
                return expansion.map_or(FeedResult::Forward, FeedResult::Expand);
            }
            Input::Character(c) if c == self.prefix && self.cursor == self.pending.len() => { self.pending = c.to_string(); self.cursor = 1; self.edited = false; self.spare_right_used = false; }
            Input::Character(c) if self.cursor > 0 && (c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') => {
                if self.cursor < self.pending.len() { self.mark_internal_edit(); }
                self.pending.insert(self.cursor, c);
                self.cursor += 1;
                if self.pending.len() > 64 { self.clear_pending(); }
            }
            Input::Character(_) => self.clear_pending(),
        }
        FeedResult::Forward
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
    fn edits_inside_abbreviation_with_delete_and_backspace() {
        let snapshot = Snapshot::new(vec![
            Snippet { trigger: "efish".into(), replacement: "Original".into() },
            Snippet { trigger: "sfish".into(), replacement: "Corrected".into() },
        ]).unwrap();
        for erase in [Input::Delete, Input::Backspace] {
            let mut engine = Engine::new(snapshot.clone());
            Fixture::type_text(&mut engine, ";efish");
            let moves = if matches!(erase, Input::Delete) { 5 } else { 4 };
            for _ in 0..moves { engine.feed(Input::Left); }
            engine.feed(erase);
            engine.feed(Input::Character('s'));
            for _ in 0..4 { engine.feed(Input::Right); }
            assert!(matches!(engine.feed_event(Input::Right), FeedResult::Suppress));
            assert_eq!(engine.feed(Input::Space), Some(Expansion { template: None, erase: 6, text: "Corrected".into() }));
        }
    }
    #[test]
    fn a_second_right_leaves_the_corrected_abbreviation() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brb");
        engine.feed(Input::Left);
        engine.feed(Input::Left);
        engine.feed(Input::Delete);
        engine.feed(Input::Character('r'));
        engine.feed(Input::Right);
        assert!(matches!(engine.feed_event(Input::Right), FeedResult::Suppress));
        assert!(matches!(engine.feed_event(Input::Right), FeedResult::Forward));
        assert_eq!(engine.feed(Input::Space), None);

        Fixture::type_text(&mut engine, ";brb");
        assert!(matches!(engine.feed_event(Input::Right), FeedResult::Forward));
        assert_eq!(engine.feed(Input::Space), None);
    }
    #[test]
    fn navigation_only_expands_when_caret_is_at_known_end() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brb");
        engine.feed(Input::Left);
        assert_eq!(engine.feed(Input::Space), None);
        engine.feed(Input::Right);
        assert_eq!(engine.feed(Input::Space), None);

        Fixture::type_text(&mut engine, ";brb");
        engine.feed(Input::Right);
        assert_eq!(engine.feed(Input::Space), None);

        Fixture::type_text(&mut engine, ";brb");
        for _ in 0..4 { engine.feed(Input::Left); }
        engine.feed(Input::Left);
        for c in "brb".chars() { engine.feed(Input::Character(c)); }
        assert_eq!(engine.feed(Input::Space), None);
    }
    #[test]
    fn deletion_and_cancellation_do_not_reuse_stale_trigger() {
        let mut engine = Engine::new(Fixture::snapshot());
        Fixture::type_text(&mut engine, ";brb");
        engine.feed(Input::Left);
        engine.feed(Input::Left);
        engine.feed(Input::Delete);
        engine.feed(Input::Character('r'));
        engine.feed(Input::Right);
        assert_eq!(engine.feed(Input::Space).unwrap().erase, 4);

        Fixture::type_text(&mut engine, ";brb");
        for _ in 0..3 { engine.feed(Input::Left); }
        engine.feed(Input::Backspace);
        Fixture::type_text(&mut engine, "brb");
        assert_eq!(engine.feed(Input::Space), None);

        Fixture::type_text(&mut engine, ";brb");
        engine.feed(Input::Cancel);
        assert_eq!(engine.feed(Input::Space), None);
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
