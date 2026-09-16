use typerelay_client::config;
#[cfg(target_os = "linux")]
mod omarchy;
#[cfg(target_os = "linux")]
use typerelay_client::clipboard;
#[cfg(target_os = "linux")]
mod installation;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "typerelay", version, about = "TypeRelay command-line tools for snippets and synchronization")]
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
    /// Validate snippet files or the local library database.
    Validate { #[command(flatten)] source: ConfigSource },
    #[command(hide = true)]
    ImportEspanso { source: PathBuf, destination: PathBuf },
    /// Upgrade legacy comma-prefixed YAML triggers to bare abbreviations.
    #[command(long_about = "Upgrade legacy YAML triggers (for example, ,hello becomes hello) and add the local trigger_prefix setting if missing. Existing settings are preserved. Changed files are backed up before writing. This does not import libraries into the database. Use --check to preview without writing.")]
    Migrate { #[command(flatten)] source: ConfigSource, #[arg(long)] check: bool, #[arg(long)] settings: Option<PathBuf>, #[arg(long)] json: bool },
    #[cfg(target_os = "linux")]
    /// Check the Omarchy session and required tools.
    Doctor,
    /// Connect this device to a TypeRelay server.
    Connect { #[arg(long)] server: Option<String>, #[arg(long)] no_browser: bool },
    /// Queue a local library for synchronization.
    Enroll { filename: String },
    /// Synchronize now and print the resulting status.
    Sync,
    /// Disconnect this device and keep local libraries.
    Disconnect,
    /// Import snippets; choose yaml, bundle, or espanso.
    Import { #[command(subcommand)] format: ImportFormat },
    /// Export a library as YAML or a .typerelay.zip bundle.
    Export { name: String, destination: PathBuf },
    #[command(hide = true)]
    Inspect,
    #[command(hide = true)]
    DatabaseEdit { name: String, trigger: String, #[arg(long)] text: Option<String>, #[arg(long)] trash: bool },
    #[command(hide = true)]
    DatabaseReplay { operation: String },
    #[command(hide = true)]
    DatabaseBatch { source: String, #[arg(long)] destination: Option<String>, #[arg(long, num_args=1..)] triggers: Vec<String> },
    /// List, restore, or permanently empty trashed items.
    Trash { #[arg(long)] restore: Option<String>, #[arg(long)] empty: bool, #[arg(long)] yes: bool },
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    ClipboardServe,
    #[cfg(target_os = "linux")]
    /// Run the text expansion engine.
    Run { #[command(flatten)] source: ConfigSource, #[arg(long, default_value = "keyd virtual keyboard")] device_name: String },
    #[cfg(target_os = "linux")]
    /// Install the Omarchy service and device access.
    Install { #[arg(long)] dry_run: bool },
	#[cfg(target_os = "linux")]
	Uninstall { #[arg(long)] dry_run: bool },
	#[cfg(target_os = "linux")]
	#[command(hide = true)]
	Update,
}

#[derive(Subcommand)]
enum ImportFormat {
    /// Import TypeRelay YAML into a local library.
    Yaml { source: PathBuf, #[arg(long)] name: String },
    /// Import a TypeRelay ZIP bundle, including images, into a local library.
    Bundle { source: PathBuf, #[arg(long)] name: String },
    /// Convert static Espanso matches to a new TypeRelay YAML file.
    Espanso { source: PathBuf, destination: PathBuf },
}

impl Cli {
    fn execute(self) -> Result<()> {
        let root = typerelay_client::editor::Paths::config_dir()?;
        match self.command {
            Commands::Connect { server, no_browser } => { let server = server.unwrap_or(typerelay_client::settings::SettingsStore::open(root.join("settings.yml"))?.settings.sync_url); typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.connect(&server, !no_browser, false)?; println!("Connected to {server}."); },
            Commands::Enroll { filename } => typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.enroll(&filename)?,
            Commands::Sync => { println!("Synchronizing…"); typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.cycle()?; println!("{}", std::fs::read_to_string(root.join("sync/status"))?); },
            Commands::Import { format } => match format {
                ImportFormat::Espanso { source, destination } => config::FileStore::import(&source, &destination)?,
                format => {
                    let bundle = matches!(format, ImportFormat::Bundle { .. });
                    let (ImportFormat::Yaml { source, name } | ImportFormat::Bundle { source, name }) = format else { unreachable!() };
                    let db = typerelay_client::database::Database::open(&root.join("snippets"))?;
                    if bundle { db.import_bundle(&name, &source)?; } else { db.import(&name, &std::fs::read_to_string(&source)?)?; }
                    println!("Imported {} into local library {name}.", source.display());
                }
            },
            Commands::Export { name, destination } => { typerelay_client::database::Database::open(&root.join("snippets"))?.export(&name, &destination)?; println!("Exported {name} to {}.", destination.display()); },
            Commands::DatabaseEdit { name, trigger, text, trash } => { let db = typerelay_client::database::Database::open(&root.join("snippets"))?; let file = db.editor(&name)?; let index = file.entries.iter().position(|entry|entry.trigger == trigger); anyhow::ensure!(!trash || index.is_some(), "Snippet missing"); db.edit(&file, index, if trash { None } else { Some(config::Match { trigger, replace: text.ok_or_else(||anyhow::anyhow!("Text required"))?, ..index.map(|i|file.entries[i].clone()).unwrap_or_default() }) })?; },
            Commands::DatabaseBatch { source, destination, triggers } => {
                let db = typerelay_client::database::Database::open(&root.join("snippets"))?;
                let file = db.editor(&source)?;
                let ids: Vec<_> = file.entries.iter().enumerate().filter(|(_,entry)|triggers.contains(&entry.trigger)).map(|(index,_)|file.ids[index].clone()).collect();
                anyhow::ensure!(ids.len() == triggers.len(), "Selected snippet missing");
                let destination = destination.map(|name|db.editor(&name).map(|file|file.id)).transpose()?;
                db.batch(&file.id, destination.as_deref(), &db.batch_items(&file, &ids)?)?;
            },
            Commands::DatabaseReplay { operation } => { typerelay_client::database::Database::open(&root.join("snippets"))?.queue(&serde_json::from_str(&operation)?)?; },
            Commands::Inspect => { let db = typerelay_client::database::Database::open(&root.join("snippets"))?; let libraries: Vec<_> = db.libraries()?.into_iter().map(|mut library| { library["records"] = serde_json::json!(db.records(library["_id"].as_str().unwrap()).unwrap()); library }).collect(); println!("{}", serde_json::json!({"libraries":libraries,"pending":db.pending()?,"conflicts":db.meta("conflicts")?,"staged":db.meta("staged")?,"recovery":db.connection.query_row("SELECT count(*) FROM recovery", [], |row|row.get::<_, i64>(0))?})); },
            Commands::Trash { restore, empty, yes } => { let db = typerelay_client::database::Database::open(&root.join("snippets"))?; let rows = db.trash()?; if let Some(id) = restore { let target = rows.iter().find(|row| row["id"] == id).ok_or_else(||anyhow::anyhow!("Trash item not found"))?; db.trash_action(target, "restore")?; println!("Restored trash item {id}."); } else if empty { anyhow::ensure!(yes, "Pass --yes to permanently empty eligible Trash"); db.empty(&rows.into_iter().filter(|row| row["can_purge"] == true).collect::<Vec<_>>())?; println!("Emptied eligible trash items."); } else { println!("{}", serde_json::to_string_pretty(&rows)?); } },
            Commands::Disconnect => { typerelay_client::sync::Sync::new(root.clone(), root.join("snippets"))?.disconnect()?; println!("Disconnected. Local libraries retained."); },
            Commands::Validate { source } => {
                let path = source.path()?;
                let snapshot = if path.is_dir() && path.join("typerelay.sqlite").exists() { typerelay_client::database::Database::open(&path)?.snapshot()? } else { config::FileStore::open(path)?.snapshot };
                println!("Valid: {} snippets", snapshot.len());
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
                anyhow::ensure!(path.is_dir(), "YAML runtime input is retired. Import a library, then run with --dir");
                typerelay_client::sync::Sync::worker(root, path.clone());
                omarchy::Session::run(typerelay_client::database::DatabaseSnapshot::open(&path)?, &device_name)?;
            },
            #[cfg(target_os = "linux")]
            Commands::Install { dry_run } => installation::Installer::run("install", dry_run)?,
			#[cfg(target_os = "linux")]
			Commands::Uninstall { dry_run } => installation::Installer::run("uninstall", dry_run)?,
			#[cfg(target_os = "linux")]
			Commands::Update => installation::Installer::run("update", false)?,
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
