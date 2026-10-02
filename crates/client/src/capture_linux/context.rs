use anyhow::{Context,Result,ensure};
use serde::{Deserialize,Serialize};
use std::{io::{Read,Write},os::unix::net::UnixStream,path::PathBuf,sync::{Arc,Mutex},time::Duration};
use crate::observation::{CaptureContext,CaptureSource,Protection};

#[derive(Clone,Debug,Default,Deserialize,Serialize,PartialEq,Eq)]
#[serde(default,deny_unknown_fields)]
pub struct Layout {pub layout:String,pub variant:String,pub options:String,pub group:Option<u32>,pub active_name:Option<String>,pub caps:bool,pub num:bool,pub keymap:Option<String>}
impl Layout {pub fn identity(&self)->String{use sha2::Digest;format!("{:x}",sha2::Sha256::digest(format!("{}:{}:{}:{:?}:{:?}:{}",self.layout,self.variant,self.options,self.group,self.active_name,self.keymap.as_deref().unwrap_or_default()).as_bytes()))}}
#[derive(Clone,Default,Deserialize,Serialize)]
#[serde(default,deny_unknown_fields)]
pub struct HelperContext {pub pid:u32,pub app:String,pub window:String,pub layout:Layout,pub ime:Option<String>}
#[derive(Default)]
pub struct ContextCache {pub value:Option<HelperContext>,pub received:i64}
pub struct ContextProvider {desktop:String,cache:Arc<Mutex<ContextCache>>,identity:String,generation:u64,system:zbus::blocking::Connection,bus:zbus::blocking::Connection,session:String}
impl ContextProvider {
    pub fn desktop()->String {let name=std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(){"hyprland"}else if std::env::var_os("SWAYSOCK").is_some(){"sway"}else if std::env::var("XDG_SESSION_TYPE").as_deref()==Ok("x11"){"x11"}else if name.contains("gnome"){"gnome"}else if name.contains("kde"){"kde"}else{"unsupported"}.into()}
    pub fn new(cache:Arc<Mutex<ContextCache>>)->Result<Self>{let system=zbus::blocking::connection::Builder::system()?.method_timeout(Duration::from_millis(300)).build()?;let session=std::env::var("XDG_SESSION_ID").unwrap_or_default();let bus=zbus::blocking::connection::Builder::session()?.method_timeout(Duration::from_millis(300)).build()?;Ok(Self{desktop:Self::desktop(),cache,identity:String::new(),generation:0,system,bus,session})}
    pub fn unlocked(&self)->Result<bool>{
        let reply=self.system.call_method(Some("org.freedesktop.login1"),"/org/freedesktop/login1",Some("org.freedesktop.login1.Manager"),"GetSessionByPID",&(std::process::id(),)).or_else(|_|self.system.call_method(Some("org.freedesktop.login1"),"/org/freedesktop/login1",Some("org.freedesktop.login1.Manager"),"GetSession",&(self.session.as_str(),)))?;
        let path:zbus::zvariant::OwnedObjectPath=reply.body().deserialize()?;let reply=self.system.call_method(Some("org.freedesktop.login1"),path.as_str(),Some("org.freedesktop.DBus.Properties"),"GetAll",&("org.freedesktop.login1.Session",))?;let values:std::collections::HashMap<String,zbus::zvariant::OwnedValue>=reply.body().deserialize()?;
        Ok(values.get("Active").and_then(|v|bool::try_from(v).ok())==Some(true)&&values.get("LockedHint").and_then(|v|bool::try_from(v).ok())==Some(false))
    }
    pub fn snapshot(&mut self,device:&str)->Result<(CaptureContext,Layout,String)>{
        ensure!(self.unlocked()?,"Learning paused: session locked or inactive");
        let mut value=match self.desktop.as_str(){"hyprland"=>Self::hyprland(device)?,"sway"=>Self::sway(device)?,"x11"=>Self::x11()?,"gnome"|"kde"=>{let cache=self.cache.lock().unwrap();ensure!(super::CapturePublisher::now()-cache.received<1500,"Enable the Typerelay desktop helper in Check setup");cache.value.clone().context("Desktop helper has not reported focus")?},_=>anyhow::bail!("This desktop needs a supported focus/layout helper")};
        if value.ime.is_none(){value.ime=self.input_method()?;}
        if self.desktop=="kde"{value.layout=Self::kde_layout()?;}
        if value.pid>0{value.app=std::fs::read_link(format!("/proc/{}/exe",value.pid))?.file_name().context("Focused app identity unavailable")?.to_string_lossy().into_owned();}
        ensure!(!value.app.is_empty()&&!value.window.is_empty(),"Focus an application before learning text");ensure!(!value.layout.layout.is_empty(),"Active keyboard layout unavailable");
        let identity=format!("{}:{}:{}",value.app,value.window,value.layout.identity());if identity!=self.identity{self.generation+=1;self.identity=identity;}
        let authority=if value.ime.as_ref().is_some_and(|ime|!ime.is_empty()&&!ime.starts_with("xkb:")){CaptureSource::Ime}else{CaptureSource::Keyboard};
        Ok((CaptureContext{generation:self.generation,app:value.app,window:value.window,field:None,protection:Protection::Unknown,active:true,layout:value.layout.identity(),ime:value.ime,authority},value.layout,self.desktop.clone()))
    }
    fn input_method(&self)->Result<Option<String>> {
        let reply=self.bus.call_method(Some("org.freedesktop.DBus"),"/org/freedesktop/DBus",Some("org.freedesktop.DBus"),"ListNames",&())?;let names:Vec<String>=reply.body().deserialize()?;
        if names.iter().any(|name|name=="org.fcitx.Fcitx5") {
            let method=self.bus.call_method(Some("org.fcitx.Fcitx5"),"/controller",Some("org.fcitx.Fcitx.Controller1"),"CurrentInputMethod",&()).ok().and_then(|reply|reply.body().deserialize::<String>().ok());
            return Ok(match method{Some(name)if name.starts_with("keyboard-")=>None,Some(name)=>Some(format!("Fcitx5: {name}")),None=>Some("Fcitx5: commit source unavailable".into())});
        }
        // A running IBus service is never treated as a verified keyboard-only source.
        // Final commits require the upcoming context-scoped adapter.
        Ok(names.iter().any(|name|name=="org.freedesktop.IBus").then(||"IBus: commit source unavailable".into()))
    }
    fn hyprland(device:&str)->Result<HelperContext>{
        ensure!(crate::desktop::Hyprland::query("locked")?["locked"].as_bool()==Some(false),"Learning paused: session locked");let window=crate::desktop::Hyprland::query("activewindow")?;let devices=crate::desktop::Hyprland::query("devices")?;let keyboard=crate::desktop::Hyprland::keyboard(&devices,device)?;
        Ok(HelperContext{pid:window["pid"].as_u64().unwrap_or_default() as u32,app:window["class"].as_str().unwrap_or_default().into(),window:window["address"].as_str().filter(|v|*v!="0x0").unwrap_or_default().into(),layout:Layout{layout:keyboard["layout"].as_str().unwrap_or_default().into(),variant:keyboard["variant"].as_str().unwrap_or_default().into(),options:keyboard["options"].as_str().unwrap_or_default().into(),group:keyboard["active_layout_index"].as_u64().map(|v|v as u32),active_name:keyboard["active_keymap"].as_str().map(str::to_owned),caps:keyboard["capsLock"].as_bool().unwrap_or_default(),num:keyboard["numLock"].as_bool().unwrap_or_default(),keymap:None},ime:None})
    }
    fn sway_request(kind:u32)->Result<serde_json::Value>{let mut socket=UnixStream::connect(std::env::var_os("SWAYSOCK").context("Sway socket unavailable")?)?;socket.set_read_timeout(Some(Duration::from_millis(300)))?;socket.set_write_timeout(Some(Duration::from_millis(300)))?;socket.write_all(b"i3-ipc")?;socket.write_all(&0u32.to_le_bytes())?;socket.write_all(&kind.to_le_bytes())?;let mut header=[0;14];socket.read_exact(&mut header)?;ensure!(&header[..6]==b"i3-ipc","Invalid Sway response");let size=u32::from_le_bytes(header[6..10].try_into()?) as usize;ensure!(size<=1048576,"Sway response too large");let mut bytes=vec![0;size];socket.read_exact(&mut bytes)?;Ok(serde_json::from_slice(&bytes)?)}
    fn focused(node:&serde_json::Value)->Option<&serde_json::Value>{if node["focused"]==true{return Some(node);}for key in ["nodes","floating_nodes"]{if let Some(nodes)=node[key].as_array(){for child in nodes{if let Some(value)=Self::focused(child){return Some(value);}}}}None}
    fn sway(device:&str)->Result<HelperContext>{let tree=Self::sway_request(4)?;let window=Self::focused(&tree).context("No focused Sway window")?;let inputs=Self::sway_request(100)?;let keyboard=inputs.as_array().context("Sway inputs unavailable")?.iter().find(|input|input["type"]=="keyboard"&&input["name"]==device).context("Selected keyboard unavailable in Sway")?;
        // Sway exposes names/group in IPC but RMLVO through its input configuration.
        let map=super::Translator::wayland_layout()?;
        Ok(HelperContext{pid:window["pid"].as_u64().unwrap_or_default() as u32,app:window["app_id"].as_str().unwrap_or_default().into(),window:window["id"].to_string(),layout:Layout{group:keyboard["xkb_active_layout_index"].as_u64().map(|v|v as u32),active_name:keyboard["xkb_active_layout_name"].as_str().map(str::to_owned),..map},ime:None})}
    fn x11()->Result<HelperContext>{use x11rb::{connection::Connection,protocol::{xproto::ConnectionExt,xkb::ConnectionExt as _}};
        let(conn,screen)=x11rb::connect(None)?;let root=conn.setup().roots[screen].root;let atom=|name:&str|->Result<u32>{Ok(conn.intern_atom(false,name.as_bytes())?.reply()?.atom)};let active=conn.get_property(false,root,atom("_NET_ACTIVE_WINDOW")?,x11rb::protocol::xproto::AtomEnum::WINDOW,0,1)?.reply()?.value32().and_then(|mut v|v.next()).context("No active X11 window")?;
        let pid=conn.get_property(false,active,atom("_NET_WM_PID")?,x11rb::protocol::xproto::AtomEnum::CARDINAL,0,1)?.reply()?.value32().and_then(|mut v|v.next()).unwrap_or(0);let class=conn.get_property(false,active,atom("WM_CLASS")?,x11rb::protocol::xproto::AtomEnum::STRING,0,256)?.reply()?.value;let app=String::from_utf8_lossy(&class).split('\0').find(|v|!v.is_empty()).unwrap_or_default().to_owned();
        let rules=conn.get_property(false,root,atom("_XKB_RULES_NAMES")?,x11rb::protocol::xproto::AtomEnum::STRING,0,4096)?.reply()?.value;let names=String::from_utf8_lossy(&rules);let names:Vec<_>=names.split('\0').collect();ensure!(names.len()>=5,"X11 keyboard layout unavailable");conn.xkb_use_extension(1,0)?.reply()?;let state=conn.xkb_get_state(256)?.reply()?;
        Ok(HelperContext{pid,app,window:active.to_string(),layout:Layout{layout:names[2].into(),variant:names[3].into(),options:names[4].into(),group:Some(u8::from(state.group) as u32),caps:u16::from(state.locked_mods)&2!=0,num:u16::from(state.locked_mods)&16!=0,..Default::default()},ime:None})}
    fn kde_layout()->Result<Layout>{
        let connection=zbus::blocking::connection::Builder::session()?.method_timeout(Duration::from_millis(300)).build()?;let reply=connection.call_method(Some("org.kde.keyboard"),"/Layouts",Some("org.kde.KeyboardLayouts"),"getLayout",&())?;let group:u32=reply.body().deserialize()?;
        let text=std::fs::read_to_string(Self::config_root().join("kxkbrc")).unwrap_or_default();let mut section=false;let mut values=std::collections::HashMap::new();for line in text.lines(){if line.starts_with('['){section=line=="[Layout]";}else if section&&let Some((key,value))=line.split_once('='){values.insert(key,value);}}
        if let Some(layout)=values.get("LayoutList").filter(|value|!value.is_empty()){Ok(Layout{layout:(*layout).into(),variant:values.get("VariantList").copied().unwrap_or_default().into(),options:values.get("Options").copied().unwrap_or_default().into(),group:Some(group),..Default::default()})}else{Ok(Layout{group:Some(group),..super::Translator::wayland_layout()?})}
    }
    pub fn config_root()->PathBuf{std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(||PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"))}
}
