use anyhow::{Context, Result, ensure};
use typerelay_client::desktop::Hyprland;
#[derive(Debug)]
enum MissingTarget { Application, Window, Panel }
impl std::fmt::Display for MissingTarget {
	fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {f.write_str(match self {Self::Application=>"No active application",Self::Window=>"No active window",Self::Panel=>"Choose another application first"})}
}
impl std::error::Error for MissingTarget {}
#[derive(Clone, Debug)]
pub struct Target { pub address: String, pid: u64, start: String, pub bounds: Option<(i32,i32,u32,u32)> }
impl Target {
    pub fn capture() -> Result<Self> {
        ensure!(Hyprland::query("locked")?["locked"] == false, "Session is locked");
        let window = Hyprland::query("activewindow")?;
        let (pid,address) = Self::identity(&window)?;
        let start = Self::start(pid)?;
        let monitors = Hyprland::query("monitors")?;
        let bounds = monitors.as_array().and_then(|rows|rows.iter().find(|m|m["id"] == window["monitor"])).map(|m| (m["x"].as_i64().unwrap_or(0) as i32,m["y"].as_i64().unwrap_or(0) as i32,(m["width"].as_f64().unwrap_or(1280.)/m["scale"].as_f64().unwrap_or(1.)) as u32,(m["height"].as_f64().unwrap_or(800.)/m["scale"].as_f64().unwrap_or(1.)) as u32));
        Ok(Self { address,pid,start,bounds })
    }
	fn identity(window:&serde_json::Value)->Result<(u64,String)> {
		let pid=window["pid"].as_u64().filter(|pid|*pid>0).ok_or(MissingTarget::Application)?;
		if pid==std::process::id() as u64 {return Err(MissingTarget::Panel.into());}
		let address=window["address"].as_str().filter(|value|!value.is_empty()&&*value!="0x0").ok_or(MissingTarget::Window)?.to_owned();
		Ok((pid,address))
	}
	pub fn for_panel(captured:Result<Self>,last:Option<Self>)->Result<Option<Self>> {
		match captured {
			Ok(target)=>Ok(Some(target)),
			Err(error)=>match error.downcast_ref::<MissingTarget>() {
				Some(MissingTarget::Panel)=>Ok(last),
				Some(MissingTarget::Application|MissingTarget::Window)=>Ok(None),
				None=>Err(error),
			},
		}
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
pub fn open_url(url:&str)->Result<()> { std::process::Command::new("xdg-open").arg(url).spawn().context("Could not open link")?;Ok(()) }
pub fn open_tui()->Result<()> { let executable=std::env::current_exe()?.with_file_name("typerelay-tui");ensure!(executable.is_file(),"TypeRelay TUI is missing from this installation");std::process::Command::new("foot").args(["--app-id=com.typerelay.tui","--title=TypeRelay TUI"]).arg(executable).spawn().context("Could not open TypeRelay TUI")?;Ok(()) }

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;
	fn target()->Target {Target{address:"0x123".into(),pid:1,start:"identity".into(),bounds:None}}
	#[test]
	fn missing_foreground_never_uses_previous_application() {
		for window in [json!({}),json!({"pid":0}),json!({"pid":1}),json!({"pid":1,"address":"0x0"}),json!({"pid":1,"address":""})] {
			let captured=Target::identity(&window).map(|_|target());
			let state=crate::Runtime::default();
			state.update_capture(Target::for_panel(captured,Some(target())));
			assert!(state.target.lock().unwrap().is_none());
			assert!(state.status_message().is_empty());
			assert_eq!(state.insertion_target().unwrap_err(),"Focus an application, reopen search, then insert—or use Copy.");
		}
	}
	#[test]
	fn panel_focus_preserves_existing_fallback() {
		let captured=Target::identity(&json!({"pid":std::process::id(),"address":"0x456"})).map(|_|target());
		assert_eq!(Target::for_panel(captured,Some(target())).unwrap().unwrap().address,"0x123");
		assert!(Target::for_panel(Err(MissingTarget::Panel.into()),None).unwrap().is_none());
	}
	#[test]
	fn capture_failure_and_recovery_preserve_persistent_status() {
		let state=crate::Runtime::default();
		*state.status.lock().unwrap()="Tray unavailable".into();
		*state.target.lock().unwrap()=Some(target());
		state.update_capture(Target::for_panel(Err(anyhow::anyhow!("Socket unavailable").context("Capture failed")),Some(target())));
		assert_eq!(state.status_message(),"Tray unavailable\nCapture failed");
		assert!(state.insertion_target().is_err());
		state.update_capture(Target::for_panel(Ok(target()),None));
		assert_eq!(state.status_message(),"Tray unavailable");
		assert_eq!(state.insertion_target().unwrap().address,"0x123");
		state.update_capture(Err(anyhow::anyhow!("Session is locked")));
		state.update_capture(Ok(None));
		assert_eq!(state.status_message(),"Tray unavailable");
		assert!(state.insertion_target().is_err());
	}
	#[test]
	fn valid_identity_retains_process_and_window() {
		assert_eq!(Target::identity(&json!({"pid":1,"address":"0x123"})).unwrap(),(1,"0x123".into()));
	}
}

#[path="observation_linux.rs"]
mod observation;
pub use observation::ObservationAdapter;
