use anyhow::{Context, Result};
use std::{fs, path::PathBuf, sync::{Mutex, OnceLock}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use crate::editor::Paths;

pub struct BrowserLease;
impl BrowserLease {
	fn path() -> Result<PathBuf> { Ok(Paths::config_dir()?.join("browser-lease")) }
	fn now() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }
	pub fn touch() -> Result<()> { let path = Self::path()?; fs::create_dir_all(path.parent().context("Missing configuration directory")?)?; Paths::atomic_write(&path, Self::now().to_string().as_bytes(), false) }
	pub fn active() -> bool {
		static CACHED: OnceLock<Mutex<(Instant, bool)>> = OnceLock::new();
		let cache = CACHED.get_or_init(|| Mutex::new((Instant::now() - Duration::from_secs(1), false)));
		let Ok(mut state) = cache.try_lock() else { return false; };
		if state.0.elapsed() < Duration::from_millis(75) { return state.1; }
		state.1 = Self::path().ok().and_then(|path| fs::read_to_string(path).ok()).and_then(|value| value.parse::<u128>().ok()).is_some_and(|time| time <= Self::now() && Self::now() - time < 700);
		state.0 = Instant::now();
		state.1
	}
}
