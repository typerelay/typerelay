#[derive(Clone,Debug,PartialEq,Eq)]
pub struct ClipboardPayload { pub plain:String,pub html:Option<String>,pub rtf:Option<String> }
#[derive(Clone,Debug,PartialEq,Eq)]
pub enum ClipboardStep { Payload(ClipboardPayload), Enter }
impl ClipboardPayload { pub fn text(value:String)->Self{Self{plain:value,html:None,rtf:None}} }
impl ClipboardPayload {
	pub fn cf_html(fragment:String)->String {let before="<html><body><!--StartFragment-->";let after="<!--EndFragment--></body></html>";let header="Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";let start_html=header.len();let start_fragment=start_html+before.len();let end_fragment=start_fragment+fragment.len();let end_html=end_fragment+after.len();format!("Version:1.0\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n{before}{fragment}{after}")}
}
#[cfg(test)]
mod tests{use super::*;#[test]fn cf_html_uses_utf8_byte_offsets(){let value=ClipboardPayload::cf_html("<b>Café</b>".into());let offset=|name:&str|value.lines().find(|line|line.starts_with(name)).unwrap().split_once(':').unwrap().1.parse::<usize>().unwrap();assert!(value[offset("StartHTML")..offset("EndHTML")].starts_with("<html>"));assert_eq!(&value[offset("StartFragment")..offset("EndFragment")],"<b>Café</b>");}}
