//! Shared rich-text normalization and rendering. Callers provide assets, time and answers.
use crate::template::{RenderRequest, Step, Template, Variable};
use ammonia::Builder;
use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd, html};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::borrow::Cow;
use base64::{Engine as _, engine::general_purpose::STANDARD};

const ASSET_PREFIX: &str = "typerelay-asset:";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RichRequest {
    pub markdown: String,
    pub variables: BTreeMap<String, Variable>,
    pub values: BTreeMap<String, String>,
    pub assets: BTreeMap<String, String>,
    pub now_ms: i64,
    pub offset_minutes: i32,
    pub preview: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RichStep { Content { markdown: String, text: String, html: String, rtf: String }, Enter }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RichRendered {
    pub markdown: String,
    pub text: String,
    pub html: String,
    pub rtf: String,
    pub assets: Vec<String>,
    pub variables: BTreeMap<String, Variable>,
    pub fields: Vec<String>,
    pub steps: Vec<RichStep>,
    pub enter_actions: usize,
}

pub struct RichText;
impl RichText {
    fn options() -> Options {
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES | Options::ENABLE_GFM
    }

    fn valid_asset(value: &str) -> Option<String> {
        let id = value.strip_prefix(ASSET_PREFIX)?;
        (id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| id.to_ascii_lowercase())
    }

    fn safe_url(value: &str) -> bool {
        let lower = value.trim().to_ascii_lowercase();
        lower.starts_with('#') || lower.starts_with('/') || ["https:", "http:", "mailto:", "tel:", ASSET_PREFIX].iter().any(|scheme| lower.starts_with(scheme))
    }

    fn sanitizer() -> Builder<'static> {
        let mut builder = Builder::default();
        builder
			.add_tags(["u", "s", "del", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "text"])
			.add_generic_attributes(["class", "title", "align", "style", "data-align", "data-asset", "data-placement", "width", "height", "viewBox", "fill", "stroke", "stroke-width", "d", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "points"])
			.add_tag_attributes("img", ["src", "alt", "title", "width", "height", "data-asset", "data-source-url"])
			.add_tag_attributes("a", ["href", "title", "target"])
			.url_schemes(["http", "https", "mailto", "tel", "data", "typerelay-asset"].into_iter().collect())
			.attribute_filter(|_,attribute,value|if attribute=="style"{let normalized=value.trim().to_ascii_lowercase().replace(' ',"");Regex::new(r"^text-align:(left|center|right|justify);?$").unwrap().is_match(&normalized).then_some(Cow::Owned(normalized))}else{Some(Cow::Borrowed(value))});
        builder
    }
	fn syntax(markdown:&str)->String{Regex::new(r"(?s)\+\+(.+?)\+\+").unwrap().replace_all(markdown,"<u>$1</u>").into_owned()}

    fn escape_value(value: &str) -> String {
        let mut escaped = String::with_capacity(value.len());
        for character in value.chars() {
            if "\\`*_{}[]()#+-.!|>~<>".contains(character) { escaped.push('\\'); }
            escaped.push(character);
        }
        escaped
    }
	fn substitute(markdown:&str,replacements:&BTreeMap<String,String>)->Result<String,String>{let mut output=markdown.to_owned();for(marker,value)in replacements{while let Some(index)=output.find(marker){let before=&output[..index];let after=&output[index+marker.len()..];let line_start=before.rfind('\n').map_or(0,|value|value+1);let line=&before[line_start..];let in_tag=line.rfind('<').is_some_and(|open|line.rfind('>').is_none_or(|close|open>close));let in_markdown_url=before.rfind("](").is_some_and(|open|before.rfind(')').is_none_or(|close|open>close))&&after.contains(')');let replacement=if in_markdown_url{if !Self::safe_url(value){return Err("Template link values must use HTTP, HTTPS, mailto, tel, an anchor, or a TypeRelay asset".into());}value.clone()}else if in_tag||line.trim_start().starts_with('<'){html_escape::encode_quoted_attribute(value).into_owned()}else{Self::escape_value(value)};output.replace_range(index..index+marker.len(),&replacement);}}Ok(output)}

    fn validate_actions(markdown: &str) -> Result<(), String> {
        for line in markdown.replace("\\{{", "").lines().filter(|line| line.contains("{{key:enter}}")) {
            if line.trim() != "{{key:enter}}" { return Err("Rich-text Enter actions must be on their own line between blocks".into()); }
        }
        Ok(())
    }

    fn rewrite_assets<'a>(parser: Parser<'a>, provided: &BTreeMap<String, String>, found: &mut BTreeSet<String>) -> Vec<Event<'a>> {
        parser.map(|event| match event {
            Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
                if let Some(asset) = Self::valid_asset(&dest_url) {
                    found.insert(asset.clone());
                    let destination = provided.get(&asset).cloned().unwrap_or_else(|| format!("{ASSET_PREFIX}{asset}"));
                    Event::Start(Tag::Image { link_type, dest_url: CowStr::Boxed(destination.into_boxed_str()), title, id })
                } else { Event::Start(Tag::Image { link_type, dest_url, title, id }) }
            }
			Event::Html(value)=>{let pattern=Regex::new(r#"(?i)typerelay-asset:([a-f0-9]{64})"#).unwrap();let replaced=pattern.replace_all(&value,|captures:&regex::Captures<'_>|{let id=captures[1].to_ascii_lowercase();found.insert(id.clone());provided.get(&id).cloned().unwrap_or_else(||format!("{ASSET_PREFIX}{id}"))});Event::Html(CowStr::Boxed(replaced.into_owned().into_boxed_str()))},
			Event::InlineHtml(value)=>{let pattern=Regex::new(r#"(?i)typerelay-asset:([a-f0-9]{64})"#).unwrap();let replaced=pattern.replace_all(&value,|captures:&regex::Captures<'_>|{let id=captures[1].to_ascii_lowercase();found.insert(id.clone());provided.get(&id).cloned().unwrap_or_else(||format!("{ASSET_PREFIX}{id}"))});Event::InlineHtml(CowStr::Boxed(replaced.into_owned().into_boxed_str()))},
            other => other,
        }).collect()
    }

    fn raw_text(html: &str) -> String {
		let images=Regex::new(r#"(?is)<img\b[^>]*\balt=["']([^"']*)["'][^>]*>"#).unwrap();let html=images.replace_all(html,"[Image: $1]");
        let block = Regex::new(r"(?i)</?(?:p|div|h[1-6]|li|tr|blockquote|pre|br|hr)[^>]*>").unwrap();
        let tags = Regex::new(r"(?s)<[^>]*>").unwrap();
		let with_breaks = block.replace_all(&html, "\n");
		let mut text=html_escape::decode_html_entities(&tags.replace_all(&with_breaks, "")).replace("\r\n", "\n");while text.contains("\n\n"){text=text.replace("\n\n","\n");}text.trim_matches('\n').into()
    }

	fn rtf_text(output:&mut String,value:&str){for unit in value.encode_utf16(){match unit{92=>output.push_str("\\\\"),123=>output.push_str("\\{"),125=>output.push_str("\\}"),10=>output.push_str("\\line "),9=>output.push_str("\\tab "),32..=126=>output.push(char::from_u32(unit as u32).unwrap()),_=>output.push_str(&format!("\\u{}?",unit as i16)),}}}
	fn rtf_markup_text(output:&mut String,value:&str){for part in value.split_inclusive(['\u{e000}','\u{e001}']){if part.ends_with('\u{e000}'){Self::rtf_text(output,part.trim_end_matches('\u{e000}'));output.push_str("\\ul ");}else if part.ends_with('\u{e001}'){Self::rtf_text(output,part.trim_end_matches('\u{e001}'));output.push_str("\\ul0 ");}else{Self::rtf_text(output,part);}}}
	fn rtf_html(output:&mut String,value:&str){let sanitized=Self::sanitizer().clean(value).to_string().replace("<u>","\u{e000}").replace("</u>","\u{e001}");if sanitized.contains("text-align:center"){output.push_str("\\qc ");}else if sanitized.contains("text-align:right"){output.push_str("\\qr ");}else if sanitized.contains("text-align:justify"){output.push_str("\\qj ");}let images=Regex::new(r#"(?is)<img\b[^>]*\bsrc=["']data:image/(png|jpeg);base64,([^"']+)["'][^>]*>"#).unwrap();let mut offset=0;for capture in images.captures_iter(&sanitized){let whole=capture.get(0).unwrap();Self::rtf_markup_text(output,&Self::raw_text(&sanitized[offset..whole.start()]));if let Ok(bytes)=STANDARD.decode(&capture[2]){output.push_str("{\\pict");output.push_str(if &capture[1].to_ascii_lowercase()=="png"{"\\pngblip"}else{"\\jpegblip"});output.push(' ');for byte in bytes{output.push_str(&format!("{byte:02x}"));}output.push('}');}offset=whole.end();}Self::rtf_markup_text(output,&Self::raw_text(&sanitized[offset..]));if sanitized.contains("text-align:"){output.push_str("\\ql ");}}
	fn rtf(markdown:&str,assets:&BTreeMap<String,String>)->String{let syntax=Self::syntax(markdown);let parser=Parser::new_ext(&syntax,Self::options());let mut found=BTreeSet::new();let events=Self::rewrite_assets(parser,assets,&mut found);let mut output=String::from("{\\rtf1\\ansi\\deff0\\uc1 ");let mut image=false;for event in events{match event{Event::Start(Tag::Strong)=>output.push_str("\\b "),Event::End(TagEnd::Strong)=>output.push_str("\\b0 "),Event::Start(Tag::Emphasis)=>output.push_str("\\i "),Event::End(TagEnd::Emphasis)=>output.push_str("\\i0 "),Event::Start(Tag::Strikethrough)=>output.push_str("\\strike "),Event::End(TagEnd::Strikethrough)=>output.push_str("\\strike0 "),Event::Start(Tag::Heading{level,..})=>output.push_str(&format!("\\b\\fs{} ",match level{pulldown_cmark::HeadingLevel::H1=>40,pulldown_cmark::HeadingLevel::H2=>34,pulldown_cmark::HeadingLevel::H3=>30,pulldown_cmark::HeadingLevel::H4=>26,pulldown_cmark::HeadingLevel::H5=>24,pulldown_cmark::HeadingLevel::H6=>22})),Event::End(TagEnd::Heading(_))=>output.push_str("\\b0\\fs24\\par "),Event::Start(Tag::BlockQuote(_))=>output.push_str("\\li360\\i "),Event::End(TagEnd::BlockQuote(_))=>output.push_str("\\li0\\i0\\par "),Event::Start(Tag::CodeBlock(_))=>output.push_str("\\fmodern "),Event::End(TagEnd::CodeBlock)=>output.push_str("\\f0\\par "),Event::Start(Tag::Item)=>output.push_str("\\bullet\\tab "),Event::End(TagEnd::Item)|Event::End(TagEnd::Paragraph)=>output.push_str("\\par "),Event::End(TagEnd::TableCell)=>output.push_str("\\tab "),Event::End(TagEnd::TableRow)=>output.push_str("\\par "),Event::Start(Tag::Image{dest_url,title,..})=>{image=true;let value=dest_url.as_ref();let encoded=value.split_once(",").filter(|_|value.starts_with("data:image/")).and_then(|(_,data)|STANDARD.decode(data).ok());if let Some(bytes)=encoded{let kind=if value.starts_with("data:image/png"){"\\pngblip"}else if value.starts_with("data:image/jpeg"){"\\jpegblip"}else{""};if !kind.is_empty(){output.push_str("{\\pict");output.push_str(kind);output.push(' ');for byte in bytes{output.push_str(&format!("{byte:02x}"));}output.push('}');}}else{output.push_str("[Image");if !title.is_empty(){output.push_str(": ");Self::rtf_text(&mut output,&title);}output.push(']');}},Event::End(TagEnd::Image)=>image=false,Event::Text(value)|Event::Code(value)if !image=>Self::rtf_text(&mut output,&value),Event::Html(value)|Event::InlineHtml(value)=>{let tag=value.trim().to_ascii_lowercase();if tag=="<u>"{output.push_str("\\ul ");}else if tag=="</u>"{output.push_str("\\ul0 ");}else{Self::rtf_html(&mut output,&value);}},Event::HardBreak|Event::SoftBreak=>output.push_str("\\line "),Event::Rule=>output.push_str("\\par ____________________\\par "),Event::TaskListMarker(done)=>output.push_str(if done{"[x] "}else{"[ ] "}),_=>(),}}output.push('}');output}

    fn render_fragment(markdown: &str, assets: &BTreeMap<String, String>) -> Result<(String, String, Vec<String>), String> {
        if markdown.len() > 65536 || markdown.chars().any(|character| character.is_control() && character != '\n' && character != '\t') { return Err("Rich text must contain at most 65536 UTF-8 bytes; only newline/tab controls are allowed".into()); }
		let syntax=Self::syntax(markdown);
		let parser = Parser::new_ext(&syntax, Self::options());
        let mut found = BTreeSet::new();
        let events = Self::rewrite_assets(parser, assets, &mut found);
        for event in &events {
            match event {
                Event::Start(Tag::Link { dest_url, .. }) if !Self::safe_url(dest_url) || dest_url.trim().to_ascii_lowercase().starts_with("data:") => return Err("Links must use HTTP, HTTPS, mailto, tel, or an anchor".into()),
                Event::Start(Tag::Image { dest_url, .. }) if !(Self::safe_url(dest_url) || dest_url.trim().to_ascii_lowercase().starts_with("data:image/")) => return Err("Images must use HTTP, HTTPS, or a TypeRelay asset".into()),
                _ => (),
            }
        }
        let mut rendered = String::new();
        html::push_html(&mut rendered, events.clone().into_iter());
        let sanitized = Self::sanitizer().clean(&rendered).to_string();
		let mut text = String::new();let mut image_alt:Option<String>=None;
        let mut list_depth = 0usize;
        for event in events {
            match event {
				Event::Text(value)|Event::Code(value)=>if let Some(alt)=&mut image_alt{alt.push_str(&value)}else{text.push_str(&value)},
                Event::Html(value) | Event::InlineHtml(value) => text.push_str(&Self::raw_text(&Self::sanitizer().clean(&value).to_string())),
                Event::Start(Tag::List(_)) => { list_depth += 1; if !text.ends_with('\n') { text.push('\n'); } },
                Event::End(TagEnd::List(_)) => { list_depth = list_depth.saturating_sub(1); if !text.ends_with('\n') { text.push('\n'); } },
                Event::Start(Tag::Item) => { text.push_str(&"  ".repeat(list_depth.saturating_sub(1))); text.push_str("• "); },
                Event::End(TagEnd::Item) | Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Heading(_)) | Event::End(TagEnd::TableRow) | Event::End(TagEnd::CodeBlock) | Event::End(TagEnd::BlockQuote(_)) => if !text.ends_with('\n') { text.push('\n'); },
                Event::End(TagEnd::TableCell) => text.push('\t'),
                Event::HardBreak | Event::SoftBreak | Event::Rule => text.push('\n'),
                Event::TaskListMarker(done) => text.push_str(if done { "[x] " } else { "[ ] " }),
				Event::Start(Tag::Image{..})=>image_alt=Some(String::new()),Event::End(TagEnd::Image)=>{let alt=image_alt.take().unwrap_or_default();text.push_str("[Image");if !alt.is_empty(){text.push_str(": ");text.push_str(&alt);}text.push(']');},
                _ => (),
            }
        }
        while text.contains("\n\n\n") { text = text.replace("\n\n\n", "\n\n"); }
		Ok((text.trim_end().into(), sanitized, found.into_iter().collect()))
    }

    pub fn render(mut request: RichRequest) -> Result<RichRendered, String> {
        request.markdown = request.markdown.replace("\r\n", "\n");
        Self::validate_actions(&request.markdown)?;
		let validated=Template::render(RenderRequest{template:Template{text:request.markdown.clone(),variables:request.variables},values:request.values.clone(),now_ms:request.now_ms,offset_minutes:request.offset_minutes,preview:request.preview})?;let mut marker_values=BTreeMap::new();let mut replacements=BTreeMap::new();for(name,field)in &validated.template.variables{if Template::builtin(name){continue;}let value=request.values.get(name).unwrap_or(&field.default);let value=if request.preview&&value.is_empty(){format!("[{}]",field.label)}else{value.clone()};let marker=format!("TYRELAYVARIABLE{}TOKEN",replacements.len());marker_values.insert(name.clone(),marker.clone());replacements.insert(marker,value);}let rendered=Template::render(RenderRequest{template:validated.template.clone(),values:marker_values,now_ms:request.now_ms,offset_minutes:request.offset_minutes,preview:false})?;
        let mut steps = Vec::new();
        let mut all_assets = BTreeSet::new();
        let mut full_html = String::new();
		let mut full_rtf=String::new();
        let mut full_text = String::new();
        for step in &rendered.steps {
            match step {
                Step::Enter => steps.push(RichStep::Enter),
				Step::Text { text: source } => {let markdown=Self::substitute(source,&replacements)?;
					let (text, html, assets) = Self::render_fragment(&markdown, &request.assets)?;let rtf=Self::rtf(&markdown,&request.assets);
                    all_assets.extend(assets);
                    full_text.push_str(&text);
                    full_html.push_str(&html);
					full_rtf.push_str(rtf.trim_start_matches("{\\rtf1\\ansi\\deff0\\uc1 ").trim_end_matches('}'));
					steps.push(RichStep::Content { markdown, text, html, rtf });
                }
            }
        }
		let rtf=format!("{{\\rtf1\\ansi\\deff0\\uc1 {full_rtf}}}");
        Ok(RichRendered { markdown: request.markdown, text: full_text, html: full_html, rtf, assets: all_assets.into_iter().collect(), variables: rendered.template.variables, fields: rendered.fields, steps, enter_actions: rendered.enter_actions })
    }

    pub fn json(input: &str) -> String {
        let result = serde_json::from_str::<RichRequest>(input).map_err(|error| error.to_string()).and_then(Self::render);
        match result { Ok(rendered) => serde_json::to_string(&rendered).unwrap(), Err(error) => serde_json::json!({"error":error}).to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn render(markdown: &str) -> RichRendered { RichText::render(RichRequest { markdown: markdown.into(), ..Default::default() }).unwrap() }
    #[test]
    fn renders_gfm_and_plain_projection() {
		let value = render("# Heading\n\n- **One**\n- ~~Two~~\n\n| A | B |\n|---|---|\n| C | D |\n\n++Under++\n\n<p style=\"text-align:center\">Centered</p>");
        assert!(value.html.contains("<h1>Heading</h1>"));
        assert!(value.html.contains("<table>"));
        assert!(value.text.contains("Heading"));
        assert!(value.text.contains("• One"));
		assert!(value.html.contains("<u>Under</u>"));assert!(value.html.contains("text-align:center"));assert!(value.rtf.contains("\\ul Under\\ul0"));assert!(value.rtf.contains("\\qc"));
    }
    #[test]
    fn sanitizes_raw_html_and_urls() {
        let value = render("<u onclick=\"bad()\">safe</u><script>bad()</script>");
        assert!(value.html.contains("<u>safe</u>"));
        assert!(!value.html.contains("onclick"));
        assert!(!value.html.contains("<script"));
        assert!(RichText::render(RichRequest { markdown: "[bad](javascript:alert(1))".into(), ..Default::default() }).is_err());
    }
    #[test]
    fn extracts_and_resolves_assets() {
        let id = "a".repeat(64);
        let mut request = RichRequest { markdown: format!("![Logo]({ASSET_PREFIX}{id})"), ..Default::default() };
        request.assets.insert(id.clone(), "data:image/png;base64,AA==".into());
        let value = RichText::render(request).unwrap();
        assert_eq!(value.assets, [id]);
        assert!(value.html.contains("data:image/png;base64,AA=="));
		assert!(value.rtf.contains("\\pngblip 00"));
    }
    #[test]
    fn escapes_answers_and_requires_block_actions() {
        let mut request = RichRequest { markdown: "Hello {{name}}\n\n{{key:enter}}\n\nDone".into(), ..Default::default() };
        request.values.insert("name".into(), "<script>bad()</script> **bold**".into());
        let value = RichText::render(request).unwrap();
        assert!(!value.html.contains("<script>"));
        assert!(!value.html.contains("<strong>bold</strong>"));
        assert_eq!(value.enter_actions, 1);
        assert!(RichText::render(RichRequest { markdown: "Before {{key:enter}} after".into(), ..Default::default() }).is_err());
    }
	#[test]
	fn template_values_are_escaped_by_context(){let mut request=RichRequest{markdown:"[Profile]({{url}})\n\nHello {{name}}\n\n<span title=\"{{name}}\">raw</span>".into(),preview:false,..Default::default()};request.values.insert("url".into(),"https://example.com/a?q=1".into());request.values.insert("name".into(),"<b>*literal*</b>".into());let value=RichText::render(request).unwrap();assert!(value.html.contains("href=\"https://example.com/a?q=1\""));assert!(!value.html.contains("<strong>literal</strong>"));assert!(!value.html.contains("<b>"));let mut bad=RichRequest{markdown:"[Bad]({{url}})".into(),preview:false,..Default::default()};bad.values.insert("url".into(),"javascript:alert(1)".into());assert!(RichText::render(bad).is_err());}
}
