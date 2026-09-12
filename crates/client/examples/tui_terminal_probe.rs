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
        let (_guard, _terminal) = terminal::TerminalSession::enter()?;
        while running.load(Ordering::SeqCst) && terminal::TerminalSession::connected() {
            if ratatui::crossterm::event::poll(Duration::from_millis(100))? { let _ = ratatui::crossterm::event::read()?; }
        }
        Ok(())
    }
}
fn main() -> anyhow::Result<()> { Probe::run() }
