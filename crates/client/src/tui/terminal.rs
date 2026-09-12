use anyhow::Result;
use ratatui::crossterm::{event::{EnableMouseCapture, DisableMouseCapture, EnableBracketedPaste, DisableBracketedPaste}, execute};
use std::io::IsTerminal;

pub struct TerminalSession;
impl TerminalSession {
    pub fn enter() -> Result<(Self, ratatui::DefaultTerminal)> {
        let terminal = ratatui::try_init()?;
        let guard = Self;
        execute!(std::io::stdout(), EnableMouseCapture, EnableBracketedPaste)?;
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
        let _ = execute!(std::io::stdout(), DisableMouseCapture, DisableBracketedPaste);
        ratatui::restore();
    }
}
