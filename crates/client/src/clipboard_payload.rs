#[derive(Clone,Debug,PartialEq,Eq)]
pub struct ClipboardPayload { pub characters:usize,pub plain:String,pub html:Option<String>,pub rtf:Option<String>, pub cursor:Option<typerelay_core::template::Cursor> }
#[derive(Clone,Debug,PartialEq,Eq)]
pub enum ClipboardStep { Payload(ClipboardPayload), Enter }
impl ClipboardStep {
	pub fn with_confirmation(mut steps:Vec<Self>,confirm_enter:bool)->Vec<Self>{if confirm_enter&&!steps.iter().any(|step|matches!(step,Self::Payload(payload) if payload.cursor.is_some()))&&!matches!(steps.last(),Some(Self::Enter)){steps.push(Self::Enter);}steps}
}
impl ClipboardPayload { pub fn text(value:String)->Self{Self{characters:value.chars().count(),plain:value,html:None,rtf:None,cursor:None}} }
impl ClipboardPayload {
	pub fn cf_html(fragment:String)->String {let before="<html><body><!--StartFragment-->";let after="<!--EndFragment--></body></html>";let header="Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";let start_html=header.len();let start_fragment=start_html+before.len();let end_fragment=start_fragment+fragment.len();let end_html=end_fragment+after.len();format!("Version:1.0\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n{before}{fragment}{after}")}
}
#[cfg(test)]
mod tests{use super::*;
#[test]
fn confirmation_is_last_and_only_trailing_explicit_enter_is_deduplicated(){let text=ClipboardStep::Payload(ClipboardPayload::text("echo hello".into()));assert_eq!(ClipboardStep::with_confirmation(vec![text.clone()],true),vec![text.clone(),ClipboardStep::Enter]);assert_eq!(ClipboardStep::with_confirmation(vec![text.clone()],false),vec![text.clone()]);assert_eq!(ClipboardStep::with_confirmation(vec![text.clone(),ClipboardStep::Enter],true),vec![text.clone(),ClipboardStep::Enter]);assert_eq!(ClipboardStep::with_confirmation(vec![ClipboardStep::Enter,text.clone()],true),vec![ClipboardStep::Enter,text,ClipboardStep::Enter]);}
#[test]fn cursor_consumes_confirmation_enter(){for value in ["a{{cursor:here}}b","{{cursor:here}}"]{let rendered=typerelay_core::template::Template::render(typerelay_core::template::RenderRequest{template:typerelay_core::template::Template{text:value.into(),variables:Default::default()},values:Default::default(),now_ms:0,offset_minutes:0,preview:false}).unwrap();let mut payload=ClipboardPayload::text(rendered.text);payload.cursor=rendered.cursor;let steps=ClipboardStep::with_confirmation(vec![ClipboardStep::Payload(payload)],true);assert_eq!(steps.len(),1);}}
#[test]fn cf_html_uses_utf8_byte_offsets(){let value=ClipboardPayload::cf_html("<b>Café</b>".into());let offset=|name:&str|value.lines().find(|line|line.starts_with(name)).unwrap().split_once(':').unwrap().1.parse::<usize>().unwrap();assert!(value[offset("StartHTML")..offset("EndHTML")].starts_with("<html>"));assert_eq!(&value[offset("StartFragment")..offset("EndFragment")],"<b>Café</b>");}}
