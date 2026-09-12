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
        for character in text.chars() {
            let active = std::process::Command::new("hyprctl").args(["-j", "activewindow"]).output()?;
            let active: serde_json::Value = serde_json::from_slice(&active.stdout)?;
            anyhow::ensure!(active["class"].as_str() == Some(&expected_class), "Test window lost focus; input aborted");
            let name = match character {
                ',' => "KEY_COMMA".into(), ';' => "KEY_SEMICOLON".into(), ' ' => "KEY_SPACE".into(), '-' => "KEY_MINUS".into(), '\u{8}' => "KEY_BACKSPACE".into(), '\n' => "KEY_ENTER".into(), '\u{1b}' => "KEY_ESC".into(),
                c if c.is_ascii_lowercase() || c.is_ascii_digit() => format!("KEY_{}", c.to_ascii_uppercase()),
                _ => anyhow::bail!("Unsupported test character"),
            };
            let key = KeyCode::from_str(&name).map_err(|_| anyhow::anyhow!("Invalid key"))?;
            for value in [1, 0] {
                device.emit(&[InputEvent::new(EventType::KEY.0, key.0, value)])?;
                thread::sleep(Duration::from_millis(5));
            }
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
