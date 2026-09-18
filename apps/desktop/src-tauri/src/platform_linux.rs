use anyhow::{Context, Result, ensure};
use typerelay_client::desktop::Hyprland;
#[derive(Clone, Debug)]
pub struct Target { pub address: String, pid: u64, start: String, pub bounds: Option<(i32,i32,u32,u32)> }
impl Target {
    pub fn capture() -> Result<Self> {
        ensure!(Hyprland::query("locked")?["locked"] == false, "Session is locked");
        let window = Hyprland::query("activewindow")?;
        let pid = window["pid"].as_u64().context("No active application")?;
        ensure!(pid != std::process::id() as u64, "Choose another application first");
        let address = window["address"].as_str().filter(|v|*v != "0x0").context("No active window")?.to_owned();
        let start = Self::start(pid)?;
        let monitors = Hyprland::query("monitors")?;
        let bounds = monitors.as_array().and_then(|rows|rows.iter().find(|m|m["id"] == window["monitor"])).map(|m| (m["x"].as_i64().unwrap_or(0) as i32,m["y"].as_i64().unwrap_or(0) as i32,(m["width"].as_f64().unwrap_or(1280.)/m["scale"].as_f64().unwrap_or(1.)) as u32,(m["height"].as_f64().unwrap_or(800.)/m["scale"].as_f64().unwrap_or(1.)) as u32));
        Ok(Self { address,pid,start,bounds })
    }
    fn start(pid: u64) -> Result<String> { Ok(std::fs::read_to_string(format!("/proc/{pid}/stat"))?.rsplit_once(") ").context("Invalid process")?.1.split_whitespace().nth(19).context("Missing process identity")?.into()) }
    pub fn restore(&self) -> Result<()> {
        ensure!(Self::start(self.pid)? == self.start, "Original application closed");
        let clients = Hyprland::query("clients")?;
        ensure!(clients.as_array().is_some_and(|rows|rows.iter().any(|w|w["address"] == self.address && w["pid"] == self.pid)), "Original window closed");
        let script=format!("hl.dispatch(hl.dsp.focus({{window = {}}}))",serde_json::to_string(&format!("address:{}",self.address))?);
        let response=std::process::Command::new("hyprctl").args(["eval",&script]).output()?;
        ensure!(response.status.success(),"Hyprland refused focus restoration");
        for _ in 0..40 { if self.focused()? { return Ok(()); } std::thread::sleep(std::time::Duration::from_millis(15)); }
        anyhow::bail!("Could not restore original window; use Copy")
    }
    pub fn focused(&self) -> Result<bool> { let window = Hyprland::query("activewindow")?; Ok(window["address"] == self.address && window["pid"] == self.pid && Self::start(self.pid).ok().as_ref() == Some(&self.start)) }
}
pub fn fallback_allowed()->bool { Hyprland::query("activewindow").is_ok_and(|window|window["pid"] == std::process::id()) }
pub fn open_url(url:&str)->Result<()> { std::process::Command::new("xdg-open").arg(url).spawn().context("Could not open the TypeRelay web app")?;Ok(()) }
pub fn open_tui()->Result<()> { let executable=std::env::current_exe()?.with_file_name("typerelay-tui");ensure!(executable.is_file(),"TypeRelay TUI is missing from this installation");std::process::Command::new("foot").args(["--app-id=com.typerelay.tui","--title=TypeRelay TUI"]).arg(executable).spawn().context("Could not open TypeRelay TUI")?;Ok(()) }
