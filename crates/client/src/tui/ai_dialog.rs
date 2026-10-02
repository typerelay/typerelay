use anyhow::Result;
use ratatui::{Frame, layout::{Constraint, Layout, Rect, Position}, widgets::{Paragraph, Wrap}};
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEventKind};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::mpsc::{self, Receiver}, time::{Duration, Instant}};
use typerelay_client::native_ai::NativeAi;

pub enum Outcome { Close }
pub struct Dialog { root: PathBuf, pending: Option<(String, Receiver<Result<Value>>)>, status_rx: Option<Receiver<Result<Value>>>, status: Value, checked: Instant, message: String, selection: usize, consent: bool, buttons: Vec<(Rect,KeyCode)> }
impl Dialog {
    pub fn new(root: PathBuf) -> Self { Self { root, pending: None, status_rx: None, status: Value::Null, checked: Instant::now()-Duration::from_secs(2), message: String::new(), selection: 1, consent: false, buttons:Vec::new() } }
    fn cancel(&mut self) { if let Some((id,_)) = self.pending.take() { let root = self.root.clone(); std::thread::spawn(move || { let _ = NativeAi::request(&root,json!({"op":"cancel","id":id})); }); } }
    fn operation(&mut self, request: Value) { if self.pending.is_some() { return; } let root = self.root.clone(); let id = request["id"].as_str().unwrap_or("").to_owned(); let (sender, receiver) = mpsc::channel(); std::thread::spawn(move || { let _ = sender.send(NativeAi::request(&root,request)); }); self.pending = Some((id,receiver)); self.message = "Working…".into(); }
    pub fn tick(&mut self) -> bool {
        let mut changed = false;
        if let Some((_,receiver)) = &self.pending { if let Ok(result) = receiver.try_recv() { self.pending = None; match result { Ok(_) => self.message = "Done".into(), Err(error) => self.message = error.to_string() } changed = true; } }
        if self.status_rx.is_none() && self.checked.elapsed() >= Duration::from_secs(1) { let root = self.root.clone(); let (sender,receiver) = mpsc::channel(); std::thread::spawn(move || { let _ = sender.send(NativeAi::request(&root,json!({"op":"status"}))); }); self.status_rx = Some(receiver); self.checked = Instant::now(); }
        if let Some(receiver) = &self.status_rx { if let Ok(result) = receiver.try_recv() { match result { Ok(status) => self.status = status, Err(error) => self.message = error.to_string() } self.status_rx = None; changed = true; } } changed
    }
    pub fn event(&mut self, event: Event) -> Option<Outcome> {
        if let Event::Mouse(mouse)=&event {if mouse.kind==MouseEventKind::Down(MouseButton::Left){if let Some((_,code))=self.buttons.iter().find(|(area,_)|area.contains(Position::new(mouse.column,mouse.row))){return self.event(Event::Key(KeyEvent::new(*code,KeyModifiers::NONE)));}}}

        if let Event::Key(key) = &event {
            if key.code == KeyCode::Esc { self.cancel(); return Some(Outcome::Close); }
            {
                let models = NativeAi::catalog(); let model = &models[self.selection]; let id = uuid::Uuid::new_v4().to_string();
                if self.consent { self.consent = false; if key.code == KeyCode::Char('y') { self.operation(json!({"op":"download","model":model.id,"id":id})); } return None; }
                match key.code {
                    KeyCode::Up => self.selection = self.selection.saturating_sub(1), KeyCode::Down => self.selection = (self.selection+1).min(models.len()-1),
                    KeyCode::Char('d') => { if self.pending.is_none() { self.consent = true; self.message = format!("Download {} ({:.2} GB, Apache 2.0) and enable?",model.name,model.bytes as f64/1e9); } },
                    KeyCode::Char('e') => self.operation(json!({"op":"enable","model":model.id,"id":id})),
                    KeyCode::Char('x') => self.operation(json!({"op":"disable","id":id})),
                    KeyCode::Char('r') => self.operation(json!({"op":"remove","model":model.id,"id":id})),
                    KeyCode::Char('c') => { let active = self.status["download"].as_str().map(str::to_owned); self.cancel(); if let Some(id) = active { self.operation(json!({"op":"cancel","id":id})); } }, _ => ()
                } return None;
            }
        }
        None
    }
    pub fn draw(&mut self, frame: &mut Frame) {
        let labels:&[&str]=if self.consent{&["Download (y)","Cancel (n)"]}else{&["Download (d)","Enable (e)","Disable (x)","Remove (r)","Cancel download (c)","Back (esc)"]};let height=crate::app::App::button_layout(Rect::new(0,0,frame.area().width,0),labels).last().unwrap().bottom();let rows=Layout::vertical([Constraint::Length(2),Constraint::Min(4),Constraint::Length(2),Constraint::Length(height)]).split(frame.area());
        {
            frame.render_widget(Paragraph::new("TypeRelay / AI models · select model (↑/↓)").wrap(Wrap{trim:false}),rows[0]);
            let models = NativeAi::catalog(); let mut lines = Vec::new();
            for (index,model) in models.iter().enumerate() { let state = self.status["models"].as_array().and_then(|rows|rows.iter().find(|row|row["id"]==model.id)); let downloaded = state.and_then(|row|row["downloaded"].as_u64()).unwrap_or(0); lines.push(format!("{} {} · {:.2} GB · {} · {:.0}% downloaded · RAM: not yet measured",if index==self.selection {">"}else{" "},model.name,model.bytes as f64/1e9,if self.status["model"]==model.id {"enabled"}else if state.is_some_and(|row|row["installed"]==true){"installed"}else{"not installed"},100.0*downloaded as f64/model.bytes as f64)); }
            frame.render_widget(Paragraph::new(lines.join("\n\n")).wrap(Wrap{trim:false}),rows[1]);
        }
        frame.render_widget(Paragraph::new(self.message.as_str()).wrap(Wrap{trim:false}),rows[2]);let keys=if self.consent{vec![KeyCode::Char('y'),KeyCode::Char('n')]}else{vec![KeyCode::Char('d'),KeyCode::Char('e'),KeyCode::Char('x'),KeyCode::Char('r'),KeyCode::Char('c'),KeyCode::Esc]};self.buttons=crate::app::App::button_layout(rows[3],labels).into_iter().zip(keys).collect();for(index,(area,code))in self.buttons.iter().enumerate(){crate::app::App::button(frame,*area,labels[index],self.pending.is_none()||matches!(code,KeyCode::Esc|KeyCode::Char('c')));}

    }
}
impl Drop for Dialog { fn drop(&mut self) { self.cancel(); } }

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::{KeyEvent, KeyModifiers};
    #[test]
    fn dismiss_closes_model_settings_and_download_requires_confirmation() {
        let root=tempfile::tempdir().unwrap();let mut dialog=Dialog::new(root.path().to_path_buf());dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('d'),KeyModifiers::NONE)));assert!(dialog.consent);assert!(dialog.pending.is_none());dialog.event(Event::Key(KeyEvent::new(KeyCode::Char('n'),KeyModifiers::NONE)));assert!(!dialog.consent);assert!(dialog.pending.is_none());assert!(matches!(dialog.event(Event::Key(KeyEvent::new(KeyCode::Esc,KeyModifiers::NONE))),Some(Outcome::Close)));assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
    }
}
