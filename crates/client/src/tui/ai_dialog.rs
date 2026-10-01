use anyhow::Result;
use ratatui::{Frame, layout::{Constraint, Layout}, widgets::{Block, Borders, Paragraph, Wrap}};
use ratatui::crossterm::event::{Event, KeyCode, KeyModifiers};
use ratatui_textarea::TextArea;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::mpsc::{self, Receiver}, time::{Duration, Instant}};
use typerelay_client::{config::Match, native_ai::NativeAi};

pub enum Outcome { Close, Apply(Match) }
pub struct Dialog { root: PathBuf, original: Option<Match>, prompt: TextArea<'static>, action: usize, proposal: Option<Match>, pending: Option<(String, Receiver<Result<Value>>)>, status_rx: Option<Receiver<Result<Value>>>, status: Value, checked: Instant, message: String, selection: usize, consent: bool }
impl Dialog {
    pub fn new(root: PathBuf, original: Option<Match>) -> Self { Self { root, original, prompt: TextArea::default(), action: 0, proposal: None, pending: None, status_rx: None, status: Value::Null, checked: Instant::now()-Duration::from_secs(2), message: String::new(), selection: 1, consent: false } }
    fn cancel(&mut self) { if let Some((id,_)) = self.pending.take() { let root = self.root.clone(); std::thread::spawn(move || { let _ = NativeAi::request(&root,json!({"op":"cancel","id":id})); }); } }
    fn operation(&mut self, request: Value) { if self.pending.is_some() { return; } let root = self.root.clone(); let id = request["id"].as_str().unwrap_or("").to_owned(); let (sender, receiver) = mpsc::channel(); std::thread::spawn(move || { let _ = sender.send(NativeAi::request(&root,request)); }); self.pending = Some((id,receiver)); self.message = "Working… Esc cancels".into(); }
    pub fn tick(&mut self) -> bool {
        let mut changed = false;
        if let Some((_,receiver)) = &self.pending { if let Ok(result) = receiver.try_recv() { self.pending = None; match result { Ok(value) => { if self.original.is_some() { match serde_json::from_value(value) { Ok(draft) => { self.proposal = Some(draft); self.message = "Ctrl+U Use draft · Esc Discard. Ctrl+S saves after applying.".into(); }, Err(error) => self.message = error.to_string() } } else { self.message = "Done".into(); } }, Err(error) => self.message = error.to_string() } changed = true; } }
        if self.original.is_none() && self.status_rx.is_none() && self.checked.elapsed() >= Duration::from_secs(1) { let root = self.root.clone(); let (sender,receiver) = mpsc::channel(); std::thread::spawn(move || { let _ = sender.send(NativeAi::request(&root,json!({"op":"status"}))); }); self.status_rx = Some(receiver); self.checked = Instant::now(); }
        if let Some(receiver) = &self.status_rx { if let Ok(result) = receiver.try_recv() { match result { Ok(status) => self.status = status, Err(error) => self.message = error.to_string() } self.status_rx = None; changed = true; } } changed
    }
    pub fn event(&mut self, event: Event) -> Option<Outcome> {
        if let Event::Key(key) = &event {
            if key.code == KeyCode::Esc { self.cancel(); return Some(Outcome::Close); }
            if self.original.is_none() {
                let models = NativeAi::catalog(); let model = &models[self.selection]; let id = uuid::Uuid::new_v4().to_string();
                if self.consent { self.consent = false; if key.code == KeyCode::Char('y') { self.operation(json!({"op":"download","model":model.id,"id":id})); } return None; }
                match key.code {
                    KeyCode::Up => self.selection = self.selection.saturating_sub(1), KeyCode::Down => self.selection = (self.selection+1).min(models.len()-1),
                    KeyCode::Char('d') => { if self.pending.is_none() { self.consent = true; self.message = format!("Download {} ({:.2} GB, Apache 2.0) and enable? y confirms; any other key cancels.",model.name,model.bytes as f64/1e9); } },
                    KeyCode::Char('e') => self.operation(json!({"op":"enable","model":model.id,"id":id})),
                    KeyCode::Char('x') => self.operation(json!({"op":"disable","id":id})),
                    KeyCode::Char('r') => self.operation(json!({"op":"remove","model":model.id,"id":id})),
                    KeyCode::Char('c') => { let active = self.status["download"].as_str().map(str::to_owned); self.cancel(); if let Some(id) = active { self.operation(json!({"op":"cancel","id":id})); } }, _ => ()
                } return None;
            }
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('u') { if let Some(proposal) = self.proposal.take() { return Some(Outcome::Apply(proposal)); } }
            if self.pending.is_some() || self.proposal.is_some() { return None; }
            if let KeyCode::F(number @ 1..=4) = key.code { self.action = number as usize-1; return None; }
            if key.code == KeyCode::Enter && key.modifiers.contains(KeyModifiers::CONTROL) {
                let root = self.root.clone(); let draft = self.original.clone().unwrap(); let instruction = format!("{}. {}",["Generate","Improve","Translate","Make template using the existing variables"][self.action],self.prompt.lines().join("\n")); let id = uuid::Uuid::new_v4().to_string(); let job_id = id.clone(); let (sender, receiver) = mpsc::channel();
                std::thread::spawn(move || { let _ = sender.send(NativeAi::author(&root,&draft,&instruction,&job_id).and_then(|value|Ok(serde_json::to_value(value)?))); }); self.pending = Some((id,receiver)); self.message = "Generating locally… Esc cancels".into(); return None;
            }
        }
        if self.original.is_some() && self.pending.is_none() && self.proposal.is_none() { self.prompt.input(event); } None
    }
    pub fn draw(&mut self, frame: &mut Frame) {
        let rows = Layout::vertical([Constraint::Length(3),Constraint::Min(4),Constraint::Length(4)]).split(frame.area());
        if self.original.is_none() {
            frame.render_widget(Paragraph::new("Typerelay / On-device AI · ↑↓ Model · d Download/resume · e Enable · x Disable · r Remove · c Cancel download · Esc Back").wrap(Wrap{trim:false}),rows[0]);
            let models = NativeAi::catalog(); let mut lines = Vec::new();
            for (index,model) in models.iter().enumerate() { let state = self.status["models"].as_array().and_then(|rows|rows.iter().find(|row|row["id"]==model.id)); let downloaded = state.and_then(|row|row["downloaded"].as_u64()).unwrap_or(0); lines.push(format!("{} {} · {:.2} GB · {} · {:.0}% downloaded · RAM: not yet measured",if index==self.selection {">"}else{" "},model.name,model.bytes as f64/1e9,if self.status["model"]==model.id {"enabled"}else if state.is_some_and(|row|row["installed"]==true){"installed"}else{"not installed"},100.0*downloaded as f64/model.bytes as f64)); }
            frame.render_widget(Paragraph::new(lines.join("\n\n")).wrap(Wrap{trim:false}),rows[1]);
        } else {
            frame.render_widget(Paragraph::new(format!("Typerelay / {} · F1 Generate · F2 Improve · F3 Translate · F4 Make template · Ctrl+Enter Run · Esc Discard",["Generate","Improve","Translate","Make template"][self.action])).wrap(Wrap{trim:false}),rows[0]);
            if let Some(proposal) = &self.proposal { frame.render_widget(Paragraph::new(proposal.replace.as_str()).wrap(Wrap{trim:false}).block(Block::default().borders(Borders::ALL).title("Proposal · Ctrl+U Use draft")),rows[1]); } else { self.prompt.set_block(Block::default().borders(Borders::ALL).title("Instructions")); frame.render_widget(&self.prompt,rows[1]); }
        }
        frame.render_widget(Paragraph::new(self.message.as_str()).wrap(Wrap{trim:false}),rows[2]);
    }
}
impl Drop for Dialog { fn drop(&mut self) { self.cancel(); } }

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::KeyEvent;
    #[test]
    fn use_draft_returns_a_proposal_without_saving_it() {
        let root=tempfile::tempdir().unwrap();let original=Match{replace:"Original".into(),..Default::default()};let mut dialog=Dialog::new(root.path().to_path_buf(),Some(original.clone()));let proposal=Match{replace:"Proposed".into(),..original.clone()};dialog.proposal=Some(proposal.clone());
        assert!(matches!(dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('u'),KeyModifiers::CONTROL))),Some(Outcome::Apply(value)) if value==proposal));assert_eq!(dialog.original,Some(original));assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
    }
    #[test]
    fn dismiss_discards_proposal_and_download_requires_confirmation() {
        let root=tempfile::tempdir().unwrap();let mut dialog=Dialog::new(root.path().to_path_buf(),None);dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('d'),KeyModifiers::NONE)));assert!(dialog.consent);assert!(dialog.pending.is_none());dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('n'),KeyModifiers::NONE)));assert!(!dialog.consent);assert!(dialog.pending.is_none());assert!(matches!(dialog.event(Event::Key(KeyEvent::new(KeyCode::Esc,KeyModifiers::NONE))),Some(Outcome::Close)));assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
    }
}
