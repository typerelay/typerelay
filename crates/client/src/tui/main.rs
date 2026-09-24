mod app;
mod template_dialog;
mod terminal;
use anyhow::{Result, ensure};
use clap::Parser;
use ratatui::crossterm::event::{self, Event, KeyEventKind, MouseEventKind};
use std::{io::IsTerminal, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use typerelay_client::{editor::{EditorStore, Paths}, settings::SettingsStore};

#[derive(Parser)]
#[command(name = "typerelay-tui", version = env!("TYPERELAY_VERSION"), about = "Edit TypeRelay snippet files")]
struct Cli { #[arg(long)] dir: Option<PathBuf> }

impl Cli {
    fn run(self) -> Result<()> {
        ensure!(std::io::stdin().is_terminal() && std::io::stdout().is_terminal(), "Run typerelay-tui in an interactive terminal");
        let running = Arc::new(AtomicBool::new(true));
        let signal = running.clone();
        ctrlc::set_handler(move || signal.store(false, Ordering::SeqCst))?;
        let config = Paths::config_dir()?;
        let store = EditorStore::new(self.dir.unwrap_or(config.join("snippets")))?;
        let settings = SettingsStore::open(config.join("settings.yml"))?;
        typerelay_client::sync::Sync::worker(config, store.directory.clone());
        let database = typerelay_client::database::Database::open(&store.directory)?;
        let mut generation = database.generation()?;
        let mut app = app::App::new(store, settings)?;
        #[cfg(target_os = "linux")]
        let _registration = typerelay_client::desktop::Registration::current_window()?;
        let (_guard, mut terminal) = terminal::TerminalSession::enter()?;
        let interval = Duration::from_millis(33);
        let mut last_draw = Instant::now() - interval;
        let mut dirty = true;
        let mut sync_status = Vec::new();
        while !app.quit && running.load(Ordering::SeqCst) && terminal::TerminalSession::connected() {
            if let Ok(next) = database.generation() && next != generation { generation = next; app.refresh(); dirty = true; }
            let next_status = Paths::config_dir().ok().and_then(|root| std::fs::read(root.join("sync/status")).ok()).unwrap_or_default();
            if next_status != sync_status { sync_status = next_status; dirty = true; }
            if dirty && last_draw.elapsed() >= interval {
                terminal.draw(|frame| app.draw(frame))?;
                dirty = false;
                last_draw = Instant::now();
            }
            let timeout = if dirty { interval.saturating_sub(last_draw.elapsed()) } else { Duration::from_millis(250) };
            if event::poll(timeout)? {
                let input = terminal::TerminalSession::normalize(event::read()?);
                if matches!(&input, Event::Mouse(mouse) if mouse.kind == MouseEventKind::Moved) || matches!(&input, Event::Key(key) if key.kind == KeyEventKind::Release) { continue; }
                app.handle(input);
                dirty = true;
            }
        }
        Ok(())
    }
}

fn main() -> Result<()> {
    let interactive = std::io::stdin().is_terminal();
    Cli::parse().run().or_else(|error| if interactive && !terminal::TerminalSession::connected() { Ok(()) } else { Err(error) })
}
