use typerelay_client::{database::DatabaseSnapshot, desktop::{Hyprland, Registration}};
use crate::clipboard::{PasteJob, Progress};
use anyhow::{Context, Result, bail};
use evdev::{Device, EventType, InputEvent, KeyCode, InputId, BusType, uinput::VirtualDevice};
use fs2::FileExt;
use std::{collections::{BTreeSet, VecDeque}, fs, io::Read, os::unix::net::UnixStream, path::PathBuf, process::Command, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}, thread, time::{Duration, Instant}};
use typerelay_core::{Engine, Input, Expansion, FeedResult};
use typerelay_client::{settings::SettingsStore, editor::Paths, browser_lease::BrowserLease};
use typerelay_client::installation::Installer;

#[path = "omarchy_input.rs"]
mod input_devices;
use input_devices::{Keyboards, KeyboardEvent};

pub struct Session;

#[derive(Debug)]
pub struct Interference;

impl std::fmt::Display for Interference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "Espanso is active. Stop it before starting TypeRelay; run `systemctl --user restart typerelay` afterward if installed as a service") }
}

impl std::error::Error for Interference {}

struct TemplateWait { done: std::sync::mpsc::Receiver<std::result::Result<(),String>>, target:String, started:bool, generation:u64, deadline:Instant, restore_space:bool }

struct PasteState {
    job: PasteJob,
    expansion: Expansion,
    target: Option<String>,
    reply: Option<std::sync::mpsc::Sender<std::result::Result<u64, String>>>,
    generation: u64,
    started: bool,
    sent: bool,
    cancelled: bool,
    restore_space: bool,
    confirm_enter: bool,
    cursor: Option<typerelay_core::template::Cursor>,
    cursor_remaining: Option<usize>,
}

struct ContextWatch {
    stream: UnixStream,
    pending: String,
    pointers: Vec<(String, Device)>,
    pointer_changed:bool,
}

impl ContextWatch {
    fn invalidates(event:&InputEvent)->bool { event.event_type()==EventType::KEY && event.value()==1 && matches!(event.code(),0x110..=0x117) }

    fn connect() -> Result<Self> {
        let stream = UnixStream::connect(Hyprland::socket(".socket2.sock")?)?;
        stream.set_nonblocking(true)?;
        let mut watcher = Self { stream, pending: String::new(), pointers: Vec::new(), pointer_changed:false };
        watcher.refresh_pointers(&Installer::devices()?)?;
        Ok(watcher)
    }

    fn refresh_pointers(&mut self, inputs: &[(String,PathBuf,String)]) -> Result<()> {
        let mut present = BTreeSet::new();
        for (_,path,props) in inputs {
            if !props.lines().any(|p| matches!(p,"ID_INPUT_MOUSE=1"|"ID_INPUT_TOUCHPAD=1"|"ID_INPUT_TOUCHSCREEN=1")) { continue; }
            let identity = props.lines().find_map(|line|line.strip_prefix("DEVPATH=")).context("Pointer has no kernel identity")?.to_owned();
            present.insert(identity.clone());
            if self.pointers.iter().any(|(id,_)|id==&identity) { continue; }
            let pointer=Device::open(path).with_context(||format!("Pointer access needed for click cancellation: {}",path.display()))?;
            pointer.set_nonblocking(true)?;
            self.pointers.push((identity,pointer));
        }
        self.pointers.retain(|(id,_)|present.contains(id));
        Ok(())
    }

    fn changed(&mut self, expected:Option<&str>) -> Result<bool> {
        let mut changed = false;
        let mut window_changed = false;
        let mut bytes = [0; 4096];
        loop {
            match self.stream.read(&mut bytes) {
                Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "Hyprland event connection closed").into()),
                Ok(n) => self.pending.push_str(&String::from_utf8_lossy(&bytes[..n])),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        while let Some(end) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=end).collect();
            if ["activewindow", "workspace", "focusedmon", "activespecial", "openlayer", "closelayer", "configreloaded"].iter().any(|prefix| line.starts_with(prefix)) { window_changed = true; }
        }
        if self.pending.len() > 65536 { bail!("Oversized Hyprland event"); }
        if window_changed && expected.is_some() && Session::target()?.as_deref() == expected { window_changed = false; }
        let mut index = 0;
        while index < self.pointers.len() {
            let disconnected = match self.pointers[index].1.fetch_events() {
                Ok(events) => {
                    if events.into_iter().any(|event|Self::invalidates(&event)) { changed = true; }
                    false
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => false,
                Err(e) if e.raw_os_error() == Some(libc::ENODEV) => { changed = true; true },
                Err(e) => return Err(e.into()),
            };
            if disconnected {
                self.pointers.swap_remove(index);
                eprintln!("Pointer disconnected; TypeRelay input remains active");
            } else {
                index += 1;
            }
        }
        self.pointer_changed=changed;Ok(changed || window_changed)
    }
}

impl Session {
    fn record_usage(expansion: &Expansion) {
        if let Some(identity) = &expansion.identity {
            if let Ok(root) = Paths::config_dir() { let hit=typerelay_client::panel::Hit{id:identity.id.clone(),library:identity.library.clone(),revision:identity.revision,library_name:String::new(),title:String::new(),abbreviation:String::new(),preview:String::new()};typerelay_client::panel::Panel::record_usage(&root.join("snippets"),&hit,"insert","desktop",expansion.text.chars().count().saturating_sub(expansion.erase)); }
        }
    }

    const MODIFIERS: [KeyCode; 8] = [KeyCode::KEY_LEFTSHIFT, KeyCode::KEY_RIGHTSHIFT, KeyCode::KEY_LEFTCTRL, KeyCode::KEY_RIGHTCTRL, KeyCode::KEY_LEFTALT, KeyCode::KEY_RIGHTALT, KeyCode::KEY_LEFTMETA, KeyCode::KEY_RIGHTMETA];

    fn caps_control(devices: &serde_json::Value, device_name: &str) -> Result<bool> {
        let keyboard = Hyprland::keyboard(devices, device_name)?;
        let native = |keyboard: &serde_json::Value| keyboard["options"].as_str().unwrap_or_default().split(',').any(|option| matches!(option, "ctrl:nocaps" | "caps:ctrl_modifier"));
        let caps_control = native(keyboard);
        if let Ok(output) = Hyprland::keyboard(devices, "TypeRelay virtual keyboard") { anyhow::ensure!(native(output) == caps_control, "Use the same native Caps-to-Ctrl options for the selected keyboard and TypeRelay virtual keyboard"); }
        Ok(caps_control)
    }

    fn effective_key(code: u16, caps_control: bool) -> u16 {
        if caps_control && code == KeyCode::KEY_CAPSLOCK.0 { KeyCode::KEY_LEFTCTRL.0 } else { code }
    }

