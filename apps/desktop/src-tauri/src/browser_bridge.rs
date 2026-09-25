use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{fs, io::{Read, Write}, path::PathBuf};
use typerelay_client::{browser_lease::BrowserLease, editor::Paths};

pub struct BrowserBridge;
impl BrowserBridge {
	const DEVELOPMENT_EXTENSION_ID: &'static str = "kkmbockjkhkdjpgbdnonfbgljpgofbpl";
	pub fn serve() -> Result<()> {
		let mut input = std::io::stdin().lock();
		let mut output = std::io::stdout().lock();
		loop {
			let mut length = [0u8; 4];
			if input.read_exact(&mut length).is_err() { return Ok(()); }
			let size = u32::from_ne_bytes(length) as usize;
			ensure!(size <= 4096, "Browser message too large");
			let mut bytes = vec![0; size];
			input.read_exact(&mut bytes)?;
			let message: Value = serde_json::from_slice(&bytes)?;
			let valid = message["sequence"].as_u64().is_some() && message["active"].as_bool().is_some();
			let active = valid && message["active"] == true;
			if active { BrowserLease::touch()?; }
			let response = serde_json::to_vec(&json!({"sequence": message["sequence"], "ok": valid}))?;
			output.write_all(&(response.len() as u32).to_ne_bytes())?;
			output.write_all(&response)?;
			output.flush()?;
		}
	}
	pub fn register(id: &str) -> Result<()> {
		ensure!(id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)), "Invalid Chrome extension ID");
		let root = Paths::config_dir()?;
		fs::create_dir_all(&root)?;
		let path = std::env::current_exe()?;
		let manifest = json!({"name":"com.typerelay.bridge","description":"TypeRelay browser ownership bridge","path":path,"type":"stdio","allowed_origins":[format!("chrome-extension://{id}/")]});
		let target = root.join("com.typerelay.bridge.json");
		Paths::atomic_write(&target, serde_json::to_string_pretty(&manifest)?.as_bytes(), false)?;
		Paths::atomic_write(&root.join("chrome-extension-id"), id.as_bytes(), false)?;
		#[cfg(target_os = "macos")]
		{
			let directory = PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join("Library/Application Support/Google/Chrome/NativeMessagingHosts");
			fs::create_dir_all(&directory)?;
			Paths::atomic_write(&directory.join("com.typerelay.bridge.json"), serde_json::to_string_pretty(&manifest)?.as_bytes(), false)?;
		}
		#[cfg(target_os = "linux")]
		{
			let directory = PathBuf::from(std::env::var_os("HOME").context("HOME is missing")?).join(".config/google-chrome/NativeMessagingHosts");
			fs::create_dir_all(&directory)?;
			Paths::atomic_write(&directory.join("com.typerelay.bridge.json"), serde_json::to_string_pretty(&manifest)?.as_bytes(), false)?;
		}
		#[cfg(target_os = "windows")]
		{
			let result = std::process::Command::new("reg").args(["add", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.typerelay.bridge", "/ve", "/t", "REG_SZ", "/d", target.to_str().context("Invalid manifest path")?, "/f"]).status()?;
			ensure!(result.success(), "Could not register the Chrome native messaging host");
		}
		Ok(())
	}
	pub fn refresh_registration() { if let Ok(root) = Paths::config_dir() { let id = fs::read_to_string(root.join("chrome-extension-id")).unwrap_or_else(|_| Self::DEVELOPMENT_EXTENSION_ID.into()); let _ = Self::register(id.trim()); } }
}
