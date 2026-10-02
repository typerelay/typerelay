//! Device ownership for the single Linux relay. No expansion or input logging here.
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub(super) struct KeyboardEvent { pub device: u64, pub event: InputEvent }
struct Keyboard { name: String, identity: String, caps_control: bool, grabbed: bool, idle_since: Option<Instant>, device: Device }
#[derive(Default)]
pub(super) struct Keyboards { devices: BTreeMap<u64, Keyboard>, held: BTreeMap<u64, BTreeSet<u16>>, next: u64, pub changed: bool, pub unavailable: Vec<serde_json::Value>, pub pending: VecDeque<KeyboardEvent> }
impl Keyboards {
    pub fn reconcile(&mut self, requested: &str, compositor: &serde_json::Value, devices: &[(String,PathBuf,String)]) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let mode = if requested == "auto" { Installer::keyboard_mode()? } else { requested.into() };
        let selected = Installer::input_keyboards(devices, &mode);
        if mode != "auto" && selected.len() != 1 {
            self.unavailable=vec![serde_json::json!({"name":mode,"reason":if selected.is_empty(){"Selected keyboard is disconnected"}else{"Multiple keyboards have this name; use Automatic to listen to all physical keyboards"}})];
            let ids:Vec<_>=self.devices.keys().copied().collect();for id in ids {self.remove(id);}return Ok(());
        }
        let mut present = BTreeSet::new();
        let mut unavailable = vec![];
        for (name, path, properties) in selected {
            let identity = properties.lines().find_map(|line| line.strip_prefix("DEVPATH=")).context("Input device has no kernel identity")?;
            let metadata = match fs::metadata(path) { Ok(value) => value, Err(_) => continue };
            let identity = format!("{identity}:{}:{}", metadata.rdev(), metadata.ino());
            present.insert(identity.clone());
            let existing = self.devices.iter().find(|(_, row)| row.identity == identity).map(|(id, _)| *id);
            let result = (|| -> Result<()> {
                Hyprland::keyboard(compositor, "TypeRelay virtual keyboard")?;
                let caps_control = Session::caps_control(compositor, name)?;
                let layout = Hyprland::keyboard(compositor, name)?;
                anyhow::ensure!(layout["layout"] == "us" && layout["variant"].as_str().unwrap_or_default().is_empty(), "Expansion requires a US keyboard layout without a variant");
                if let Some(id) = existing { let row=self.devices.get_mut(&id).unwrap(); if row.caps_control != caps_control { row.caps_control=caps_control; self.changed=true; } return Ok(()); }
                let device = Device::open(path).context("Keyboard access missing; run Check setup to allow keyboard access")?;
                device.set_nonblocking(true)?;
                anyhow::ensure!([KeyCode::KEY_A, KeyCode::KEY_Z, KeyCode::KEY_SPACE, KeyCode::KEY_ENTER].iter().all(|key| device.supported_keys().is_some_and(|keys| keys.contains(*key))), "Not a text keyboard");
                self.next += 1;
                self.devices.insert(self.next, Keyboard { name: name.clone(), identity, caps_control, grabbed:false, idle_since:None, device });
                Ok(())
            })();
            if let Err(error) = result {
                if let Some(id) = existing { self.remove(id); }
                unavailable.push(serde_json::json!({"name":name,"reason":error.to_string()}));
            }
        }
        let removed: Vec<_> = self.devices.iter().filter(|(_, row)| !present.contains(&row.identity)).map(|(id, _)| *id).collect();
        for id in removed { self.remove(id); }
        self.unavailable = unavailable;
        Ok(())
    }
    fn remove(&mut self, id: u64) {
        self.devices.remove(&id);
        if let Some(keys) = self.held.get(&id) { for code in keys { self.pending.push_back(KeyboardEvent { device:id, event:InputEvent::new(EventType::KEY.0,*code,0) }); } }
        self.changed = true;
    }
    pub fn fetch_events(&mut self, repair: bool) -> Result<Vec<KeyboardEvent>> {
        let mut events: Vec<_> = self.pending.drain(..).collect();
        let mut disconnected = vec![];
        for (id, keyboard) in &mut self.devices {
            if !keyboard.grabbed {
                let attempt = (|| -> Result<()> {
                    let activity = match keyboard.device.fetch_events() { Ok(events) => events.count()>0, Err(error) if error.kind()==std::io::ErrorKind::WouldBlock => false, Err(error)=>return Err(error.into()) };
                    let held = keyboard.device.get_key_state()?.iter().next().is_some();
                    if !Self::idle(&mut keyboard.idle_since, activity || held, Instant::now()) { return Ok(()); }
                    keyboard.device.grab()?;
                    // Anything queued before this ownership boundary already reached the application.
                    let activity = match keyboard.device.fetch_events() { Ok(events)=>events.count()>0, Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>false, Err(error)=>return Err(error.into()) };
                    if activity || keyboard.device.get_key_state()?.iter().next().is_some() { keyboard.device.ungrab()?;keyboard.idle_since=None;return Ok(()); }
                    keyboard.grabbed=true;self.changed=true;
                    Ok(())
                })();
                if let Err(error)=attempt { self.unavailable.push(serde_json::json!({"name":keyboard.name,"reason":error.to_string()}));disconnected.push(*id); }
                continue;
            }
            match keyboard.device.fetch_events() {
                Ok(batch) => events.extend(batch.filter(|event| event.event_type() == EventType::KEY).map(|event| KeyboardEvent { device:*id,event })),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(error) => { self.unavailable.push(serde_json::json!({"name":keyboard.name,"reason":error.to_string()})); disconnected.push(*id); }
            }
        }
        // Each kernel input stream is ordered. Stable sorting preserves order within each stream.
        events.sort_by_key(|event| event.event.timestamp());
        for id in disconnected { self.remove(id); }
        events.extend(self.pending.drain(..));
        if repair && events.is_empty() {
            for (id, keyboard) in &self.devices {
                if !keyboard.grabbed { continue; }
                let actual = match keyboard.device.get_key_state() { Ok(value) => value, Err(_) => continue };
                if let Some(held) = self.held.get(id) { for code in held { if !actual.contains(KeyCode(*code)) { events.push(KeyboardEvent { device:*id,event:InputEvent::new(EventType::KEY.0,*code,0) }); } } }
            }
        }
        Ok(events)
    }
    pub fn transition(&mut self, event: &KeyboardEvent) -> bool {
        let code = event.event.code();
        let before = self.held.values().any(|keys| keys.contains(&code));
        let keys = self.held.entry(event.device).or_default();
        match event.event.value() { 1 => { keys.insert(code); !before }, 0 => { let owned=keys.remove(&code); owned && !self.held.values().any(|keys| keys.contains(&code)) }, 2 => keys.contains(&code), _ => false }
    }
    pub fn keys_down(&mut self) -> Result<BTreeSet<u16>> {
        let mut held = BTreeSet::new();
        let mut disconnected=vec![];
        for (id,keyboard) in &self.devices { if !keyboard.grabbed { continue; } match keyboard.device.get_key_state() { Ok(keys)=>held.extend(keys.iter().map(|key|key.0)), Err(_)=>disconnected.push(*id) } }
        for id in disconnected { self.remove(id); }
        Ok(held)
    }
    pub fn caps_control(&self, id: u64) -> bool { self.devices.get(&id).is_some_and(|keyboard| keyboard.caps_control) }
    pub fn name(&self, id: u64) -> Option<&str> { self.devices.get(&id).map(|keyboard| keyboard.name.as_str()) }
    fn idle(since: &mut Option<Instant>, active: bool, now: Instant) -> bool {
        if active { *since=None;false } else { now.duration_since(*since.get_or_insert(now))>=Duration::from_millis(50) }
    }
    pub fn issues(&self) -> Vec<serde_json::Value> {
        let mut issues=self.unavailable.clone();issues.extend(self.devices.values().filter(|keyboard|!keyboard.grabbed).map(|keyboard|serde_json::json!({"name":keyboard.name,"reason":"Release held keys to activate this keyboard"})));issues
    }
    pub fn active(&self) -> Vec<serde_json::Value> { self.devices.values().filter(|keyboard|keyboard.grabbed).map(|keyboard| serde_json::json!({"name":keyboard.name,"identity":keyboard.identity})).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    impl KeyboardEvent { fn key(device:u64,code:u16,value:i32)->Self { Self {device,event:InputEvent::new(EventType::KEY.0,code,value)} } }
    #[test]
    fn unavailable_device_is_reported_without_failing_reconciliation() {
        let file=tempfile::NamedTempFile::new().unwrap();let devices=vec![("Missing access".into(),file.path().to_owned(),"ID_INPUT_KEYBOARD=1\nDEVPATH=/devices/platform/test/event0".into())];let compositor=serde_json::json!({"keyboards":[{"name":"missing-access","layout":"us"},{"name":"typerelay-virtual-keyboard","layout":"us"}]});let mut group=Keyboards::default();assert!(group.reconcile("Missing access",&compositor,&devices).is_ok());assert!(group.active().is_empty());assert_eq!(group.issues()[0]["name"],"Missing access");assert!(group.issues()[0]["reason"].as_str().unwrap().contains("access"));
    }
    #[test]
    fn activation_requires_a_stable_idle_period_and_restarts_after_typing() {
        let at=Instant::now();let mut idle=None;assert!(!Keyboards::idle(&mut idle,false,at));assert!(!Keyboards::idle(&mut idle,false,at+Duration::from_millis(49)));assert!(Keyboards::idle(&mut idle,false,at+Duration::from_millis(50)));assert!(!Keyboards::idle(&mut idle,true,at+Duration::from_millis(51)));assert!(!Keyboards::idle(&mut idle,false,at+Duration::from_millis(100)));assert!(Keyboards::idle(&mut idle,false,at+Duration::from_millis(150)));
    }
    #[test]
    fn overlapping_controls_release_only_after_last_keyboard() {
        let mut group=Keyboards::default();
        assert!(group.transition(&KeyboardEvent::key(1,29,1)));
        assert!(!group.transition(&KeyboardEvent::key(2,29,1)));
        assert!(!group.transition(&KeyboardEvent::key(1,29,0)));
        assert!(group.transition(&KeyboardEvent::key(2,29,0)));
        assert!(!group.transition(&KeyboardEvent::key(2,29,0)));
    }
    #[test]
    fn removal_repairs_only_removed_owners_and_keeps_other_modifiers() {
        let mut group=Keyboards::default();
        group.transition(&KeyboardEvent::key(1,29,1));group.transition(&KeyboardEvent::key(2,29,1));group.transition(&KeyboardEvent::key(1,42,1));
        group.remove(1);let events=group.fetch_events(false).unwrap();let released:Vec<_>=events.iter().filter(|event|group.transition(event)).map(|event|event.event.code()).collect();
        assert_eq!(released,vec![42]);assert!(group.transition(&KeyboardEvent::key(2,29,0)));assert!(group.changed);
    }
    #[test]
    fn reconnected_device_does_not_inherit_previous_pressed_state() {
        let mut group=Keyboards::default();assert!(group.transition(&KeyboardEvent::key(1,30,1)));group.remove(1);
        for event in group.fetch_events(false).unwrap(){assert!(group.transition(&event));}
        assert!(group.transition(&KeyboardEvent::key(2,30,1)));assert!(!group.transition(&KeyboardEvent::key(1,30,0)));assert!(group.transition(&KeyboardEvent::key(2,30,0)));
    }
    #[test]
    fn repeat_requires_ownership_and_duplicate_press_is_not_replayed() {
        let mut group=Keyboards::default();assert!(!group.transition(&KeyboardEvent::key(1,30,2)));assert!(group.transition(&KeyboardEvent::key(1,30,1)));assert!(!group.transition(&KeyboardEvent::key(1,30,1)));assert!(group.transition(&KeyboardEvent::key(1,30,2)));assert!(!group.transition(&KeyboardEvent::key(2,30,0)));assert!(group.transition(&KeyboardEvent::key(1,30,0)));
    }
}
