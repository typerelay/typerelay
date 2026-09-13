use anyhow::Result;
use ratatui::crossterm::{event::{EnableMouseCapture, DisableMouseCapture, EnableBracketedPaste, DisableBracketedPaste, PushKeyboardEnhancementFlags, PopKeyboardEnhancementFlags, KeyboardEnhancementFlags}, execute};
use std::io::{IsTerminal, Write};
use ratatui::crossterm::terminal::{enable_raw_mode, EnterAlternateScreen};

pub struct TerminalOutput;
impl Write for TerminalOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { std::io::stdout().write(bytes).or_else(|error| if TerminalSession::connected() { Err(error) } else { Ok(bytes.len()) }) }
    fn flush(&mut self) -> std::io::Result<()> { std::io::stdout().flush().or_else(|error| if TerminalSession::connected() { Err(error) } else { Ok(()) }) }
}
pub type Terminal = ratatui::Terminal<ratatui::backend::CrosstermBackend<TerminalOutput>>;

pub struct TerminalSession;
impl TerminalSession {
    pub fn enter() -> Result<(Self, Terminal)> {
        enable_raw_mode()?;
        let guard = Self;
        execute!(TerminalOutput, EnterAlternateScreen)?;
        let terminal = Terminal::new(ratatui::backend::CrosstermBackend::new(TerminalOutput))?;
        execute!(TerminalOutput, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES), EnableMouseCapture, EnableBracketedPaste)?;
        Ok((guard, terminal))
    }
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
impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = execute!(TerminalOutput, DisableMouseCapture, DisableBracketedPaste, PopKeyboardEnhancementFlags);
        let _ = ratatui::try_restore();
    }
}
