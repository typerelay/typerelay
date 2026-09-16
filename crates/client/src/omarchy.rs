use typerelay_client::{database::DatabaseSnapshot, desktop::{Hyprland, Registration}};
use crate::clipboard::{PasteJob, Progress};
use anyhow::{Context, Result, bail};
use evdev::{Device, EventType, InputEvent, KeyCode, InputId, BusType, uinput::VirtualDevice};
use fs2::FileExt;
use std::{collections::{BTreeSet, VecDeque}, fs, io::Read, os::unix::net::UnixStream, path::PathBuf, process::Command, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use typerelay_core::{Engine, Input, Expansion};
use typerelay_client::{settings::SettingsStore, editor::Paths};

pub struct Session;

#[derive(Debug)]
pub struct Interference;

impl std::fmt::Display for Interference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "Espanso is active. Stop it before starting TypeRelay; run `systemctl --user restart typerelay` afterward if installed as a service") }
}

impl std::error::Error for Interference {}

struct TemplateWait { done: std::sync::mpsc::Receiver<std::result::Result<(),String>>, target:String, started:bool, generation:u64 }

struct PasteState {
    job: PasteJob,
    expansion: Expansion,
    target: Option<String>,
    reply: Option<std::sync::mpsc::Sender<std::result::Result<u64, String>>>,
    generation: u64,
    started: bool,
    sent: bool,
    cancelled: bool,
}

struct ContextWatch {
    stream: UnixStream,
    pending: String,
    pointers: Vec<Device>,
}

impl ContextWatch {
    fn invalidates(event:&InputEvent)->bool { event.event_type()==EventType::KEY && event.value()==1 && matches!(event.code(),0x110..=0x117) }

    fn connect() -> Result<Self> {
        let stream = UnixStream::connect(Hyprland::socket(".socket2.sock")?)?;
        stream.set_nonblocking(true)?;
        let mut pointers = Vec::new();
        for (path, _) in Session::devices()? {
            let props = Command::new("udevadm").args(["info", "--query=property", "--name"]).arg(&path).output()?;
            let props = String::from_utf8_lossy(&props.stdout);
            if props.lines().any(|p| p == "ID_INPUT_MOUSE=1" || p == "ID_INPUT_TOUCHPAD=1" || p == "ID_INPUT_TOUCHSCREEN=1") {
                let device = Device::open(&path).with_context(|| format!("Pointer access needed for click cancellation: {}", path.display()))?;
                device.set_nonblocking(true)?;
                pointers.push(device);
            }
        }
        if pointers.is_empty() { bail!("No pointer device available for click cancellation"); }
        Ok(Self { stream, pending: String::new(), pointers })
    }