    fn modifiers_down(pressed: &BTreeSet<u16>, caps_control: bool) -> bool {
        pressed.iter().any(|code| Self::MODIFIERS.iter().any(|modifier| modifier.0 == Self::effective_key(*code, caps_control)))
    }

    fn switch_keyboard(source: &mut Option<u64>, incoming: u64, engine: &mut Engine, target: &mut Option<String>) -> bool {
        if *source == Some(incoming) { return false; }
        *source=Some(incoming);engine.feed(Input::Cancel);*target=None;true
    }

    fn feed_input(engine: &mut Engine, event: &InputEvent, pressed: &BTreeSet<u16>, caps_control: bool, caps: &mut bool, allowed: bool) -> FeedResult {
        let code = KeyCode(event.code());
        if code == KeyCode::KEY_CAPSLOCK && event.value() == 1 && !caps_control { *caps = !*caps; }
        if *caps || Self::modifiers_down(pressed, caps_control) || !allowed || (matches!(Self::input(code),Input::Right|Input::Space|Input::Enter) && event.value() == 2) { engine.feed(Input::Cancel); FeedResult::Forward } else { engine.feed_event(Self::input(code)) }
    }

    fn interference_present(devices: &serde_json::Value) -> bool {
        devices["keyboards"].as_array().is_some_and(|keyboards| keyboards.iter().any(|keyboard| keyboard["name"].as_str() == Some("espanso-virtual-device")))
    }

    fn check_interference(devices: &serde_json::Value) -> Result<()> {
        if Self::interference_present(devices) {
            let _ = Command::new("notify-send").args(["--app-name=TypeRelay", "--urgency=critical", "TypeRelay paused: conflicting expander", "Espanso is running. Stop it, then restart TypeRelay."]).spawn().map(|mut child| { thread::spawn(move || { let _ = child.wait(); }); });
            return Err(Interference.into());
        }
        Ok(())
    }

    fn release_stale_keys(pressed: &mut BTreeSet<u16>, keys_down: &BTreeSet<u16>,mut emit:impl FnMut(&[InputEvent])->Result<()>,mut observe:impl FnMut(u16)) -> Result<()> {
        let stale: Vec<_> = pressed.iter().filter(|key| !keys_down.contains(key)).copied().collect();
        for code in stale { observe(code);emit(&[InputEvent::new(EventType::KEY.0, code, 0)])?; pressed.remove(&code); }
        Ok(())
    }

