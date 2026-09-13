# Desktop panel delivery

Version 0.10.0 adds the shared panel and native adapters. Omarchy is installed with matching engine, TUI and panel binaries. The resident panel starts hidden, has a T tray icon and a managed launch-at-login entry. Installer backup: `~/.local/share/typerelay/storage-upgrade-vevwub0w`.

Live Omarchy verification passed:

- Ctrl+Shift+Comma opens a floating, themed panel.
- StatusNotifierItem Activate (the tray left-click action) opens search directly; the right-click menu exposes Sync now, Settings and Quit.
- Enter inserts into the original GTK editor, Chromium text field and Foot terminal.
- Multiline content, literal tabs and Unicode are preserved; Foot receives bracketed paste.
- Clipboard text is restored after insertion; Escape dismisses the panel.
- Test-only local libraries and disposable application profiles were removed. User snippets were not edited.
- Resident panel idle CPU measured zero scheduler ticks over a one-second sample; the expansion service remains active.

Automated checks cover portable search ordering, stale selection, permissions/lifecycle through existing database tests, shortcut validation, private IPC expiry and nonblocking full-socket behavior, installer ownership/uninstall, UI stale-search/Enter handling and existing engine/TUI tests. Both Cargo workspaces pass warnings-denied Clippy locally. GitHub builds produce macOS Apple Silicon app/dmg, Windows x64 NSIS and Linux packages/Omarchy bundle.

macOS and Windows runtime verification remains pending the user's checklist in `panel.md`. Build success is not runtime certification. Artifacts are unsigned/not notarized. Some clipboard formats require explicit Copy fallback rather than risking loss of the previous clipboard.
