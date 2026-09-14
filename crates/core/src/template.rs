//! Pure template parsing/rendering. Callers supply time and answers; no IO or evaluation.
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use chrono::{DateTime, FixedOffset, SecondsFormat};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Variable {
    pub label: String,
    pub default: String,
    pub required: bool,
    pub multiline: bool,
    pub format: String,
    pub timezone: String,
}
impl Default for Variable {
    fn default() -> Self { Self { label: String::new(), default: String::new(), required: true, multiline: false, format: String::new(), timezone: "local".into() } }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Template { pub text: String, #[serde(default)] pub variables: BTreeMap<String, Variable> }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step { Text { text: String }, Enter }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderRequest {
    pub template: Template,
    #[serde(default)] pub values: BTreeMap<String, String>,
    pub now_ms: i64,
    pub offset_minutes: i32,
    #[serde(default)] pub preview: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Rendered { pub template: Template, pub fields: Vec<String>, pub steps: Vec<Step>, pub text: String, pub enter_actions: usize }
#[derive(Debug)]
enum Token { Literal(String), Variable(String), Enter }
impl Template {
    pub fn builtin(name: &str) -> bool { matches!(name, "date" | "time" | "timestamp") }
    fn tokens(&self) -> Result<Vec<Token>, String> {
        if self.text.is_empty() || self.text.len() > 65536 || self.text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') { return Err("Template must contain 1–65536 UTF-8 bytes; only newline/tab controls are allowed".into()); }
        let mut rest = self.text.as_str(); let mut literal = String::new(); let mut tokens = Vec::new();
        while !rest.is_empty() {
            if let Some(next) = rest.strip_prefix("\\{{") { literal.push_str("{{"); rest = next; }
            else if let Some(next) = rest.strip_prefix("\\\\") { literal.push('\\'); rest = next; }
            else if let Some(next) = rest.strip_prefix("{{") {
                if !literal.is_empty() { tokens.push(Token::Literal(std::mem::take(&mut literal))); }
                let end = next.find("}}").ok_or("Unclosed template placeholder")?;
                let name = &next[..end];
                if name == "key:enter" { tokens.push(Token::Enter); }
                else {
                    if name.is_empty() || name.len() > 63 || !name.bytes().enumerate().all(|(i,c)| c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit())) { return Err("Use a variable name such as {{name}}, or {{key:enter}}".into()); }
                    tokens.push(Token::Variable(name.into()));
                }
                rest = &next[end + 2..];
            } else { let c = rest.chars().next().unwrap(); literal.push(c); rest = &rest[c.len_utf8()..]; }
        }
        if !literal.is_empty() { tokens.push(Token::Literal(literal)); }
        if tokens.iter().filter(|token| matches!(token, Token::Enter)).count() > 64 { return Err("A template supports at most 64 Enter actions".into()); }
        Ok(tokens)
    }
    pub fn normalize(&self) -> Result<Self, String> {
        let normalized = Self { text:self.text.replace("\r\n", "\n"), variables:self.variables.clone() };
        let mut variables = BTreeMap::new();
        for token in normalized.tokens()? {
            if let Token::Variable(name) = token {
                let mut field = normalized.variables.get(&name).cloned().unwrap_or_default();
                field.default=field.default.replace("\r\n", "\n");
                if field.default.chars().any(|c|c.is_control()&&c!='\n'&&c!='\t'){return Err("Defaults may only contain newline/tab control characters".into());}
                if field.label.is_empty() { field.label = name.clone(); }
                if field.label.len() > 500 || field.label.chars().any(char::is_control) || field.default.len() > 65536 { return Err("Invalid variable label/default".into()); }
                if !["local", "utc"].contains(&field.timezone.as_str()) { return Err("Timezone must be local or utc".into()); }
                if !["", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "HH:mm", "HH:mm:ss", "YYYY-MM-DD HH:mm", "ISO"].contains(&field.format.as_str()) { return Err("Choose a supported date/time format".into()); }
                if !Self::builtin(&name) && !field.format.is_empty() { return Err("Only date/time variables have formats".into()); }
                if !field.multiline && field.default.contains('\n') { return Err("Enable multiline for a multiline default".into()); }
                variables.insert(name, field);
            }
        }
        if variables.len() > 64 { return Err("A template supports at most 64 variables".into()); }
        Ok(Self { text: normalized.text, variables })
    }
    pub fn fields(&self) -> Result<Vec<String>, String> {
        let mut result = Vec::new();
        for token in self.tokens()? { if let Token::Variable(name) = token && !Self::builtin(&name) && !result.contains(&name) { result.push(name); } }
        Ok(result)
    }
    pub fn render(request: RenderRequest) -> Result<Rendered, String> {
        let template = request.template.normalize()?;
        let fields = template.fields()?;
        let instant = DateTime::from_timestamp_millis(request.now_ms).ok_or("Invalid timestamp")?;
        let local = FixedOffset::east_opt(request.offset_minutes.checked_mul(60).ok_or("Invalid offset")?).ok_or("Invalid offset")?;
        let mut steps = Vec::new(); let mut text = String::new(); let mut enter_actions = 0;
        for token in template.tokens()? {
            let part = match token {
                Token::Enter => { steps.push(Step::Enter); enter_actions += 1; continue; }
                Token::Literal(text) => text,
                Token::Variable(name) => {
                    let field = &template.variables[&name];
                    if Self::builtin(&name) {
                        let time = instant.with_timezone(&if field.timezone == "utc" { FixedOffset::east_opt(0).unwrap() } else { local });
                        let format = if field.format.is_empty() { match name.as_str() { "date" => "YYYY-MM-DD", "time" => "HH:mm", _ => "ISO" } } else { field.format.as_str() };
                        if format == "ISO" { time.to_rfc3339_opts(SecondsFormat::Secs, false) } else { time.format(match format { "YYYY-MM-DD" => "%Y-%m-%d", "DD/MM/YYYY" => "%d/%m/%Y", "MM/DD/YYYY" => "%m/%d/%Y", "HH:mm" => "%H:%M", "HH:mm:ss" => "%H:%M:%S", _ => "%Y-%m-%d %H:%M" }).to_string() }
                    } else {
                        let value = request.values.get(&name).unwrap_or(&field.default).replace("\r\n", "\n");
                        if !request.preview && field.required && value.is_empty() { return Err(format!("{} is required", field.label)); }
                        if !field.multiline && value.contains('\n') { return Err(format!("{} is single-line", field.label)); }
                        if request.preview && value.is_empty() { format!("[{}]", field.label) } else { value }
                    }
                }
            };
            if part.chars().any(|c| c.is_control() && c != '\n' && c != '\t') { return Err("Values may only contain newline/tab control characters".into()); }
            text.push_str(&part); if text.len() > 65536 { return Err("Rendered template exceeds 65536 UTF-8 bytes".into()); }
            if let Some(Step::Text { text }) = steps.last_mut() { text.push_str(&part); } else if !part.is_empty() { steps.push(Step::Text { text: part }); }
        }
        Ok(Rendered { template, fields, steps, text, enter_actions })
    }
    pub fn json(input: &str) -> String {
        let result = serde_json::from_str::<RenderRequest>(input).map_err(|error| error.to_string()).and_then(Self::render);
        match result { Ok(rendered) => serde_json::to_string(&rendered).unwrap(), Err(error) => serde_json::json!({"error": error}).to_string() }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn render(text: &str, values: &[(&str,&str)]) -> Result<Rendered,String> { Template::render(RenderRequest { template: Template { text: text.into(), variables: BTreeMap::new() }, values: values.iter().map(|(k,v)| (k.to_string(),v.to_string())).collect(), now_ms: 0, offset_minutes: -300, preview: false }) }
    #[test] fn fields_are_shared_and_literal() { let result = render("Hi {{name}} {{name}}", &[("name", "{{key:enter}}")]).unwrap(); assert_eq!(result.fields, ["name"]); assert_eq!(result.enter_actions, 0); assert_eq!(result.text,"Hi {{key:enter}} {{key:enter}}"); }
    #[test] fn dates_and_actions_are_ordered() { let result=render("{{date}} {{time}} {{timestamp}}{{key:enter}}Done", &[]).unwrap(); assert_eq!(result.text,"1969-12-31 19:00 1969-12-31T19:00:00-05:00Done"); assert!(matches!(result.steps[1],Step::Enter)); }
    #[test] fn escaping_validation_and_defaults() { assert_eq!(render(r"\{{name}} \\ hi", &[]).unwrap().text,r"{{name}} \ hi"); assert!(render("{{name}}", &[]).is_err()); assert!(render("{{shell:cmd}}", &[]).is_err()); assert!(render("{{bad", &[]).is_err()); let mut template=Template{text:"{{name}}".into(),variables:BTreeMap::new()}.normalize().unwrap(); template.variables.get_mut("name").unwrap().default="Nitai".into(); let result=Template::render(RenderRequest{template,values:BTreeMap::new(),now_ms:0,offset_minutes:0,preview:false}).unwrap(); assert_eq!(result.text,"Nitai"); }
    #[test] fn multiline_and_size_validation() { assert!(render("{{name}}", &[("name","a\nb")]).is_err()); assert!(render("{{name}}", &[("name", &"a".repeat(65537))]).is_err()); }
}
