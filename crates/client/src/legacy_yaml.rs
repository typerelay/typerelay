use crate::config::{Document, Match};
use anyhow::{Context, Result, ensure};
use std::str::FromStr;
pub struct LegacyYaml;
impl LegacyYaml {
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

}
