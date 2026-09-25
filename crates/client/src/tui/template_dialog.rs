use std::collections::BTreeMap;
use anyhow::{Result,ensure};
use ratatui::{Frame,layout::{Constraint,Layout,Rect},style::{Style,Color},widgets::{Block,Borders,List,ListItem,ListState,Paragraph,Wrap}};
use ratatui::crossterm::event::{Event,KeyCode,KeyEventKind,KeyModifiers};
use ratatui_textarea::TextArea;
use typerelay_core::template::{Template,Variable,Rendered,Step};
use typerelay_client::templates::Templates;

pub enum Outcome { Cancel, Definition { name:String, variable:Option<Variable>, insert:bool }, Copy { rendered:Rendered, values:BTreeMap<String,String> } }
pub struct Dialog { template:Template, fill:bool, choosing:bool, names:Vec<String>, labels:Vec<String>, inputs:Vec<TextArea<'static>>, index:usize, name:String, variable:Variable, error:String }
impl Dialog {
    fn text(value:&str)->TextArea<'static>{TextArea::new(value.split('\n').map(str::to_owned).collect())}
    pub fn variables(template:Template)->Result<Self>{let template=template.normalize().map_err(anyhow::Error::msg)?;let mut names=vec!["New text field".into(),"date".into(),"time".into(),"timestamp".into(),"key:enter".into()];names.extend(template.variables.keys().filter(|name|!Template::builtin(name)).cloned());Ok(Self{template,fill:false,choosing:true,names,labels:vec![],inputs:vec![],index:0,name:String::new(),variable:Variable::default(),error:String::new()})}
    pub fn fill(template:Template)->Result<Self>{let template=template.normalize().map_err(anyhow::Error::msg)?;let names=template.fields().map_err(anyhow::Error::msg)?;let labels=names.iter().map(|name|template.variables[name].label.clone()).collect();let inputs=names.iter().map(|name|Self::text(&template.variables[name].default)).collect();Ok(Self{template,fill:true,choosing:false,names,labels,inputs,index:0,name:String::new(),variable:Variable::default(),error:String::new()})}
    fn answers(&self)->BTreeMap<String,String>{self.names.iter().zip(&self.inputs).map(|(name,input)|(name.clone(),input.lines().join("\n"))).collect()}
    fn render(&self,preview:bool)->Result<Rendered>{Templates::render(&serde_json::json!({"type":"template","text":self.template.text,"variables":self.template.variables}),self.answers(),preview)}
    fn definition(&self)->Result<(String,Variable)> {
        let values:BTreeMap<_,_>=self.labels.iter().zip(&self.inputs).map(|(label,input)|(label.as_str(),input.lines().join("\n"))).collect();
        let name=values.get("Name").cloned().unwrap_or_else(||self.name.clone());
        ensure!(!name.is_empty()&&name.len()<=63&&name.bytes().enumerate().all(|(i,c)|c.is_ascii_alphabetic()||c==b'_'||(i>0&&c.is_ascii_digit())),"Use a name such as customer_name");
        if self.name.is_empty(){ensure!(!Template::builtin(&name),"Choose the built-in from the picker instead");}
        let mut variable=self.variable.clone();
        if let Some(value)=values.get("Label"){variable.label=value.clone();}
        if let Some(value)=values.get("Default"){variable.default=value.clone();}
        let test=Template{text:format!("{{{{{name}}}}}"),variables:BTreeMap::from([(name.clone(),variable.clone())])};test.normalize().map_err(anyhow::Error::msg)?;
        Ok((name,variable))
    }
    pub fn event(&mut self,event:Event)->Option<Outcome>{match self.handle(event){Ok(value)=>value,Err(error)=>{self.error=error.to_string();None}}}
    fn handle(&mut self,event:Event)->Result<Option<Outcome>>{
        let key=match event { Event::Key(key)=>key,Event::Paste(text)=>{if !self.choosing&&self.index<self.inputs.len(){let label=self.labels[self.index].as_str();if self.fill||matches!(label,"Name"|"Label"|"Default"){let multiline=if self.fill{self.template.variables[&self.names[self.index]].multiline}else{label=="Default"&&self.variable.multiline};let text=text.replace("\r\n","\n");ensure!(multiline||!text.contains('\n'),"Enable multiline before pasting multiple lines");self.inputs[self.index].insert_str(text);}}return Ok(None)},_=>return Ok(None)};if key.kind==KeyEventKind::Release{return Ok(None)};
        if key.code==KeyCode::Esc{return Ok(Some(Outcome::Cancel))}
        if self.choosing {
            match key.code {
                KeyCode::Up=>self.index=self.index.saturating_sub(1),KeyCode::Down=>self.index=(self.index+1).min(self.names.len()-1),
                KeyCode::Enter=>{
                    self.name=if self.index==0{String::new()}else{self.names[self.index].clone()};
                    if self.name=="key:enter"{return Ok(Some(Outcome::Definition{name:self.name.clone(),variable:None,insert:true}))}
                    self.variable=self.template.variables.get(&self.name).cloned().unwrap_or_default();
                    self.labels=if Template::builtin(&self.name){vec!["Label".into(),"Format".into(),"Timezone".into()]}else{let mut labels=vec![];if self.name.is_empty(){labels.push("Name".into());}labels.extend(["Label","Default","Required","Multiline"].map(str::to_owned));labels};
                    self.inputs=self.labels.iter().map(|label|Self::text(match label.as_str(){"Label"=>&self.variable.label,"Default"=>&self.variable.default,_=>""})).collect();self.index=0;self.choosing=false;
                },_=>()
            };return Ok(None)
        }
        let copy_key=self.fill&&matches!(key.code,KeyCode::Char('c'|'C'))&&key.modifiers.intersects(KeyModifiers::CONTROL|KeyModifiers::SUPER|KeyModifiers::META);
        if (key.modifiers.contains(KeyModifiers::CONTROL)&&key.code==KeyCode::Char('s'))||key.code==KeyCode::F(4)||copy_key{
			if self.fill{return Ok(Some(Outcome::Copy{rendered:self.render(false)?,values:self.answers()}))}
            let (name,variable)=self.definition()?;let insert=key.code!=KeyCode::F(4);ensure!(insert||self.template.variables.contains_key(&name),"Insert a new variable first");return Ok(Some(Outcome::Definition{name,variable:Some(variable),insert}))
        }
        if self.labels.is_empty(){return Ok(None)}
        if matches!(key.code,KeyCode::Tab|KeyCode::BackTab|KeyCode::F(2)){
            let backwards=key.code==KeyCode::BackTab||key.modifiers.contains(KeyModifiers::SHIFT);self.index=if backwards{(self.index+self.labels.len()-1)%self.labels.len()}else{(self.index+1)%self.labels.len()};return Ok(None)
        }
        let label=self.labels[self.index].as_str();
        if !self.fill&&matches!(label,"Required"|"Multiline"|"Format"|"Timezone"){
            if matches!(key.code,KeyCode::Char(' ')|KeyCode::Left|KeyCode::Right|KeyCode::Enter){match label{
                "Required"=>self.variable.required= !self.variable.required,"Multiline"=>self.variable.multiline= !self.variable.multiline,
                "Timezone"=>self.variable.timezone=if self.variable.timezone=="utc"{"local"}else{"utc"}.into(),
                "Format"=>{let formats=["","YYYY-MM-DD","DD/MM/YYYY","MM/DD/YYYY","HH:mm","HH:mm:ss","YYYY-MM-DD HH:mm","ISO"];let index=formats.iter().position(|f|*f==self.variable.format).unwrap_or(0);self.variable.format=formats[(index+1)%formats.len()].into();},_=>()
            }}return Ok(None)
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)&&key.code==KeyCode::Char('t'){self.inputs[self.index].insert_str("\t");return Ok(None)}
        let multiline=if self.fill{self.template.variables[&self.names[self.index]].multiline}else{label=="Default"&&self.variable.multiline};
        if key.code==KeyCode::Enter&&!multiline{return Ok(None)}
        self.inputs[self.index].input(Event::Key(key));Ok(None)
    }
    pub fn draw(&mut self,frame:&mut Frame,area:Rect){
        let rows=Layout::vertical([Constraint::Length(2),Constraint::Min(5),Constraint::Length(3)]).split(area);
        frame.render_widget(Paragraph::new(if self.choosing{"Insert/edit variable · Enter chooses"}else if self.fill{"Fill and copy · Values stay local"}else{"Variable settings"}),rows[0]);
        if self.choosing {let items=self.names.iter().map(|name|ListItem::new(name.as_str())).collect::<Vec<_>>();frame.render_stateful_widget(List::new(items).block(Block::default().borders(Borders::ALL)).highlight_style(Style::default().bg(Color::DarkGray)),rows[1],&mut ListState::default().with_selected(Some(self.index)));}
        else {
            let columns=Layout::horizontal([Constraint::Percentage(32),Constraint::Percentage(68)]).split(rows[1]);
            let labels=self.labels.iter().map(|label|ListItem::new(label.as_str())).collect::<Vec<_>>();frame.render_stateful_widget(List::new(labels).block(Block::default().borders(Borders::ALL)).highlight_style(Style::default().bg(Color::DarkGray)),columns[0],&mut ListState::default().with_selected(Some(self.index)));
            let parts=Layout::vertical([Constraint::Length(5),Constraint::Min(3)]).split(columns[1]);
            if let Some(label)=self.labels.get(self.index){let selected=if !self.fill{match label.as_str(){"Required"=>Some(self.variable.required.to_string()),"Multiline"=>Some(self.variable.multiline.to_string()),"Format"=>Some(if self.variable.format.is_empty(){"Default".into()}else{self.variable.format.clone()}),"Timezone"=>Some(self.variable.timezone.clone()),_=>None}}else{None};
                if let Some(value)=selected{frame.render_widget(Paragraph::new(format!("{value}\nSpace / Left / Right changes")).block(Block::default().borders(Borders::ALL).title(label.as_str())),parts[0]);}else{self.inputs[self.index].set_block(Block::default().borders(Borders::ALL).title(label.clone()));frame.render_widget(&self.inputs[self.index],parts[0]);}
            }
            let preview=if self.fill{self.render(true).map(|result|result.steps.iter().map(|step|match step{Step::Text{text}=>text.clone(),Step::Enter=>"⏎ [Enter key]".into()}).collect::<String>())}else{self.definition().and_then(|(name,variable)|Templates::render(&serde_json::json!({"type":"template","text":format!("{{{{{name}}}}}"),"variables":{name:variable}}),BTreeMap::new(),true).map(|r|r.text))};
            frame.render_widget(Paragraph::new(preview.unwrap_or_default()).block(Block::default().borders(Borders::ALL).title("Preview · Copy omits Enter actions")).wrap(Wrap{trim:false}),parts[1]);
        }
        frame.render_widget(Paragraph::new(format!("{}\n{}",self.error,if self.fill{"Tab / F2 next · Ctrl+T tab character · Ctrl+C Copy · Esc cancel"}else{"Tab / F2 next · Ctrl+T tab character · Ctrl+S Insert · F4 save settings only · Esc cancel"})).wrap(Wrap{trim:false}),rows[2]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::KeyEvent;
    #[test] fn fill_is_explicit_and_keeps_values_literal(){
        let mut dialog=Dialog::fill(Template{text:"Hi {{name}} {{name}}{{key:enter}}".into(),variables:BTreeMap::new()}).unwrap();
        assert!(dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('s'),KeyModifiers::CONTROL))).is_none());
        dialog.inputs[0]=Dialog::text("{{date}}");
        let Some(Outcome::Copy{rendered:result,..})=dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('s'),KeyModifiers::CONTROL))) else{panic!("Expected copy")};
        assert_eq!(result.text,"Hi {{date}} {{date}}");assert_eq!(result.enter_actions,1);
    }
    #[test] fn fill_accepts_copy_shortcuts(){
        for modifiers in [KeyModifiers::CONTROL,KeyModifiers::SUPER,KeyModifiers::META]{
            let mut dialog=Dialog::fill(Template{text:"Hi {{name}}".into(),variables:BTreeMap::new()}).unwrap();
            dialog.inputs[0]=Dialog::text("Ada");
            let Some(Outcome::Copy{rendered,..})=dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('c'),modifiers)))else{panic!("Expected copy")};
            assert_eq!(rendered.text,"Hi Ada");
        }
    }
    #[test] fn picker_inserts_enter_as_action_and_escape_cancels(){let mut dialog=Dialog::variables(Template{text:"Hello".into(),variables:BTreeMap::new()}).unwrap();dialog.index=4;assert!(matches!(dialog.event(Event::Key(KeyEvent::new(KeyCode::Enter,KeyModifiers::NONE))),Some(Outcome::Definition{variable:None,..})));assert!(matches!(dialog.event(Event::Key(KeyEvent::new(KeyCode::Esc,KeyModifiers::NONE))),Some(Outcome::Cancel)));}
}
