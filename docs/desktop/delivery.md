# Desktop panel delivery

Version 0.10.0 adds the shared panel and native adapters. Omarchy is installed with matching engine, TUI and panel binaries. The resident panel starts hidden, has a T tray icon and a managed launch-at-login entry. Installer backup: `~/.local/share/typerelay/storage-upgrade-vevwub0w`.

Live Omarchy verification passed:

- Ctrl+Shift+Semicolon opens a floating, themed panel.
- StatusNotifierItem Activate (the tray left-click action) opens search directly; the right-click menu exposes Sync now, Settings and Quit.
- Enter inserts into the original GTK editor, Chromium text field and Foot terminal.
- Multiline content, literal tabs and Unicode are preserved; Foot receives bracketed paste.
- Clipboard text is restored after insertion; Escape dismisses the panel.
- Test-only local libraries and disposable application profiles were removed. User snippets were not edited.
- Resident panel idle CPU measured zero scheduler ticks over a one-second sample; the expansion service remains active.

Automated checks cover portable search ordering, stale selection, permissions/lifecycle through existing database tests, shortcut validation, private IPC expiry and nonblocking full-socket behavior, installer ownership/uninstall, UI stale-search/Enter handling and existing engine/TUI tests. Both Cargo workspaces pass warnings-denied Clippy locally. GitHub builds produce a macOS app/dmg containing the panel and TUI, a Windows x64 NSIS installer containing the panel, CLI and TUI, and Linux packages/Omarchy bundle.

A Developer-ID-signed macOS build passed the real TextEdit HID regression on macOS 26.6.2 arm64: overlapping trigger keys, a following key pressed before Space-up, a following key pressed immediately after Space-up and a rapid three-character burst all preserve expansion and input order. A held-Space timeout also restores buffered input without leaving interception active. `scripts/macos-typing-smoke.swift` reproduces these timings through CoreGraphics rather than calling the matching engine directly.

The broader macOS and Windows runtime checklist in `panel.md` remains pending. Build success is not runtime certification. GitHub test artifacts remain unsigned/not notarized. Some clipboard formats require explicit Copy fallback rather than risking loss of the previous clipboard.