    fn changed(&mut self, expected:Option<&str>) -> Result<bool> {
        let mut changed = false;
        let mut window_changed = false;
        let mut bytes = [0; 4096];
        loop {
            match self.stream.read(&mut bytes) {
                Ok(0) => bail!("Hyprland event connection closed"),
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
            let disconnected = match self.pointers[index].fetch_events() {
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
        Ok(changed || window_changed)
    }
}

impl Session {
    const MODIFIERS: [KeyCode; 8] = [KeyCode::KEY_LEFTSHIFT, KeyCode::KEY_RIGHTSHIFT, KeyCode::KEY_LEFTCTRL, KeyCode::KEY_RIGHTCTRL, KeyCode::KEY_LEFTALT, KeyCode::KEY_RIGHTALT, KeyCode::KEY_LEFTMETA, KeyCode::KEY_RIGHTMETA];

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

    fn wait_for_release(mut active: impl FnMut() -> Result<bool>, deadline: Instant) -> Result<()> {
        let mut idle_since = None;
        loop {
            let now = Instant::now();
            if now >= deadline { bail!("Keyboard stayed active for 5 seconds; release held keys and try again"); }
            if active()? {
                idle_since = None;
            } else if now.duration_since(*idle_since.get_or_insert(now)) >= Duration::from_millis(50) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn release_stale_keys(output: &mut VirtualDevice, pressed: &mut BTreeSet<u16>, keys_down: &BTreeSet<u16>) -> Result<()> {
        let stale: Vec<_> = pressed.iter().filter(|key| !keys_down.contains(key)).copied().collect();
        for code in stale { output.emit(&[InputEvent::new(EventType::KEY.0, code, 0)])?; pressed.remove(&code); }
        Ok(())
    }

    fn wait_for_forwarded_keys(keyboard: &mut Device, output: &mut VirtualDevice, buffered: &mut VecDeque<InputEvent>, pressed: &mut BTreeSet<u16>, deadline: Instant) -> Result<bool> {
        loop {
            let mut pending = VecDeque::new();
            while let Some(event) = buffered.pop_front() {
                if event.event_type() == EventType::KEY && pressed.contains(&event.code()) {
                    if event.value() == 0 { pressed.remove(&event.code()); }
                    output.emit(&[event])?;
                } else if event.event_type() == EventType::KEY { pending.push_back(event); }
            }
            *buffered = pending;
            let keys_down: BTreeSet<_> = keyboard.get_key_state()?.iter().map(|key|key.0).collect();
            Self::release_stale_keys(output, pressed, &keys_down)?;
            if pressed.is_empty() { return Ok(true); }
            if Instant::now() >= deadline { return Ok(false); }
            match keyboard.fetch_events() {
                Ok(events) => buffered.extend(events),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(error.into()),
            }
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn devices() -> Result<Vec<(PathBuf, String)>> {
        let mut devices = Vec::new();
        for entry in fs::read_dir("/sys/class/input")? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("event") {
                devices.push((PathBuf::from("/dev/input").join(name), fs::read_to_string(entry.path().join("device/name"))?.trim().into()));
            }
        }
        Ok(devices)
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
        for (path, name) in Self::devices()? {
            if name == "keyd virtual keyboard" {
                println!("Keyboard: {} ({name}), readable: {}", path.display(), Device::open(&path).is_ok());
            }
        }
        println!("Pointer/context access: {}", ContextWatch::connect().is_ok());
        Ok(())
    }

    fn input(code: KeyCode) -> Input {
        match code {
            KeyCode::KEY_SPACE => Input::Space,
            KeyCode::KEY_BACKSPACE => Input::Backspace,
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
        let devices = Hyprland::query("devices")?;
        let keyboards = devices["keyboards"].as_array().context("No Hyprland keyboard information")?;
        if keyboards.iter().any(|k| k["layout"].as_str() != Some("us") || k["capsLock"].as_bool() == Some(true)) { bail!("POC requires US-only layouts and Caps Lock off"); }
        Self::check_interference(&devices)?;
        let selected: Vec<_> = Self::devices()?.into_iter().filter(|(_, n)| n == device_name).collect();
        if selected.len() != 1 { bail!("Expected exactly one keyboard named {device_name}"); }
        let mut keyboard = Device::open(&selected[0].0).context("Keyboard unavailable; use the session access setup")?;
        keyboard.set_nonblocking(true)?;
        let mut context = ContextWatch::connect()?;
        // keyd reserves vendor 0x0fac for virtual devices and ignores them, preventing feedback.
        let mut output = VirtualDevice::builder()?.name("TypeRelay virtual keyboard").input_id(InputId::new(BusType::BUS_VIRTUAL, 0x0fac, 0x5452, 1)).with_keys(keyboard.supported_keys().context("Not a keyboard")?)?.build()?;
        thread::sleep(Duration::from_millis(300));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            Self::wait_for_release(|| {
                // Startup keystrokes already reached the application; never replay them.
                let mut activity = false;
                loop {
                    match keyboard.fetch_events() {
                        Ok(events) => {
                            let count = events.count();
                            if count == 0 { break; }
                            activity = true;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(error) => return Err(error.into()),
                    }
                }
                Ok(activity || keyboard.get_key_state()?.iter().next().is_some())
            }, deadline)?;
            keyboard.grab()?;
            if keyboard.get_key_state()?.iter().next().is_none() { break; }
            // A key arrived between the idle check and grab. Let it finish normally.
            keyboard.ungrab()?;
        }
        let running = Arc::new(AtomicBool::new(true));
        let signal = running.clone();
        ctrlc::set_handler(move || signal.store(false, Ordering::SeqCst))?;
        let mut settings = SettingsStore::open(Paths::config_dir()?.join("settings.yml"))?;
        let mut engine = Engine::new(store.snapshot.clone());
        engine.set_prefix(&settings.settings.trigger_prefix).map_err(anyhow::Error::msg)?;
        let mut pressed = BTreeSet::new();
        let mut suppressed_space = false;
        let mut suppressed_panel_key = None;
        let (panel_requests, template_tx) = typerelay_client::panel_ipc::PanelIpc::engine(running.clone())?;
        let mut input_generation = 0u64;
        let mut template_wait: Option<TemplateWait> = None;
        let mut panel_shortcut = typerelay_client::panel::Panel::settings(settings.config_dir()).ok().and_then(|value|typerelay_client::panel::Panel::shortcut(&value.shortcut).ok());
        let mut target = None;
        let mut last_reload = Instant::now();
        let mut last_input = Instant::now();
        let mut caps = false;
        let mut buffered = VecDeque::new();
        let mut insertion = VecDeque::<Vec<InputEvent>>::new();
        let mut last_stroke = Instant::now();
        let mut paste: Option<PasteState> = None;
        let mut last_conflict_check = Instant::now();
        eprintln!("TypeRelay running: {} snippets; configured prefix + abbreviation + Space. Ctrl+C stops. No keystrokes are logged.", store.snapshot.len());
        while running.load(Ordering::SeqCst) {
            if last_conflict_check.elapsed() >= Duration::from_secs(2) {
                Self::check_interference(&Hyprland::query("devices")?)?;
                last_conflict_check = Instant::now();
            }
            let context_changed=context.changed(target.as_deref())?;
            if context_changed {input_generation=input_generation.wrapping_add(1);}
            if context_changed || last_input.elapsed() > Duration::from_secs(10) {
                engine.feed(Input::Cancel); target = None; insertion.clear();
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
            let events: Vec<InputEvent> = match keyboard.fetch_events() {
                Ok(events) => events.collect(),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Vec::new(),
                Err(e) => return Err(e.into()),
            };
            buffered.extend(events);
            if buffered.len() > 8192 { bail!("Input backlog exceeded safety limit; stopping"); }
            let keys_down: BTreeSet<_> = keyboard.get_key_state()?.iter().map(|key|key.0).collect();
            if buffered.is_empty() {
                Self::release_stale_keys(&mut output, &mut pressed, &keys_down)?;
                if suppressed_space && !keys_down.contains(&KeyCode::KEY_SPACE.0) { suppressed_space = false; }
                if suppressed_panel_key.is_some_and(|key|!keys_down.contains(&key)) { suppressed_panel_key = None; }
            }
            if paste.is_none() && insertion.is_empty() && pressed.is_empty() && (buffered.is_empty() || template_wait.is_some()) && keys_down.iter().all(|key| !Self::MODIFIERS.iter().any(|modifier|modifier.0 == *key)) && let Ok(request) = panel_requests.try_recv() {
                    if template_wait.as_ref().is_none_or(|wait|request.generation==Some(wait.generation)) && Instant::now() < request.deadline && request.generation.is_none_or(|expected| expected == input_generation) && Self::target()? == Some(request.target.clone()) {
                        engine.feed(Input::Cancel); last_input=Instant::now();
                        match request.step {
							typerelay_client::clipboard_payload::ClipboardStep::Payload(payload) if !payload.plain.is_empty()||payload.html.is_some()=>{let text=payload.plain.clone();paste=Some(PasteState{job:PasteJob::start_payload(payload),expansion:Expansion{template:None,erase:request.erase,text},target:Some(request.target),reply:Some(request.reply),generation:input_generation,started:false,sent:false,cancelled:false});}
                            step => {
                                if let Some(wait)=&mut template_wait {wait.started=true;}
                                for _ in 0..request.erase { output.emit(&Self::stroke(KeyCode::KEY_BACKSPACE,false))?; }
								if matches!(step,typerelay_client::clipboard_payload::ClipboardStep::Enter) { if Self::target()? != Some(request.target) { let _=request.reply.send(Err("Original window lost focus; remaining actions cancelled".into())); continue; } output.emit(&Self::stroke(KeyCode::KEY_ENTER,false))?; }
                                let _=request.reply.send(Ok(input_generation));
                            }
                        }
                    } else { let _ = request.reply.send(Err("Target changed or insertion expired; remaining actions cancelled".into())); }
            }

            if let Some(state) = &mut paste {
                match state.job.progress.try_recv() {
                    Ok(Ok(Progress::Ready)) if !state.cancelled && Self::target()? == state.target && !context.changed(state.target.as_deref())? => {
                        let active = Hyprland::query("activewindow")?;
                        let terminal = Hyprland::is_terminal(&active);
                        insertion = Self::inject(&state.expansion, Some(terminal))?;
                        if let Some(wait)=&mut template_wait {wait.started=true;}
                        state.started = true;
                    }
                    Ok(Ok(Progress::Ready)) => { state.cancelled = true; state.job.cancel(); }
                    Ok(Ok(Progress::Finished)) => { if let Some(reply) = state.reply.take() { let _ = reply.send(if state.sent && !state.cancelled { Ok(state.generation) } else { Err("Insertion cancelled; nothing retried".into()) }); } paste = None; continue; }
                    Ok(Err(_)) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        eprintln!("Clipboard paste failed; no automatic retry");
                        if state.reply.is_none() && !state.started && !state.cancelled && Self::target()? == state.target { for event in Self::stroke(KeyCode::KEY_SPACE, false) { output.emit(&[event])?; } }
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
            if !insertion.is_empty() {
                if last_stroke.elapsed() >= Duration::from_millis(2) {
                    if let Some(stroke) = insertion.pop_front() {
                        for event in stroke { output.emit(&[event])?; }
                    }
                    last_stroke = Instant::now();
                }
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            if let Some(wait)=&template_wait {
                match wait.done.try_recv() {
                    Ok(result)=>{if result.is_err()&&!wait.started&&Self::target()?==Some(wait.target.clone()){output.emit(&Self::stroke(KeyCode::KEY_SPACE,false))?;}template_wait=None;},
                    Err(std::sync::mpsc::TryRecvError::Empty)=>{thread::sleep(Duration::from_millis(1));continue;},
                    Err(std::sync::mpsc::TryRecvError::Disconnected)=>{template_wait=None;}
                }
            }
            while let Some(event) = buffered.pop_front() {
                if event.event_type() != EventType::KEY { continue; }
                let code = KeyCode(event.code());
                if suppressed_panel_key == Some(code.0) {
                    if event.value() == 0 { suppressed_panel_key = None; pressed.remove(&code.0); }
                    continue;
                }
                if suppressed_space && code == KeyCode::KEY_SPACE {
                    if event.value() == 0 { suppressed_space = false; pressed.remove(&code.0); }
                    continue;
                }
                if event.value() == 0 { pressed.remove(&code.0); }
                if event.value() == 1 { pressed.insert(code.0); input_generation = input_generation.wrapping_add(1); }
                if event.value() == 1 && panel_shortcut.as_ref().is_some_and(|(key, groups)| *key == code.0 && groups.iter().all(|group|group.iter().any(|key|pressed.contains(key))) && pressed.iter().all(|key|*key == code.0 || groups.iter().any(|group|group.contains(key)))) && typerelay_client::panel_ipc::PanelIpc::notify() {
                    suppressed_panel_key = Some(code.0); engine.feed(Input::Cancel); target = None; continue;
                }
                if event.value() != 0 {
                    last_input = Instant::now();
                    if code == KeyCode::KEY_CAPSLOCK && event.value() == 1 { caps = !caps; }
                    if caps || Self::MODIFIERS.iter().any(|key| pressed.contains(&key.0)) {
                        engine.feed(Input::Cancel);
                    } else {
                        if context.changed(target.as_deref())? { engine.feed(Input::Cancel); target = None; }
                        if matches!(Self::input(code), Input::Character(c) if c == engine.prefix()) { target = Self::target()?; if std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Candidate target available: {}", target.is_some()); } }
                        let expansion = if target.is_some() { engine.feed(Self::input(code)) } else { engine.feed(Input::Cancel); None };
                        if expansion.is_some() && std::env::var_os("TYPERELAY_DIAGNOSTIC").is_some() { eprintln!("Match found; held-key count {}", pressed.len()); }
                        if let Some(expansion) = expansion
                            && Self::target()? == target && !context.changed(target.as_deref())? {
                                let destination = target.clone().unwrap();
                                pressed.remove(&code.0);
                                if !Self::wait_for_forwarded_keys(&mut keyboard, &mut output, &mut buffered, &mut pressed, Instant::now() + Duration::from_secs(3))? || Self::target()? != Some(destination.clone()) || context.changed(Some(&destination))? {
                                    output.emit(&[event])?;
                                    pressed.insert(code.0);
                                    target = None;
                                    continue;
                                }
                                suppressed_space = true;
                                if let Some(template) = &expansion.template {
                                    if let Some(identity) = &template.identity {
                                        let hit = typerelay_client::panel::Hit { id: identity.id.clone(), library: identity.library.clone(), revision: identity.revision, library_name: String::new(), title: template.abbreviation.clone(), abbreviation: template.abbreviation.clone(), preview: String::new() };
                                        let accepted = if template.prompted { typerelay_client::panel_ipc::PanelIpc::prompt(typerelay_client::panel_ipc::Prompt { hit, target: destination, erase: expansion.erase, generation:input_generation, created_ms:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() }) } else {
                                            let tx=template_tx.clone(); let erase=expansion.erase; let generation=input_generation; let started=Instant::now();
											let (done,completion)=std::sync::mpsc::channel();template_wait=Some(TemplateWait{done:completion,target:destination.clone(),started:false,generation});
											std::thread::spawn(move || { let result=(||->Result<()>{ let steps=typerelay_client::panel::Panel::steps_at(&Paths::config_dir()?.join("snippets"),&hit,Default::default(),false,typerelay_client::templates::Templates::clock())?; anyhow::ensure!(started.elapsed()<Duration::from_secs(2),"Template preparation expired");typerelay_client::panel_ipc::PanelIpc::execute(&tx,&hit,&destination,steps,erase,Some(generation)) })().map_err(|error|error.to_string()); if let Err(error)=&result { eprintln!("Template insertion cancelled: {error}"); }let _=done.send(result); }); true
                                        };
                                        if accepted { target=None; break; }
                                    }
                                    eprintln!("Prompted expansion requires the TypeRelay panel; abbreviation left unchanged");
                                    std::thread::spawn(||{let _=std::process::Command::new("notify-send").args(["TypeRelay","Prompted expansion requires the TypeRelay panel. Your abbreviation was left unchanged."]).output();});
                                    output.emit(&Self::stroke(KeyCode::KEY_SPACE,false))?; target=None; continue;
                                }
                                if expansion.requires_paste() {
                                    paste = Some(PasteState { job: PasteJob::start(expansion.text.clone()), expansion, target: target.clone(), reply: None, generation:input_generation, started: false, sent: false, cancelled: false });
                                } else {
                                    insertion = Self::inject(&expansion, None)?;
                                }
                                target = None;
                                break;
                        }
                    }
                }
                output.emit(&[event])?;
            }
            thread::sleep(Duration::from_millis(1));
        }
        drop(paste);
        for code in pressed { output.emit(&[InputEvent::new(EventType::KEY.0, code, 0)])?; }
        keyboard.ungrab()?;
        eprintln!("TypeRelay stopped");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn startup_waits_for_launch_key_release_and_a_stable_idle_period() {
        let mut checks = 0;
        Session::wait_for_release(|| {
            checks += 1;
            Ok(matches!(checks, 1 | 2 | 5))
        }, Instant::now() + Duration::from_secs(1)).unwrap();
        assert!(checks >= 11, "A second key must restart the idle interval");
    }
    #[test]
    fn startup_times_out_instead_of_grabbing_a_held_keyboard() {
        assert!(Session::wait_for_release(|| Ok(true), Instant::now() + Duration::from_millis(20)).is_err());
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
        let expansion = Expansion { template: None, erase: 4, text: "Sincerely,\nNitai\nCeo & Founder\n".into() };
        for terminal in [false, true] {
            let strokes = Session::inject(&expansion, Some(terminal)).unwrap();
            assert_eq!(strokes.len(), 5);
            assert!(strokes.iter().flatten().all(|event| event.code() != KeyCode::KEY_ENTER.0));
            assert!(strokes.back().unwrap().iter().any(|event| event.code() == KeyCode::KEY_LEFTCTRL.0 && event.value() == 1));
            assert_eq!(strokes.back().unwrap().iter().any(|event| event.code() == KeyCode::KEY_LEFTSHIFT.0 && event.value() == 1), terminal);
        }
    }
}