    fn wait_for_forwarded_keys(keyboard: &mut Keyboards, output: &mut VirtualDevice, buffered: &mut VecDeque<KeyboardEvent>, pressed: &mut BTreeSet<u16>, deadline: Instant,capture:&typerelay_client::capture_linux::CapturePublisher) -> Result<bool> {
        loop {
            let mut pending = VecDeque::new();
            while let Some(input) = buffered.pop_front() {
                let event = input.event;
                if event.event_type() == EventType::KEY && event.value() == 0 && pressed.contains(&event.code()) {
                    if keyboard.transition(&input) { pressed.remove(&event.code()); capture.key(&event); output.emit(&[event])?; }
                } else { pending.push_back(input); }
            }
            *buffered = pending;
            let keys_down = keyboard.keys_down()?;
            Self::release_stale_keys(pressed,&keys_down,|events|output.emit(events).map_err(Into::into),|code|capture.repair_release(code))?;
            if pressed.is_empty() { return Ok(true); }
            if Instant::now() >= deadline { return Ok(false); }
            buffered.extend(keyboard.fetch_events(buffered.is_empty())?);
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn guard_relay(active: Arc<AtomicBool>, progress: Arc<AtomicU64>) {
        thread::spawn(move || {
            let mut previous=progress.load(Ordering::SeqCst);let mut advanced=Instant::now();
            while active.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
                let current=progress.load(Ordering::SeqCst);
                if current!=previous {previous=current;advanced=Instant::now();}
                else if active.load(Ordering::SeqCst) && advanced.elapsed()>=Duration::from_secs(5) {
                    // Closing the process releases every evdev grab even if the relay thread is stuck.
                    let message=b"TypeRelay input forwarding stalled; keyboard released. Restart TypeRelay to resume expansion.\n";
                    unsafe {libc::write(libc::STDERR_FILENO,message.as_ptr().cast(),message.len());libc::_exit(1);}
                }
            }
        });
    }

    fn target() -> Result<Option<String>> {
        if Hyprland::query("locked")?["locked"].as_bool() != Some(false) { return Ok(None); }
        let active = Hyprland::query("activewindow")?;
        if active["pid"].as_u64().is_some_and(|pid|typerelay_client::panel_ipc::PanelIpc::owns_window(pid as u32)) { return Ok(None); }
        Ok(active["address"].as_str().filter(|s| *s != "0x0" && !Registration::inhibited(s)).map(str::to_owned))
    }

    pub fn doctor() -> Result<()> {
        println!("Wayland: {}", std::env::var("WAYLAND_DISPLAY").unwrap_or_default());
        println!("Hyprland reachable: {}", Hyprland::query("locked").is_ok());
        println!("uinput writable: {}", fs::OpenOptions::new().write(true).open("/dev/uinput").is_ok());
        for (name, path, _) in Installer::devices()? {
            println!("Input: {} ({name}), readable: {}", path.display(), Device::open(&path).is_ok());
        }
        println!("Pointer/context access: {}", ContextWatch::connect().is_ok());
        Ok(())
    }

    fn input(code: KeyCode) -> Input {
        match code {
            KeyCode::KEY_SPACE => Input::Space,
            KeyCode::KEY_ENTER | KeyCode::KEY_KPENTER => Input::Enter,
            KeyCode::KEY_BACKSPACE => Input::Backspace,
            KeyCode::KEY_DELETE => Input::Delete,
            KeyCode::KEY_LEFT => Input::Left,
            KeyCode::KEY_RIGHT => Input::Right,
            KeyCode::KEY_COMMA => Input::Character(','),
            KeyCode::KEY_SEMICOLON => Input::Character(';'),
            KeyCode::KEY_DOT => Input::Character('.'),
            KeyCode::KEY_SLASH => Input::Character('/'),
            KeyCode::KEY_APOSTROPHE => Input::Character('\''),
            KeyCode::KEY_LEFTBRACE => Input::Character('['),
            KeyCode::KEY_RIGHTBRACE => Input::Character(']'),
            KeyCode::KEY_BACKSLASH => Input::Character('\\'),
            KeyCode::KEY_GRAVE => Input::Character('`'),
            KeyCode::KEY_EQUAL => Input::Character('='),
            KeyCode::KEY_MINUS => Input::Character('-'),
            _ => {
                let keys = [(KeyCode::KEY_A, 'a'), (KeyCode::KEY_B, 'b'), (KeyCode::KEY_C, 'c'), (KeyCode::KEY_D, 'd'), (KeyCode::KEY_E, 'e'), (KeyCode::KEY_F, 'f'), (KeyCode::KEY_G, 'g'), (KeyCode::KEY_H, 'h'), (KeyCode::KEY_I, 'i'), (KeyCode::KEY_J, 'j'), (KeyCode::KEY_K, 'k'), (KeyCode::KEY_L, 'l'), (KeyCode::KEY_M, 'm'), (KeyCode::KEY_N, 'n'), (KeyCode::KEY_O, 'o'), (KeyCode::KEY_P, 'p'), (KeyCode::KEY_Q, 'q'), (KeyCode::KEY_R, 'r'), (KeyCode::KEY_S, 's'), (KeyCode::KEY_T, 't'), (KeyCode::KEY_U, 'u'), (KeyCode::KEY_V, 'v'), (KeyCode::KEY_W, 'w'), (KeyCode::KEY_X, 'x'), (KeyCode::KEY_Y, 'y'), (KeyCode::KEY_Z, 'z'), (KeyCode::KEY_0, '0'), (KeyCode::KEY_1, '1'), (KeyCode::KEY_2, '2'), (KeyCode::KEY_3, '3'), (KeyCode::KEY_4, '4'), (KeyCode::KEY_5, '5'), (KeyCode::KEY_6, '6'), (KeyCode::KEY_7, '7'), (KeyCode::KEY_8, '8'), (KeyCode::KEY_9, '9')];
                keys.iter().find(|(key, _)| *key == code).map_or(Input::Cancel, |(_, c)| Input::Character(*c))
            }
        }
    }

    fn stroke(key: KeyCode, shift: bool) -> Vec<InputEvent> {
        let mut events = Vec::new();
        if shift { events.push(InputEvent::new(EventType::KEY.0, KeyCode::KEY_LEFTSHIFT.0, 1)); }
        events.push(InputEvent::new(EventType::KEY.0, key.0, 1));
        events.push(InputEvent::new(EventType::KEY.0, key.0, 0));
        if shift { events.push(InputEvent::new(EventType::KEY.0, KeyCode::KEY_LEFTSHIFT.0, 0)); }
        events
    }

    fn replacement_key(character: char) -> Result<(KeyCode, bool)> {
        for raw in 1..256 {
            let key = KeyCode(raw);
            if let Input::Character(c) = Self::input(key)
                && c == character.to_ascii_lowercase() { return Ok((key, character.is_ascii_uppercase())); }
        }
        let unshifted = " =[];'`\\./";
        let shifted = ")!@#$%^&*(+{}_:\"~|<>?";
        let keys = [KeyCode::KEY_SPACE, KeyCode::KEY_EQUAL, KeyCode::KEY_LEFTBRACE, KeyCode::KEY_RIGHTBRACE, KeyCode::KEY_SEMICOLON, KeyCode::KEY_APOSTROPHE, KeyCode::KEY_GRAVE, KeyCode::KEY_BACKSLASH, KeyCode::KEY_DOT, KeyCode::KEY_SLASH];
        if let Some(index) = unshifted.chars().position(|c| c == character) { return Ok((keys[index], false)); }
        let keys = [KeyCode::KEY_0, KeyCode::KEY_1, KeyCode::KEY_2, KeyCode::KEY_3, KeyCode::KEY_4, KeyCode::KEY_5, KeyCode::KEY_6, KeyCode::KEY_7, KeyCode::KEY_8, KeyCode::KEY_9, KeyCode::KEY_EQUAL, KeyCode::KEY_LEFTBRACE, KeyCode::KEY_RIGHTBRACE, KeyCode::KEY_MINUS, KeyCode::KEY_SEMICOLON, KeyCode::KEY_APOSTROPHE, KeyCode::KEY_GRAVE, KeyCode::KEY_BACKSLASH, KeyCode::KEY_COMMA, KeyCode::KEY_DOT, KeyCode::KEY_SLASH];
        if let Some(index) = shifted.chars().position(|c| c == character) { return Ok((keys[index], true)); }
        bail!("Unsupported replacement character")
    }

    fn inject(expansion: &Expansion, terminal_paste: Option<bool>) -> Result<VecDeque<Vec<InputEvent>>> {
        let mut strokes = VecDeque::new();
        for _ in 0..expansion.erase { strokes.push_back(Self::stroke(KeyCode::KEY_BACKSPACE, false)); }
        if let Some(terminal) = terminal_paste {
            let mut shortcut = vec![InputEvent::new(EventType::KEY.0, KeyCode::KEY_LEFTCTRL.0, 1)];
            shortcut.extend(Self::stroke(KeyCode::KEY_V, terminal));
            shortcut.push(InputEvent::new(EventType::KEY.0, KeyCode::KEY_LEFTCTRL.0, 0));
            strokes.push_back(shortcut);
            return Ok(strokes);
        }
        for c in expansion.text.chars() {
            let (key, shift) = Self::replacement_key(c)?;
            strokes.push_back(Self::stroke(key, shift));
        }
        Ok(strokes)
    }

    pub fn run(mut store: DatabaseSnapshot, device_name: &str) -> Result<()> {
        if unsafe { libc::geteuid() } == 0 { bail!("Run the client as your desktop user, not root"); }
        let runtime = std::env::var("XDG_RUNTIME_DIR")?;
        let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(PathBuf::from(runtime).join("typerelay.lock"))?;
        lock.try_lock_exclusive().context("Another TypeRelay client is already running")?;
        let running = Arc::new(AtomicBool::new(true));
        let signal = running.clone();
        ctrlc::set_handler(move || signal.store(false, Ordering::SeqCst))?;
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none(){return typerelay_client::capture_linux::CapturePublisher::observe_only(device_name,running);}
        let panel = typerelay_client::panel_ipc::PanelIpc::engine(running.clone())?;
        let progress=Arc::new(AtomicU64::new(0));let guarded=Arc::new(AtomicBool::new(true));Self::guard_relay(guarded.clone(),progress.clone());
        let mut input_generation = 0u64;
        let result = Self::keep_connected(&running, &progress, || {
            input_generation = input_generation.wrapping_add(1);
            while let Ok(request) = panel.0.try_recv() { let _ = request.reply.send(Err("Keyboard reconnected; insertion cancelled".into())); }
            Self::relay(&mut store, device_name, &running, &progress, &panel, &mut input_generation)
        });
        running.store(false, Ordering::SeqCst);
        guarded.store(false, Ordering::SeqCst);
        result
    }

    fn keep_connected(running: &AtomicBool, progress: &AtomicU64, mut relay: impl FnMut() -> Result<()>) -> Result<()> {
        let mut previous_error=String::new();
        while running.load(Ordering::SeqCst) {
            progress.fetch_add(1, Ordering::SeqCst);
            match relay() {
                Ok(()) => return Ok(()),
                Err(error) if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().is_some_and(|io| io.raw_os_error() == Some(libc::ENODEV) || matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted | std::io::ErrorKind::NotConnected | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::BrokenPipe))) => {
                    let message=format!("Typerelay input unavailable: {error:#}; reconnecting");
                    let _=typerelay_client::panel_ipc::PanelIpc::write_input_health(serde_json::json!({"state":"unavailable","active":[],"unavailable":[],"message":message,"heartbeat_ms":typerelay_client::capture_linux::CapturePublisher::now()}));
                    if message!=previous_error { eprintln!("{message}"); previous_error=message; }
                },
                Err(error) => return Err(error),
            }
            for _ in 0..10 { if !running.load(Ordering::SeqCst) { break; } progress.fetch_add(1, Ordering::SeqCst); thread::sleep(Duration::from_millis(100)); }
        }
        Ok(())
    }

    fn relay(store: &mut DatabaseSnapshot, requested: &str, running: &AtomicBool, progress: &AtomicU64, panel: &(std::sync::mpsc::Receiver<typerelay_client::panel_ipc::Insertion>, std::sync::mpsc::SyncSender<typerelay_client::panel_ipc::Insertion>), input_generation: &mut u64) -> Result<()> {
        let (panel_requests, template_tx) = panel;
        let devices = Hyprland::query("devices")?;
        Self::check_interference(&devices)?;
        let mut keyboard = Keyboards::default();
        let mut context = ContextWatch::connect()?;
        let mut keys = evdev::AttributeSet::<KeyCode>::new();
        for code in 1..=767 { let key=KeyCode(code); if format!("{key:?}").starts_with("KEY_") { keys.insert(key); } }
        let mut output = VirtualDevice::builder()?.name("TypeRelay virtual keyboard").input_id(InputId::new(BusType::BUS_VIRTUAL, 0x0fac, 0x5452, 1)).with_keys(&keys)?.build()?;
        let inputs = Installer::devices()?;
        let mode = if requested == "auto" { Installer::keyboard_mode()? } else { requested.into() };
        let capture_name = Installer::input_keyboards(&inputs,&mode).first().map(|row|row.0.clone()).unwrap_or_default();
        let capture = typerelay_client::capture_linux::CapturePublisher::start(capture_name)?;
        let mut caps_control = false;
        let mut source = None;
        let mut settings = SettingsStore::open(Paths::config_dir()?.join("settings.yml"))?;
        let mut engine = Engine::new(store.snapshot.clone());
        engine.set_prefix(&settings.settings.trigger_prefix).map_err(anyhow::Error::msg)?;
        let mut pressed = BTreeSet::new();
        let mut suppressed = BTreeSet::<(u64,u16)>::new();
        let mut template_wait: Option<TemplateWait> = None;
        let mut confirmation:Option<(String,u64)>=None;
        let mut panel_shortcut = typerelay_client::panel::Panel::settings(settings.config_dir()).ok().and_then(|value|typerelay_client::panel::Panel::shortcut(&value.shortcut).ok());
        let mut target = None;
        let mut last_reload = Instant::now();
        let mut last_input = Instant::now();
        let mut caps = false;
        let mut buffered = VecDeque::new();
        let mut cursor_backlog=false;
        let mut insertion = VecDeque::<Vec<InputEvent>>::new();
        let mut usage: Option<Expansion> = None;
        let mut last_stroke = Instant::now();
        let mut paste: Option<PasteState> = None;
        let mut last_conflict_check = Instant::now()-Duration::from_secs(2);
        let mut last_health = String::new();
        eprintln!("TypeRelay running: {} snippets; automatic keyboard input; configured prefix + abbreviation + Space or Enter. Ctrl+C stops. No keystrokes are logged.", store.snapshot.len());
        while running.load(Ordering::SeqCst) {
            progress.fetch_add(1,Ordering::SeqCst);
            if last_conflict_check.elapsed() >= Duration::from_secs(2) {
                let devices = Hyprland::query("devices")?;
                Self::check_interference(&devices)?;
                let inputs=Installer::devices()?;
                keyboard.reconcile(requested, &devices, &inputs)?;
                context.refresh_pointers(&inputs)?;
                if let Ok(layout)=Hyprland::keyboard(&devices,"TypeRelay virtual keyboard") { caps=layout["capsLock"].as_bool().unwrap_or(false); }
                let active = keyboard.active();
                let unavailable = keyboard.issues();
                let status = if active.is_empty() { "unavailable" } else if unavailable.is_empty() { "ready" } else { "degraded" };
                let message = if status == "ready" { String::new() } else { format!("Typerelay input {status}: {}", if unavailable.is_empty() { "No physical keyboard is available".into() } else { unavailable.iter().map(|row| format!("{}: {}", row["name"].as_str().unwrap_or_default(), row["reason"].as_str().unwrap_or_default())).collect::<Vec<_>>().join("; ") }) };
                typerelay_client::panel_ipc::PanelIpc::write_input_health(serde_json::json!({"state":status,"active":active,"unavailable":unavailable,"message":message,"heartbeat_ms":typerelay_client::capture_linux::CapturePublisher::now(),"reconciled_ms":typerelay_client::capture_linux::CapturePublisher::now()}))?;
                if message != last_health { if !message.is_empty() { eprintln!("{message}"); } else { eprintln!("Typerelay input ready: {} keyboards", active.len()); } last_health = message; }
                last_conflict_check = Instant::now();
            }
            let context_changed=context.changed(target.as_deref())?;if context.pointer_changed{capture.pointer();}
            if context_changed {*input_generation=input_generation.wrapping_add(1);}
            if context_changed || last_input.elapsed() > Duration::from_secs(10) {
                engine.feed(Input::Cancel); target = None; insertion.clear(); usage = None;confirmation=None;
                if let Some(state) = &mut paste { state.cancelled = true; state.job.cancel(); }
            }
            if last_reload.elapsed() > Duration::from_millis(500) {
                match store.reload() {
                    Ok(Some(snapshot)) => { engine.replace_snapshot(snapshot); eprintln!("Snippet snapshot reloaded"); }
                    Ok(None) => (),
                    Err(error) => eprintln!("Snippet reload rejected: {error:#}; keeping last valid snapshot"),
                }
                match settings.reload() {
                    Ok(true) => { engine.set_prefix(&settings.settings.trigger_prefix).map_err(anyhow::Error::msg)?; target = None; eprintln!("Trigger prefix updated"); }
                    Ok(false) => (),
                    Err(error) => eprintln!("Settings reload rejected: {error:#}; keeping previous prefix"),
                }
                panel_shortcut = typerelay_client::panel::Panel::settings(settings.config_dir()).ok().and_then(|value|typerelay_client::panel::Panel::shortcut(&value.shortcut).ok());
                last_reload = Instant::now();
            }
            if buffered.is_empty(){cursor_backlog=false;}
            buffered.extend(keyboard.fetch_events(buffered.is_empty())?);
            if buffered.len()>4096&&paste.as_ref().is_some_and(|state|state.cursor_remaining.is_some()){if let Some(mut state)=paste.take()&&let Some(reply)=state.reply.take(){let _=reply.send(Err("Text inserted; cursor positioning interrupted by buffered typing. Nothing retried".into()));}template_wait=None;engine.feed(Input::Cancel);target=None;cursor_backlog=true;}else if !cursor_backlog&&buffered.len() > 8192 { bail!("Input backlog exceeded safety limit; stopping"); }
            let keys_down = keyboard.keys_down()?;
            if keyboard.changed {
                keyboard.changed = false; *input_generation = input_generation.wrapping_add(1);
                capture.reset(); engine.feed(Input::Cancel); target = None; source = None; insertion.clear(); usage = None;confirmation=None;
                if let Some(state) = &mut paste { state.cancelled = true; state.job.cancel(); }
                template_wait = None;
            }
            if paste.is_none() && insertion.is_empty() && pressed.is_empty() && (buffered.is_empty() || template_wait.is_some()) && !Self::modifiers_down(&keys_down, caps_control) && let Ok(request) = panel_requests.try_recv() {
                    if template_wait.as_ref().is_none_or(|wait|request.generation==Some(wait.generation)) && Instant::now() < request.deadline && request.generation.is_none_or(|expected| expected == *input_generation) && Self::target()? == Some(request.target.clone()) {
                        capture.reset();engine.feed(Input::Cancel); last_input=Instant::now();
                        if let Some(wait)=&mut template_wait {wait.deadline=Instant::now()+Duration::from_secs(5);}
                        match request.step {
							typerelay_client::clipboard_payload::ClipboardStep::Payload(payload) if !payload.plain.is_empty()||payload.html.is_some()=>{let text=payload.plain.clone();let cursor=payload.cursor.clone();paste=Some(PasteState{job:PasteJob::start_payload(payload),expansion:Expansion{identity:None,template:None,erase:request.erase,text},target:Some(request.target),reply:Some(request.reply),generation:*input_generation,started:false,sent:false,cancelled:false,restore_space:false,confirm_enter:false,cursor,cursor_remaining:None});}
                            step => {
                                if let Some(wait)=&mut template_wait {wait.started=true;}
                                for _ in 0..request.erase { output.emit(&Self::stroke(KeyCode::KEY_BACKSPACE,false))?; }
								if matches!(step,typerelay_client::clipboard_payload::ClipboardStep::Enter) { if Self::target()? != Some(request.target) { let _=request.reply.send(Err("Original window lost focus; remaining actions cancelled".into())); continue; } output.emit(&Self::stroke(KeyCode::KEY_ENTER,false))?; }
                                let _=request.reply.send(Ok(*input_generation));
                            }
                        }
                    } else { let _ = request.reply.send(Err("Target changed or insertion expired; remaining actions cancelled".into())); }
            }

            if let Some(state) = &mut paste {
                if let Some(remaining)=state.cursor_remaining {
                    if state.cancelled||state.generation!=*input_generation||Self::target()?!=state.target {insertion.clear();if let Some(reply)=state.reply.take(){let _=reply.send(Err("Text inserted; cursor positioning interrupted. Nothing retried".into()));}paste=None;continue;}
                    if remaining==0{if let Some(wait)=&mut template_wait{wait.deadline=Instant::now()+Duration::from_secs(5);}if let Some(reply)=state.reply.take(){let _=reply.send(Ok(state.generation));}paste=None;continue;}
                    if last_stroke.elapsed()>=Duration::from_millis(2){for event in Self::stroke(KeyCode::KEY_LEFT,false){output.emit(&[event])?;}state.cursor_remaining=Some(remaining-1);last_stroke=Instant::now();last_input=Instant::now();}
                    thread::sleep(Duration::from_millis(1));continue;
                } else {
                match state.job.progress.try_recv() {
                    Ok(Ok(Progress::Ready)) if !state.cancelled && Self::target()? == state.target && !context.changed(state.target.as_deref())? => {
                        let active = Hyprland::query("activewindow")?;
                        let terminal = Hyprland::is_terminal(&active);
                        insertion = Self::inject(&state.expansion, Some(terminal))?;
                        if let Some(wait)=&mut template_wait {wait.started=true;}
                        state.started = true;
                    }
                    Ok(Ok(Progress::Ready)) => { state.cancelled = true; state.job.cancel(); }
                    Ok(Ok(Progress::Finished)) => { if let Some(cursor)=state.cursor.take()&&state.sent&&!state.cancelled {state.cursor_remaining=Some(cursor.backward_graphemes);continue;} if state.confirm_enter&&state.sent&&!state.cancelled&&state.generation==*input_generation&&Self::target()?==state.target&&!context.changed(state.target.as_deref())? {output.emit(&Self::stroke(KeyCode::KEY_ENTER,false))?;} if state.sent && !state.cancelled && state.reply.is_none() { Self::record_usage(&state.expansion); } if let Some(reply) = state.reply.take() { let _ = reply.send(if state.sent && !state.cancelled { Ok(state.generation) } else { Err("Insertion cancelled; nothing retried".into()) }); } paste = None; continue; }
                    Ok(Err(_)) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        eprintln!("Clipboard paste failed; no automatic retry");
                        if state.restore_space && state.reply.is_none() && !state.started && !state.cancelled && Self::target()? == state.target { for event in Self::stroke(KeyCode::KEY_SPACE, false) { output.emit(&[event])?; } }
                        paste = None;
                        continue;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => (),
                }
                if state.job.timed_out() {
                    eprintln!("Clipboard paste timed out; releasing buffered typing");
                    state.job.cancel();
                    insertion.clear();
                    paste = None;
                    continue;
                }
                if insertion.is_empty() {
                    if state.started && !state.sent { state.job.pasted(); state.sent = true; }
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
                }
            }
            if !insertion.is_empty() {
                if last_stroke.elapsed() >= Duration::from_millis(2) {
                    if let Some(stroke) = insertion.pop_front() {
                        for event in stroke { output.emit(&[event])?; }
                    }
                    if insertion.is_empty() && let Some(expansion)=usage.take() { Self::record_usage(&expansion); }
                    last_stroke = Instant::now();
                }
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            if let Some((destination,generation))=confirmation.take() {if generation==*input_generation&&Self::target()?==Some(destination.clone())&&!context.changed(Some(&destination))? {output.emit(&Self::stroke(KeyCode::KEY_ENTER,false))?;}}
            if let Some(wait)=&template_wait {
                match wait.done.try_recv() {
                    Ok(result)=>{if result.is_err()&&wait.restore_space&&!wait.started&&Self::target()?==Some(wait.target.clone()){output.emit(&Self::stroke(KeyCode::KEY_SPACE,false))?;}template_wait=None;},
                    Err(std::sync::mpsc::TryRecvError::Empty) if Instant::now()<wait.deadline=>{thread::sleep(Duration::from_millis(1));continue;},
                    Err(std::sync::mpsc::TryRecvError::Empty)=>{if wait.restore_space&&!wait.started&&Self::target()?==Some(wait.target.clone()){output.emit(&Self::stroke(KeyCode::KEY_SPACE,false))?;}*input_generation=input_generation.wrapping_add(1);template_wait=None;insertion.clear();paste=None;eprintln!("Template insertion timed out; releasing buffered typing");},
                    Err(std::sync::mpsc::TryRecvError::Disconnected)=>{template_wait=None;}
                }
            }
            while let Some(input) = buffered.pop_front() {
                let event = input.event;
                let code = KeyCode(event.code());
                let logical = keyboard.transition(&input);
                if suppressed.contains(&(input.device,code.0)) { if event.value() == 0 { suppressed.remove(&(input.device,code.0)); if logical { pressed.remove(&code.0); capture.key(&event); } } continue; }
                if !logical { continue; }
                if event.value() != 0 && Self::switch_keyboard(&mut source,input.device,&mut engine,&mut target) {
                    if let Some(name) = keyboard.name(input.device) {
                        caps_control = keyboard.caps_control(input.device);
                        capture.device(name);
                    }
                    capture.reset();
                }
                capture.key(&event);
                if event.value() == 0 { pressed.remove(&code.0); }
                if event.value() == 1 { pressed.insert(code.0); *input_generation = input_generation.wrapping_add(1); }
                let effective_pressed: BTreeSet<_> = pressed.iter().map(|key| Self::effective_key(*key, caps_control)).collect();
                if event.value() == 1 && panel_shortcut.as_ref().is_some_and(|(key, groups)| *key == code.0 && groups.iter().all(|group|group.iter().any(|key|effective_pressed.contains(key))) && effective_pressed.iter().all(|key|*key == code.0 || groups.iter().any(|group|group.contains(key)))) && typerelay_client::panel_ipc::PanelIpc::notify() {
                    capture.reset();suppressed.insert((input.device,code.0)); engine.feed(Input::Cancel); target = None; continue;
                }
                if event.value() != 0 {
                    last_input = Instant::now();
					if BrowserLease::active() { engine.feed(Input::Cancel); target = None; output.emit(&[event])?; continue; }
                    if context.changed(target.as_deref())? { engine.feed(Input::Cancel); target = None; }
                    if matches!(Self::input(code), Input::Character(c) if c == engine.prefix()) { target = Self::target()?; if std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Candidate target available: {}", target.is_some()); } }
                    let result = Self::feed_input(&mut engine, &event, &pressed, caps_control, &mut caps, target.is_some());
                    if matches!(result, FeedResult::Suppress) { suppressed.insert((input.device,code.0)); pressed.remove(&code.0); continue; }
                    let matched_enter=matches!(Self::input(code),Input::Enter)&&matches!(result,FeedResult::Expand(_));
                    let expansion = if let FeedResult::Expand(expansion) = result { Some(expansion) } else { None };
                    if expansion.is_some() && std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Match found; held-key count {}", pressed.len()); }
                    if let Some(expansion) = expansion
                        && Self::target()? == target && !context.changed(target.as_deref())? {
                            capture.reset();let destination = target.clone().unwrap();
                            pressed.remove(&code.0);
                            if !Self::wait_for_forwarded_keys(&mut keyboard, &mut output, &mut buffered, &mut pressed, Instant::now() + Duration::from_secs(3),&capture)? || Self::target()? != Some(destination.clone()) || context.changed(Some(&destination))? {
                                if code==KeyCode::KEY_SPACE {output.emit(&[event])?;pressed.insert(code.0);} else {suppressed.insert((input.device,code.0));}
                                target = None;
                                continue;
                            }
                            suppressed.insert((input.device,code.0));
                            if let Some(template) = &expansion.template {
                                if let Some(identity) = &template.identity {
                                    let hit = typerelay_client::panel::Hit { id: identity.id.clone(), library: identity.library.clone(), revision: identity.revision, library_name: String::new(), title: template.abbreviation.clone(), abbreviation: template.abbreviation.clone(), preview: String::new() };
                                    let accepted = if template.prompted { typerelay_client::panel_ipc::PanelIpc::prompt(typerelay_client::panel_ipc::Prompt { hit, target: destination, erase: expansion.erase, generation:*input_generation, created_ms:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis(),confirm_enter:matched_enter }) } else {
                                        let tx=template_tx.clone(); let erase=expansion.erase; let generation=*input_generation; let started=Instant::now();
											let (done,completion)=std::sync::mpsc::channel();template_wait=Some(TemplateWait{done:completion,target:destination.clone(),started:false,generation,deadline:Instant::now()+Duration::from_secs(5),restore_space:code==KeyCode::KEY_SPACE});
											std::thread::spawn(move || { let result=(||->Result<()>{ let steps=typerelay_client::panel::Panel::steps_at(&Paths::config_dir()?.join("snippets"),&hit,Default::default(),false,typerelay_client::templates::Templates::clock())?; anyhow::ensure!(started.elapsed()<Duration::from_secs(2),"Template preparation expired");typerelay_client::panel_ipc::PanelIpc::execute(&tx,&hit,&destination,typerelay_client::clipboard_payload::ClipboardStep::with_confirmation(steps,matched_enter),erase,Some(generation)) })().map_err(|error|error.to_string()); if let Err(error)=&result { eprintln!("Template insertion cancelled: {error}"); }let _=done.send(result); }); true
                                    };
                                    if accepted { target=None; break; }
                                }
                                eprintln!("Prompted expansion requires the TypeRelay panel; abbreviation left unchanged");
                                std::thread::spawn(||{let _=std::process::Command::new("notify-send").args(["TypeRelay","Prompted expansion requires the TypeRelay panel. Your abbreviation was left unchanged."]).output();});
                                if code==KeyCode::KEY_SPACE {output.emit(&Self::stroke(KeyCode::KEY_SPACE,false))?;} target=None; continue;
                            }
                            if expansion.requires_paste() {
                                paste = Some(PasteState { job: PasteJob::start(expansion.text.clone()), expansion, target: target.clone(), reply: None, generation:*input_generation, started: false, sent: false, cancelled: false, restore_space:code==KeyCode::KEY_SPACE,confirm_enter:matched_enter,cursor:None,cursor_remaining:None });
                            } else {
                                insertion = Self::inject(&expansion, None)?; usage=Some(expansion);if matched_enter {confirmation=Some((destination,*input_generation));}
                            }
                            target = None;
                            break;
                    }
                    if matched_enter {suppressed.insert((input.device,code.0));pressed.remove(&code.0);target=None;continue;}
                }
                output.emit(&[event])?;
            }
            thread::sleep(Duration::from_millis(1));
        }
        drop(paste);
        for code in pressed { output.emit(&[InputEvent::new(EventType::KEY.0, code, 0)])?; }
        drop(keyboard);
        eprintln!("TypeRelay stopped");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_delimiters_match_and_repeated_or_modified_delimiters_cancel() {
        for key in [KeyCode::KEY_SPACE,KeyCode::KEY_ENTER,KeyCode::KEY_KPENTER] {
            for (value,pressed,allowed,expands) in [(1,BTreeSet::new(),true,true),(2,BTreeSet::new(),true,false),(1,BTreeSet::from([KeyCode::KEY_LEFTSHIFT.0]),true,false),(1,BTreeSet::new(),false,false)] {
                let mut engine=Engine::new(typerelay_core::Snapshot::new(vec![typerelay_core::Snippet{trigger:"brb".into(),replacement:"Hello".into()}]).unwrap());
                for c in ";brb".chars(){engine.feed(Input::Character(c));}
                let result=Session::feed_input(&mut engine,&InputEvent::new(EventType::KEY.0,key.0,value),&pressed,false,&mut false,allowed);
                assert_eq!(matches!(result,FeedResult::Expand(_)),expands);
                assert!(matches!(engine.feed_event(Input::Enter),FeedResult::Forward));
            }
        }
    }
    #[test]
    fn keyboard_switch_cancels_partial_trigger_and_both_keyboards_can_expand() {
        let mut engine=Engine::new(typerelay_core::Snapshot::new(vec![typerelay_core::Snippet{trigger:"brb".into(),replacement:"Be right back.".into()}]).unwrap());let mut source=None;let mut target=Some("window".into());
        assert!(Session::switch_keyboard(&mut source,1,&mut engine,&mut target));engine.feed(Input::Character(';'));engine.feed(Input::Character('b'));
        assert!(Session::switch_keyboard(&mut source,2,&mut engine,&mut target));engine.feed(Input::Character('r'));engine.feed(Input::Character('b'));assert!(!matches!(engine.feed_event(Input::Space),FeedResult::Expand(_)));
        for id in [1,2,1] {Session::switch_keyboard(&mut source,id,&mut engine,&mut target);for c in ";brb".chars(){engine.feed(Input::Character(c));}assert!(matches!(engine.feed_event(Input::Space),FeedResult::Expand(_)));}
    }
    #[test]
    fn repaired_physical_releases_reach_both_forwarding_and_observation(){let mut pressed=BTreeSet::from([KeyCode::KEY_LEFTCTRL.0]);let mut output=vec![];let mut observed=vec![];Session::release_stale_keys(&mut pressed,&BTreeSet::new(),|events|{output.extend_from_slice(events);Ok(())},|code|observed.push(code)).unwrap();assert!(pressed.is_empty());assert_eq!(output,vec![InputEvent::new(EventType::KEY.0,KeyCode::KEY_LEFTCTRL.0,0)]);assert_eq!(observed,vec![KeyCode::KEY_LEFTCTRL.0]);Session::release_stale_keys(&mut pressed,&BTreeSet::new(),|_|panic!("duplicate release"),|_|panic!("duplicate observation repair")).unwrap();}
    #[test]
    fn input_reconnect_releases_resources_and_reselects_saved_keyboard() {
        let directory = tempfile::tempdir().unwrap();let path = directory.path().join("keyboard.lock");fs::write(&path, b"").unwrap();
        let settings = typerelay_client::panel::PanelSettings { keyboard_fallback: "USB keyboard".into(), ..Default::default() };
        typerelay_client::panel::Panel::save_settings(directory.path(), &settings).unwrap();
        let laptop = ("Laptop keyboard".into(), "/dev/input/event1".into(), "ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into());
        let usb = ("USB keyboard".into(), "/dev/input/event2".into(), "ID_INPUT_KEYBOARD=1\nID_INTEGRATION=internal\n".into());
        let mut devices = vec![laptop];let mut selected = Vec::new();let mut attempts = 0;
        Session::keep_connected(&AtomicBool::new(true), &AtomicU64::new(0), || {
            // The previous attempt must have released its exclusive input resource.
            let lock = fs::OpenOptions::new().read(true).write(true).open(&path)?;lock.try_lock_exclusive()?;
            let saved = typerelay_client::panel::Panel::settings(directory.path())?;
            selected.push(Installer::configured_keyboard(&devices, &saved)?);
            attempts += 1;
            match attempts {
                1 => { devices.push(usb.clone()); Err(std::io::Error::new(std::io::ErrorKind::NotConnected, "Dock keyboard returned").into()) },
                2 => Err(std::io::Error::from_raw_os_error(libc::ENODEV).into()),
                3 => Err(std::io::Error::from_raw_os_error(libc::EAGAIN).into()),
                _ => Ok(()),
            }
        }).unwrap();
        assert_eq!(selected, ["Laptop keyboard", "USB keyboard", "USB keyboard", "USB keyboard"]);
    }
    #[test]
    fn reconnect_stops_on_shutdown_and_preserves_configuration_errors() {
        let running = AtomicBool::new(true);let progress = AtomicU64::new(0);let mut attempts = 0;
        Session::keep_connected(&running, &progress, || { attempts += 1;running.store(false, Ordering::SeqCst);Err(std::io::Error::from_raw_os_error(libc::ENODEV).into()) }).unwrap();
        assert_eq!(attempts, 1);
        for error in [anyhow::Error::from(std::io::Error::from_raw_os_error(libc::EACCES)), anyhow::Error::from(Interference), anyhow::anyhow!("Incompatible keyboard layout")] {
            let mut error = Some(error);let mut attempts = 0;
            assert!(Session::keep_connected(&AtomicBool::new(true), &progress, || { attempts += 1;Err(error.take().expect("Permanent errors must not retry")) }).is_err());
            assert_eq!(attempts, 1);
        }
    }
    #[test]
    fn relay_guard_child() {
        let Some(path)=std::env::var_os("TYPERELAY_RELAY_GUARD_TEST") else{return;};
        let lock=fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();lock.lock_exclusive().unwrap();
        Session::guard_relay(Arc::new(AtomicBool::new(true)),Arc::new(AtomicU64::new(0)));
        fs::write(PathBuf::from(path).with_extension("ready"),b"ready").unwrap();
        loop{thread::park();}
    }
    #[test]
    fn stalled_relay_exits_and_releases_exclusive_resources() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("relay.lock");fs::write(&path,b"").unwrap();
        let mut child=Command::new(std::env::current_exe().unwrap()).args(["--exact","omarchy::tests::relay_guard_child","--nocapture"]).env("TYPERELAY_RELAY_GUARD_TEST",&path).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        let deadline=Instant::now()+Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() && !path.with_extension("ready").exists() && Instant::now()<deadline{thread::sleep(Duration::from_millis(20));}
        let lock=fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();assert!(path.with_extension("ready").exists());assert!(lock.try_lock_exclusive().is_err());
        while child.try_wait().unwrap().is_none() && Instant::now()<deadline{thread::sleep(Duration::from_millis(20));}
        if child.try_wait().unwrap().is_none(){child.kill().unwrap();panic!("Stalled relay did not release its resources");}
        let output=child.wait_with_output().unwrap();assert_eq!(output.status.code(),Some(1));assert!(String::from_utf8_lossy(&output.stderr).contains("keyboard released"));assert!(lock.try_lock_exclusive().is_ok());
    }
    #[test]
    fn pointer_motion_and_scroll_keep_candidates_but_clicks_cancel() {
        assert!(!ContextWatch::invalidates(&InputEvent::new(EventType::RELATIVE.0,0,1)));
        assert!(!ContextWatch::invalidates(&InputEvent::new(EventType::KEY.0,0x110,0)));
        assert!(ContextWatch::invalidates(&InputEvent::new(EventType::KEY.0,0x110,1)));
        assert!(!ContextWatch::invalidates(&InputEvent::new(EventType::KEY.0,0x14a,1)));
    }
    #[test]
    fn detects_competing_expander_without_flagging_required_input_tools() {
        let normal = serde_json::json!({"keyboards": [{"name": "keyd-virtual-keyboard"}, {"name": "hl-virtual-keyboard-fcitx5"}, {"name": "typerelay-virtual-keyboard"}]});
        assert!(!Session::interference_present(&normal));
        let conflict = serde_json::json!({"keyboards": [{"name": "espanso-virtual-device"}]});
        assert!(Session::interference_present(&conflict));
    }
    #[test]
    fn native_caps_control_shortcuts_do_not_latch_caps_or_expand_while_held() {
        let devices = serde_json::json!({"keyboards": [{"name": "at-translated-set-2-keyboard", "options": "ctrl:nocaps,shift:both_capslock_cancel"}, {"name": "other-keyboard", "options": ""}]});
        let caps_control = Session::caps_control(&devices, "AT Translated Set 2 keyboard").unwrap();
        assert!(caps_control);
        assert!(!Session::caps_control(&devices, "Other keyboard").unwrap());
        let incompatible = serde_json::json!({"keyboards": [{"name": "at-translated-set-2-keyboard", "options": "ctrl:nocaps"}, {"name": "typerelay-virtual-keyboard", "options": ""}]});
        assert!(Session::caps_control(&incompatible, "AT Translated Set 2 keyboard").is_err());
        let mut engine = Engine::new(typerelay_core::Snapshot::new(vec![typerelay_core::Snippet { trigger: "brb".into(), replacement: "Be right back.".into() }]).unwrap());
        let mut caps = false;
        let held = BTreeSet::from([KeyCode::KEY_CAPSLOCK.0]);
        assert!(Session::modifiers_down(&held, caps_control));
        Session::feed_input(&mut engine, &InputEvent::new(EventType::KEY.0, KeyCode::KEY_CAPSLOCK.0, 1), &held, caps_control, &mut caps, true);
        let keys = [KeyCode::KEY_SEMICOLON, KeyCode::KEY_B, KeyCode::KEY_R, KeyCode::KEY_B, KeyCode::KEY_SPACE];
        for key in keys { assert!(!matches!(Session::feed_input(&mut engine, &InputEvent::new(EventType::KEY.0, key.0, 1), &held, caps_control, &mut caps, true), FeedResult::Expand(_))); }
        assert!(!caps, "Native Ctrl must not toggle TypeRelay's Caps Lock state");
        let released = BTreeSet::new();
        assert!(!Session::modifiers_down(&released, caps_control));
        let mut expansion = None;
        for key in keys { if let FeedResult::Expand(value) = Session::feed_input(&mut engine, &InputEvent::new(EventType::KEY.0, key.0, 1), &released, caps_control, &mut caps, true) { expansion = Some(value); } }
        assert_eq!(expansion.unwrap().text, "Be right back.");
        Session::feed_input(&mut engine, &InputEvent::new(EventType::KEY.0, KeyCode::KEY_CAPSLOCK.0, 1), &held, false, &mut caps, true);
        assert!(caps, "An unremapped Caps Lock retains its existing behavior");
    }
    #[test]
    fn every_printable_ascii_character_has_a_stroke() {
        for byte in 32u8..=126 { assert!(Session::replacement_key(byte as char).is_ok(), "Missing ASCII {byte}"); }
        assert!(Session::replacement_key('é').is_err());
    }
    #[test]
    fn shifted_punctuation_and_case() {
        assert_eq!(Session::replacement_key('A').unwrap(), (KeyCode::KEY_A, true));
        assert_eq!(Session::replacement_key('?').unwrap(), (KeyCode::KEY_SLASH, true));
        assert_eq!(Session::replacement_key('@').unwrap(), (KeyCode::KEY_2, true));
        assert_eq!(Session::replacement_key(' ').unwrap(), (KeyCode::KEY_SPACE, false));
    }
    #[test]
    fn multiline_paste_does_not_emit_enter_keys() {
        let expansion = Expansion { identity: None, template: None, erase: 4, text: "Sincerely,\nNitai\nCeo & Founder\n".into() };
        for terminal in [false, true] {
            let strokes = Session::inject(&expansion, Some(terminal)).unwrap();
            assert_eq!(strokes.len(), 5);
            assert!(strokes.iter().flatten().all(|event| event.code() != KeyCode::KEY_ENTER.0));
            assert!(strokes.back().unwrap().iter().any(|event| event.code() == KeyCode::KEY_LEFTCTRL.0 && event.value() == 1));
            assert_eq!(strokes.back().unwrap().iter().any(|event| event.code() == KeyCode::KEY_LEFTSHIFT.0 && event.value() == 1), terminal);
        }
    }
}
