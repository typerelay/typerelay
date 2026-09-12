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
    Migrate { #[command(flatten)] source: ConfigSource, #[arg(long)] check: bool, #[arg(long)] settings: Option<PathBuf>, #[arg(long)] json: bool },
    Doctor,
    Connect { #[arg(long)] server: Option<String>, #[arg(long)] no_browser: bool },
    Enroll { filename: String },
    Sync,
    Disconnect,
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
        let root = typerelay_client::editor::Paths::config_dir()?;
        match self.command {
            Commands::Connect { server, no_browser } => { let server = server.unwrap_or(typerelay_client::settings::SettingsStore::open(root.join("settings.yml"))?.settings.sync_url); typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.connect(&server, !no_browser)?; },
            Commands::Enroll { filename } => typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.enroll(&filename)?,
            Commands::Sync => typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.cycle()?,
            Commands::Disconnect => typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.disconnect()?,
            Commands::Validate { source } => {
                let store = config::FileStore::open(source.path()?)?;
                println!("Valid: {} snippets", store.snapshot.len());
            }
            Commands::ImportEspanso { source, destination } => config::FileStore::import(&source, &destination)?,
            Commands::Migrate { source, check, settings, json } => {
                let settings = settings.unwrap_or(typerelay_client::editor::Paths::config_dir()?.join("settings.yml"));
                let report = typerelay_client::migration::Migration::run(&source.path()?, &settings, check)?;
                if json { println!("{}", serde_json::to_string(&report)?); return Ok(()); }
                println!("{}: {} triggers, {} files", if check { "Migration preview" } else { "Migration complete" }, report.snippets, report.files);
                if let Some(backup) = report.backup { println!("Backups: {}", backup.display()); }
            }
            #[cfg(target_os = "linux")]
            Commands::ClipboardServe => clipboard::PasteJob::serve_restored()?,
            #[cfg(target_os = "linux")]
            Commands::Doctor => omarchy::Session::doctor()?,
            #[cfg(target_os = "linux")]
            Commands::Run { source, device_name } => {
                let path = source.path()?;
                if path.is_dir() { typerelay_client::sync::Sync::worker(root, path.clone()); }
                omarchy::Session::run(config::FileStore::open(path)?, &device_name)?;
            },
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
