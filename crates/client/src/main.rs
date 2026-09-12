use typerelay_client::config;
#[cfg(target_os = "linux")]
mod omarchy;
#[cfg(target_os = "linux")]
mod clipboard;
#[cfg(target_os = "linux")]
mod installation;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "typerelay", version, about = "Headless TypeRelay proof of concept")]
struct Cli { #[command(subcommand)] command: Commands }

#[derive(Args)]
struct ConfigSource {
    #[arg(long, conflicts_with = "dir")]
    file: Option<PathBuf>,
    #[arg(long)]
    dir: Option<PathBuf>,
}

impl ConfigSource {
    fn path(self) -> Result<PathBuf> {
        if let Some(path) = self.file.or(self.dir) { return Ok(path); }
        Ok(typerelay_client::editor::Paths::config_dir()?.join("snippets"))
    }
}

#[derive(Subcommand)]
enum Commands {
    Validate { #[command(flatten)] source: ConfigSource },
    ImportEspanso { source: PathBuf, destination: PathBuf },
    Doctor,
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    ClipboardServe,
    Run { #[command(flatten)] source: ConfigSource, #[arg(long, default_value = "keyd virtual keyboard")] device_name: String },
    #[cfg(target_os = "linux")]
    Install { #[arg(long)] dry_run: bool },
    #[cfg(target_os = "linux")]
    Uninstall { #[arg(long)] dry_run: bool },
}

impl Cli {
    fn execute(self) -> Result<()> {
        match self.command {
            Commands::Validate { source } => {
                let store = config::FileStore::open(source.path()?)?;
                println!("Valid: {} snippets", store.snapshot.len());
            }
            Commands::ImportEspanso { source, destination } => config::FileStore::import(&source, &destination)?,
            #[cfg(target_os = "linux")]
            Commands::ClipboardServe => clipboard::PasteJob::serve_restored()?,
            #[cfg(target_os = "linux")]
            Commands::Doctor => omarchy::Session::doctor()?,
            #[cfg(target_os = "linux")]
            Commands::Run { source, device_name } => omarchy::Session::run(config::FileStore::open(source.path()?)?, &device_name)?,
            #[cfg(target_os = "linux")]
            Commands::Install { dry_run } => installation::Installer::run("install", dry_run)?,
            #[cfg(target_os = "linux")]
            Commands::Uninstall { dry_run } => installation::Installer::run("uninstall", dry_run)?,
            #[cfg(not(target_os = "linux"))]
            _ => anyhow::bail!("This POC adapter supports Omarchy/Hyprland only"),
        }
        Ok(())
    }
}

fn main() -> std::process::ExitCode {
    match Cli::parse().execute() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error:#}");
            #[cfg(target_os = "linux")]
            if error.downcast_ref::<omarchy::Interference>().is_some() { return std::process::ExitCode::from(78); }
            std::process::ExitCode::FAILURE
        }
    }
}
