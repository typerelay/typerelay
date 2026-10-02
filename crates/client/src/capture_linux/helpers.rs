use anyhow::{Context,Result,ensure};
use super::context::{ContextCache,HelperContext,Layout};
use std::{io::Read,sync::{Arc,Mutex},time::Duration};
use wayland_client::{Connection,Dispatch,QueueHandle,protocol::{wl_registry,wl_seat,wl_keyboard}};

pub struct ContextService {cache:Arc<Mutex<ContextCache>>}
impl ContextService {
    pub fn start(cache:Arc<Mutex<ContextCache>>)->Result<zbus::blocking::Connection>{Ok(zbus::blocking::connection::Builder::session()?.method_timeout(Duration::from_millis(300)).name("org.typerelay.Capture")?.serve_at("/org/typerelay/Capture",Self{cache})?.build()?)}
}
#[zbus::interface(name="org.typerelay.Capture1")]
impl ContextService {
    async fn context(&self,payload:&str,#[zbus(header)] header:zbus::message::Header<'_>,#[zbus(connection)] connection:&zbus::Connection)->zbus::fdo::Result<()> {
        if payload.len()>16384{return Err(zbus::fdo::Error::LimitsExceeded("Context exceeds limit".into()));}
        let sender=header.sender().ok_or_else(||zbus::fdo::Error::AccessDenied("Missing peer".into()))?;let proxy=zbus::fdo::DBusProxy::new(connection).await?;
        let uid=proxy.get_connection_unix_user(sender.clone().into()).await?;let pid=proxy.get_connection_unix_process_id(sender.clone().into()).await?;
        let path=std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|_|zbus::fdo::Error::AccessDenied("Unknown helper".into()))?;let executable=path.file_name().and_then(|v|v.to_str()).unwrap_or_default();
        if uid!=unsafe{libc::geteuid()}||!["gnome-shell","kwin_wayland","kwin_x11"].contains(&executable){return Err(zbus::fdo::Error::AccessDenied("Untrusted desktop helper".into()));}
        let value:HelperContext=serde_json::from_str(payload).map_err(|_|zbus::fdo::Error::InvalidArgs("Invalid context".into()))?;
        if value.app.len()>512||value.window.len()>256||value.layout.keymap.is_some(){return Err(zbus::fdo::Error::InvalidArgs("Invalid context bounds".into()));}
        let mut cache=self.cache.lock().unwrap();cache.value=Some(value);cache.received=super::CapturePublisher::now();Ok(())
    }
}

#[derive(Default)]
pub struct WaylandMap {keymap:Option<String>}
impl WaylandMap {
    pub fn read()->Result<Layout>{
        let connection=Connection::connect_to_env()?;let mut queue=connection.new_event_queue::<Self>();let handle=queue.handle();let _registry=connection.display().get_registry(&handle,());let mut state=Self::default();
        // Subscribe only to the keymap. A stalled compositor must not hold the worker indefinitely.
        use std::os::fd::AsRawFd;let deadline=std::time::Instant::now()+Duration::from_millis(300);
        while std::time::Instant::now()<deadline{queue.dispatch_pending(&mut state)?;if state.keymap.is_some(){break;}queue.flush()?;if let Some(guard)=queue.prepare_read(){let mut descriptor=libc::pollfd{fd:guard.connection_fd().as_raw_fd(),events:libc::POLLIN,revents:0};let ready=unsafe{libc::poll(&mut descriptor,1,20)};if ready>0{guard.read()?;}else{drop(guard);}}}
        let keymap=state.keymap.context("Compositor did not expose a keyboard keymap")?;ensure!(keymap.len()<=1048576,"Keyboard keymap exceeds limit");Ok(Layout{layout:"wayland".into(),keymap:Some(keymap),..Default::default()})
    }
}
impl Dispatch<wl_registry::WlRegistry,()> for WaylandMap {
    fn event(_: &mut Self,registry:&wl_registry::WlRegistry,event:wl_registry::Event,_:&(),_:&Connection,handle:&QueueHandle<Self>){if let wl_registry::Event::Global{name,interface,version}=event&&interface=="wl_seat"{registry.bind::<wl_seat::WlSeat,_,_>(name,version.min(7),handle,());}}
}
impl Dispatch<wl_seat::WlSeat,()> for WaylandMap {
    fn event(_: &mut Self,seat:&wl_seat::WlSeat,event:wl_seat::Event,_:&(),_:&Connection,handle:&QueueHandle<Self>){if let wl_seat::Event::Capabilities{capabilities:wayland_client::WEnum::Value(capabilities)}=event&&capabilities.contains(wl_seat::Capability::Keyboard){seat.get_keyboard(handle,());}}
}
impl Dispatch<wl_keyboard::WlKeyboard,()> for WaylandMap {
    fn event(state:&mut Self,_:&wl_keyboard::WlKeyboard,event:wl_keyboard::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){if let wl_keyboard::Event::Keymap{format:wayland_client::WEnum::Value(wl_keyboard::KeymapFormat::XkbV1),fd,size}=event&&size<=1048576{let mut text=String::new();if std::fs::File::from(fd).take(size as u64).read_to_string(&mut text).is_ok(){state.keymap=Some(text.trim_end_matches('\0').into());}}}
}
