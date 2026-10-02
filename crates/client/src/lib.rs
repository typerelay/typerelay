pub mod config;
#[cfg(feature = "desktop")]
pub mod native_ai;
#[cfg(all(feature = "desktop", target_os = "linux"))]
pub mod installation;
pub mod editor;
pub mod settings;
pub mod migration;
pub mod bridge;
pub mod browser_lease;
#[cfg(all(feature = "desktop", target_os = "linux"))]
pub mod desktop;
#[cfg(all(feature = "desktop", target_os = "linux"))]
pub mod capture_linux;
pub mod sync;
pub mod database;
mod legacy_yaml;

#[cfg(all(feature = "desktop", target_os = "linux"))]
pub mod clipboard;

#[cfg(all(feature = "desktop", target_os = "windows"))]
#[path = "clipboard_windows.rs"]
pub mod clipboard;

#[cfg(all(feature = "desktop", target_os = "macos"))]
#[path = "clipboard_macos.rs"]
pub mod clipboard;

pub mod panel;
#[cfg(feature = "desktop")]
pub mod observation;

#[cfg(all(feature = "desktop", target_os = "linux"))]
pub mod panel_ipc;

pub mod templates;
pub mod clipboard_payload;
pub mod assets;
