//! Isolated PTY regression probe using the same terminal lifecycle and reader as the TUI.
#[path = "../src/tui/terminal.rs"]
mod terminal;
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};

struct Probe;
impl Probe {
    fn run() -> anyhow::Result<()> {
        let running = Arc::new(AtomicBool::new(true));
        let signal = running.clone();
        ctrlc::set_handler(move || signal.store(false, Ordering::SeqCst))?;
        let (_guard, mut screen) = terminal::TerminalSession::enter()?;
        screen.draw(|frame| frame.render_widget(ratatui::widgets::Paragraph::new("TypeRelay terminal probe"), frame.area()))?;
        while running.load(Ordering::SeqCst) && terminal::TerminalSession::connected() {
            if ratatui::crossterm::event::poll(Duration::from_millis(100))? && let ratatui::crossterm::event::Event::Key(key) = ratatui::crossterm::event::read()? && key.code == ratatui::crossterm::event::KeyCode::Char('q') { break; }
        }
        Ok(())
    }
}
fn main() -> anyhow::Result<()> { Probe::run().or_else(|error| if terminal::TerminalSession::connected() { Err(error) } else { Ok(()) }) }
