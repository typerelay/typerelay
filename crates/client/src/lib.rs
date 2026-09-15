pub mod config;
pub mod editor;
pub mod settings;
pub mod migration;
pub mod bridge;
#[cfg(target_os = "linux")]
pub mod desktop;
pub mod sync;
pub mod database;
mod legacy_yaml;

#[cfg(target_os = "linux")]
pub mod clipboard;

#[cfg(target_os = "windows")]
#[path = "clipboard_windows.rs"]
pub mod clipboard;

#[cfg(target_os = "macos")]
#[path = "clipboard_macos.rs"]
pub mod clipboard;

pub mod panel;

#[cfg(target_os = "linux")]
pub mod panel_ipc;

pub mod templates;
