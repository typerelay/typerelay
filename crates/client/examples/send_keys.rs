//! Explicit desktop-test driver: emits keys through keyd, not directly into the engine.
#[cfg(target_os = "linux")]
struct Sender;

#[cfg(target_os = "linux")]
impl Sender {
    fn run() -> anyhow::Result<()> {
        use evdev::{AttributeSet, BusType, EventType, InputEvent, InputId, KeyCode, uinput::VirtualDevice};
        use std::{str::FromStr, thread, time::Duration};
        let mut keys = AttributeSet::<KeyCode>::new();
        for code in 1..256 { keys.insert(KeyCode(code)); }
        // Not keyd's reserved virtual vendor: wildcard keyd config handles this test keyboard.
        let mut device = VirtualDevice::builder()?.name("TypeRelay test source").input_id(InputId::new(BusType::BUS_USB, 0x5452, 0x5453, 1)).with_keys(&keys)?.build()?;
        thread::sleep(Duration::from_millis(800));
        let text = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("Supply test text"))?;
        let expected_class = std::env::args().nth(2).ok_or_else(|| anyhow::anyhow!("Supply the disposable window's exact class"))?;
        let expected_address=std::env::args().nth(3);
        let focused=||->anyhow::Result<()>{let active=std::process::Command::new("hyprctl").args(["-j","activewindow"]).output()?;let active:serde_json::Value=serde_json::from_slice(&active.stdout)?;anyhow::ensure!(active["class"].as_str()==Some(&expected_class)&&expected_address.as_ref().is_none_or(|address|active["address"]==*address),"Test window lost focus; input aborted");Ok(())};
        if text == "--ctrl-enter" {
            focused()?;
            for key in [KeyCode::KEY_LEFTCTRL,KeyCode::KEY_ENTER]{device.emit(&[InputEvent::new(EventType::KEY.0,key.0,1)])?;}
            thread::sleep(Duration::from_millis(600));
            for key in [KeyCode::KEY_ENTER,KeyCode::KEY_LEFTCTRL]{device.emit(&[InputEvent::new(EventType::KEY.0,key.0,0)])?;}
            thread::sleep(Duration::from_millis(800));return Ok(());
        }
        if text == "--panel-hotkey" {
            focused()?;
            for (key,value) in [(KeyCode::KEY_LEFTCTRL,1),(KeyCode::KEY_LEFTSHIFT,1),(KeyCode::KEY_COMMA,1),(KeyCode::KEY_COMMA,0),(KeyCode::KEY_LEFTSHIFT,0),(KeyCode::KEY_LEFTCTRL,0)] {
                device.emit(&[InputEvent::new(EventType::KEY.0,key.0,value)])?; thread::sleep(Duration::from_millis(10));
            }
            thread::sleep(Duration::from_millis(800)); return Ok(());
        }
        if text == "--overlap" {
            focused()?;
            let keys=[KeyCode::KEY_SEMICOLON,KeyCode::KEY_B,KeyCode::KEY_R,KeyCode::KEY_B,KeyCode::KEY_SPACE,KeyCode::KEY_X];
            device.emit(&[InputEvent::new(EventType::KEY.0,keys[0].0,1)])?;
            for pair in keys.windows(2) {device.emit(&[InputEvent::new(EventType::KEY.0,pair[1].0,1)])?;thread::sleep(Duration::from_millis(5));device.emit(&[InputEvent::new(EventType::KEY.0,pair[0].0,0)])?;thread::sleep(Duration::from_millis(5));}
            device.emit(&[InputEvent::new(EventType::KEY.0,keys[keys.len()-1].0,0)])?;
            thread::sleep(Duration::from_millis(800)); return Ok(());
        }
        for character in text.chars() {
            focused()?;
            let name = match character {
                '{' => "KEY_LEFTBRACE".into(), '}' => "KEY_RIGHTBRACE".into(), ':' => "KEY_SEMICOLON".into(), '\t' => "KEY_TAB".into(), ',' => "KEY_COMMA".into(), ';' => "KEY_SEMICOLON".into(), ' ' => "KEY_SPACE".into(), '-' => "KEY_MINUS".into(), '\u{8}' => "KEY_BACKSPACE".into(), '\u{7f}' => "KEY_DELETE".into(), '\u{1c}' => "KEY_LEFT".into(), '\u{1d}' => "KEY_RIGHT".into(), '\n' => "KEY_ENTER".into(), '\u{1b}' => "KEY_ESC".into(),
                c if c.is_ascii_alphabetic() || c.is_ascii_digit() => format!("KEY_{}", c.to_ascii_uppercase()),
                _ => anyhow::bail!("Unsupported test character"),
            };
            let key = KeyCode::from_str(&name).map_err(|_| anyhow::anyhow!("Invalid key"))?;
            let shifted=character.is_ascii_uppercase()||matches!(character,'{'|'}'|':');
            if shifted{device.emit(&[InputEvent::new(EventType::KEY.0,KeyCode::KEY_LEFTSHIFT.0,1)])?;}
            for value in [1, 0] {
                device.emit(&[InputEvent::new(EventType::KEY.0, key.0, value)])?;
                thread::sleep(Duration::from_millis(5));
            }
            if shifted{device.emit(&[InputEvent::new(EventType::KEY.0,KeyCode::KEY_LEFTSHIFT.0,0)])?;}
        }
        thread::sleep(Duration::from_millis(800));
        Ok(())
    }
}

fn main() -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    Sender::run()?;
    Ok(())
}
