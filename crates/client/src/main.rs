mod config;
#[cfg(target_os = "linux")]
mod omarchy;
#[cfg(target_os = "linux")]
mod clipboard;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "typerelay", version, about = "Headless TypeRelay proof of concept")]
struct Cli { #[command(subcommand)] command: Commands }

#[derive(Subcommand)]
enum Commands {
    Validate { #[arg(long)] file: PathBuf },
    ImportEspanso { source: PathBuf, destination: PathBuf },
    Doctor,
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    ClipboardServe,
    Run { #[arg(long)] file: PathBuf, #[arg(long, default_value = "keyd virtual keyboard")] device_name: String },
}

impl Cli {
    fn execute(self) -> Result<()> {
        match self.command {
            Commands::Validate { file } => {
                let store = config::FileStore::open(file)?;
                println!("Valid: {} snippets", store.snapshot.len());
            }
            Commands::ImportEspanso { source, destination } => config::FileStore::import(&source, &destination)?,
            #[cfg(target_os = "linux")]
            Commands::ClipboardServe => clipboard::PasteJob::serve_restored()?,
            #[cfg(target_os = "linux")]
            Commands::Doctor => omarchy::Session::doctor()?,
            #[cfg(target_os = "linux")]
            Commands::Run { file, device_name } => omarchy::Session::run(config::FileStore::open(file)?, &device_name)?,
            #[cfg(not(target_os = "linux"))]
            _ => anyhow::bail!("This POC adapter supports Omarchy/Hyprland only"),
        }
        Ok(())
    }
}

fn main() -> Result<()> { Cli::parse().execute() }
