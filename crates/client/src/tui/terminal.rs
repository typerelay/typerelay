use anyhow::Result;
use ratatui::crossterm::{event::{EnableMouseCapture, DisableMouseCapture, EnableBracketedPaste, DisableBracketedPaste}, execute};
#[cfg(not(target_os = "windows"))]
use ratatui::crossterm::event::{PushKeyboardEnhancementFlags, PopKeyboardEnhancementFlags, KeyboardEnhancementFlags};
use std::io::{IsTerminal, Write};
use ratatui::crossterm::terminal::{enable_raw_mode, EnterAlternateScreen};

pub struct TerminalOutput;
impl Write for TerminalOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { std::io::stdout().write(bytes).or_else(|error| if TerminalSession::connected() { Err(error) } else { Ok(bytes.len()) }) }
    fn flush(&mut self) -> std::io::Result<()> { std::io::stdout().flush().or_else(|error| if TerminalSession::connected() { Err(error) } else { Ok(()) }) }
}
pub type Terminal = ratatui::Terminal<ratatui::backend::CrosstermBackend<TerminalOutput>>;

pub struct TerminalSession {
    #[cfg(target_os = "windows")]
    title: Vec<u16>,
}
impl TerminalSession {
    pub fn enter() -> Result<(Self, Terminal)> {
        #[cfg(target_os = "windows")]
        let title=Self::title()?;
        enable_raw_mode()?;
        let guard = Self {
            #[cfg(target_os = "windows")]
            title,
        };
        execute!(TerminalOutput, EnterAlternateScreen)?;
        let terminal = Terminal::new(ratatui::backend::CrosstermBackend::new(TerminalOutput))?;
        #[cfg(not(target_os = "windows"))]
        execute!(TerminalOutput, PushKeyboardEnhancementFlags(Self::keyboard_flags()), EnableMouseCapture, EnableBracketedPaste)?;
        #[cfg(target_os = "windows")]
        execute!(TerminalOutput, EnableMouseCapture, EnableBracketedPaste)?;
        Ok((guard, terminal))
    }
    #[cfg(not(target_os = "windows"))]
    fn keyboard_flags() -> KeyboardEnhancementFlags { KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES }
    #[cfg(target_os = "windows")]
    fn title()->Result<Vec<u16>>{use windows::{Win32::System::Console::{GetConsoleTitleW,SetConsoleTitleW},core::w};let mut title=vec![0;32768];let length=unsafe{GetConsoleTitleW(&mut title)} as usize;title.truncate(length);title.push(0);unsafe{SetConsoleTitleW(w!("TypeRelay TUI"))?;}Ok(title)}
    pub fn connected() -> bool {
        #[cfg(target_os = "linux")]
        {
            let mut descriptor = libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 };
            let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
            if result < 0 || descriptor.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 { return false; }
        }
        std::io::stdin().is_terminal()
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    #[test]
    fn keyboard_protocol_requests_layout_characters() { assert!(TerminalSession::keyboard_flags().contains(KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS)); }
}
impl Drop for TerminalSession {
    fn drop(&mut self) {
        #[cfg(not(target_os = "windows"))]
        let _ = execute!(TerminalOutput, DisableMouseCapture, DisableBracketedPaste, PopKeyboardEnhancementFlags);
        #[cfg(target_os = "windows")]
        {let _ = execute!(TerminalOutput, DisableMouseCapture, DisableBracketedPaste);unsafe{let _=windows::Win32::System::Console::SetConsoleTitleW(windows::core::PCWSTR(self.title.as_ptr()));}}
        let _ = ratatui::try_restore();
    }
}
