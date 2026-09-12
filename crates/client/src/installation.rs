use anyhow::{Result, bail};
use std::process::Command;

pub struct Installer;

impl Installer {
    pub fn run(action: &str, dry_run: bool) -> Result<()> {
        let mut command = Command::new("/usr/bin/python3");
        command.arg("-c").arg(include_str!("../../../scripts/installer.py")).arg(action).arg(std::env::current_exe()?).arg(include_str!("../../../scripts/session-access.py"));
        if dry_run { command.arg("--dry-run"); }
        if !command.status()?.success() { bail!("Installer did not complete; see the message above"); }
        Ok(())
    }
}
