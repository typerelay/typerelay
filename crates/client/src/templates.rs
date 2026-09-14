use std::collections::BTreeMap;
use anyhow::{Result, Context};
use typerelay_core::template::{Template, RenderRequest, Rendered, Step};
pub struct Templates;
impl Templates {
    pub fn clock()->(i64,i32){let now=chrono::Local::now();(now.timestamp_millis(),now.offset().local_minus_utc()/60)}
    pub fn render(content: &serde_json::Value, values: BTreeMap<String,String>, preview: bool) -> Result<Rendered> {
        Self::render_at(content,values,preview,Self::clock())
    }
    pub fn render_at(content:&serde_json::Value,values:BTreeMap<String,String>,preview:bool,clock:(i64,i32))->Result<Rendered>{
        let text = content["text"].as_str().context("Missing snippet text")?.to_owned();
        if content["type"] != "template" { return Ok(Rendered { template: Template { text: text.clone(), variables: BTreeMap::new() }, fields: vec![], steps: vec![Step::Text { text: text.clone() }], text, enter_actions: 0 }); }
        Template::render(RenderRequest { template: Template { text, variables: serde_json::from_value(content.get("variables").cloned().unwrap_or_else(||serde_json::json!({})))? }, values, preview, now_ms: clock.0, offset_minutes: clock.1 }).map_err(anyhow::Error::msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn code_and_plain_text_are_never_interpreted(){for kind in ["code","plain_text"]{let value=serde_json::json!({"type":kind,"text":"{{name}}{{key:enter}}"});let rendered=Templates::render(&value,BTreeMap::new(),false).unwrap();assert_eq!(rendered.text,"{{name}}{{key:enter}}");assert_eq!(rendered.enter_actions,0);}}
    #[test] fn template_metadata_round_trips_and_snapshot_keeps_identity(){
        let root=tempfile::tempdir().unwrap();let db=crate::database::Database::open(root.path()).unwrap();
        let name=db.import("Template","matches:\n- trigger: hello\n  replace: 'Hi {{name}} {{date}}{{key:enter}}'\n  type: template\n  variables:\n    name:\n      label: Customer\n      default: Nitai\n      required: true\n      multiline: false\n    date:\n      timezone: utc\n      format: DD/MM/YYYY\n").unwrap();
        let file=db.editor(&name.name).unwrap();assert_eq!(file.entries[0].variables["name"].label,"Customer");
        let exported=crate::bridge::Bridge::export(&file.entries).unwrap();assert!(exported.contains("template"));assert!(exported.contains("Customer"));
        let mut engine=typerelay_core::Engine::new(db.snapshot().unwrap());for c in ",hello".chars(){engine.feed(typerelay_core::Input::Character(c));}let expansion=engine.feed(typerelay_core::Input::Space).unwrap();let template=expansion.template.unwrap();assert!(template.prompted);assert!(template.identity.is_some());
        let rendered=Templates::render_at(&file.entries[0].value()["content"],BTreeMap::new(),false,(0,-300)).unwrap();assert_eq!(rendered.text,"Hi Nitai 01/01/1970");assert_eq!(rendered.enter_actions,1);
    }
    #[test] fn first_launch_yaml_import_preserves_template_code_and_titles(){
        let root=tempfile::tempdir().unwrap();let directory=root.path().join("snippets");std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("fresh.yml"),"matches:\n- trigger: ask\n  title: Greeting\n  type: template\n  replace: 'Hi {{name}}'\n  variables:\n    name:\n      label: Customer\n- trigger: null\n  title: Copy sample\n  type: code\n  language: Rust\n  replace: '{{ literal }}'\n").unwrap();
        let db=crate::database::Database::open(&directory).unwrap();let file=db.editor("fresh.yml").unwrap();assert_eq!(file.entries[0].kind,"template");assert_eq!(file.entries[0].title,"Greeting");assert_eq!(file.entries[0].variables["name"].label,"Customer");assert_eq!(file.entries[1].kind,"code");assert_eq!(file.entries[1].language,"Rust");assert!(file.entries[1].trigger.is_empty());
        let mut engine=typerelay_core::Engine::new(db.snapshot().unwrap());for c in ",ask".chars(){engine.feed(typerelay_core::Input::Character(c));}assert!(engine.feed(typerelay_core::Input::Space).unwrap().template.unwrap().prompted);
    }

}
