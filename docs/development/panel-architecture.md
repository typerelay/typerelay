# TypeRelay desktop panel (v0.10)

Ctrl+Shift+Comma opens the panel. Left-click the T icon to search; right-click for Sync now, Settings and Quit TypeRelay. Closing the panel hides it; Quit stops only the panel, not Omarchy's expansion service. Settings controls the shortcut and launch at login, plus browser connection and explicitly selected local-library enrollment.

The panel uses a shared local Pug/JavaScript UI in Tauri. Linux reads Omarchy theme colors; macOS and Windows use platform fonts and light/dark styles. Search uses the existing SQLite store, requires no network, includes active read-accessible libraries and snippets without abbreviations, and ranks exact abbreviations, abbreviation prefixes, abbreviation substrings and content matches. Results include the library and a literal preview. Enter revalidates the record ID/revision/access before insertion; Copy also revalidates.

## Platform adapters

- Omarchy/Hyprland: existing evdev/keyd service detects the configured shortcut. A private Unix datagram channel opens the GUI; a separate worker validates insertion requests against SQLite before submitting them to the existing paste coordinator. The keyboard loop never waits on database validation or a full notification socket. Requests expire and are not replayed. The panel is excluded from expansion by live PID/start-time identity. Focus/placement use the current Omarchy Lua dispatcher API, not legacy Hyprland focuswindow commands. Linux tray activation uses ksni/StatusNotifierItem because the standard AppIndicator backend does not expose reliable left-click behavior.
- macOS: global hotkey + AppKit/Accessibility window identity and activation, CoreGraphics key-state checks, Enigo paste, template T status icon. Accessibility permission is required for target-window capture and insertion. A clipboard with multiple items is left untouched and automatic insertion is refused; Copy remains explicit.
- Windows: global hotkey, HWND + retained process handle, foreground verification, key-release checks and native input. Clipboard preservation uses native numeric format IDs, not registered string aliases. Opaque GDI clipboard formats that cannot be safely copied cause insertion to stop before modifying the clipboard. Elevated/protected applications can reject input; TypeRelay does not elevate itself to bypass that.

The original window is captured before showing the panel. The background target cache is used only when the foreground belongs to the panel/tray itself. A failed capture from a different application never falls back to an unrelated earlier target. After restoring focus, the adapter verifies identity again. Native focus and keyboard APIs are not one atomic OS operation; external focus changes can still race with input, so each platform needs real application testing.

Clipboard data is temporarily replaced, then restored only while TypeRelay's unique ownership marker remains. Linux preserves existing MIME types via the engine's helper. Windows checks/restores while holding the clipboard lock; macOS checks the pasteboard marker. No source commands or variables are evaluated.

## Configuration and storage

Existing Omarchy XDG paths are retained. macOS uses `~/Library/Application Support/TypeRelay`; Windows uses `%LOCALAPPDATA%/TypeRelay`. XDG_CONFIG_HOME remains an explicit override for isolated tests. Tokens stay in the existing private credentials file, outside the webview. The panel settings file is `panel.json`; existing YAML settings remain unchanged. No server API or sync-protocol change.

Omarchy private runtime files live under `$XDG_RUNTIME_DIR/typerelay-panel`. Stale registrations are ignored after process exit. The service and GUI must be upgraded together for panel insertion.

## Build and install

The GUI has its own Cargo workspace under `apps/desktop/src-tauri`, so server/helper builds do not acquire GTK/WebKit dependencies. UI files are generated from Pug using `pnpm build` in `apps/desktop`.

On Omarchy, build the ordinary release binaries, run `sh scripts/build-panel.sh`, then `target/release/typerelay install`. The GitHub bootstrap includes the panel by default; `--without-panel` keeps the engine/TUI-only path. Builds require Node, pnpm, GTK3 and WebKitGTK 4.1 development packages. Build/validation completes before the running engine stops.

The installer validates matching binaries, tracks optional panel ownership, adds a launcher, starts the panel in the background and preserves snippets/settings on upgrade/uninstall. The panel manages its own login entry. `typerelay-panel --quit` stops the resident panel. On macOS, run the app executable with `--uninstall` before removing the app to unregister startup; data remains. The Windows NSIS uninstall hook performs this cleanup automatically.

The Desktop panel builds workflow produces an Omarchy bundle containing engine, TUI and panel, plus Linux AppImage/deb, macOS Apple Silicon app/dmg and a Windows x64 NSIS build containing the panel, CLI and TUI. A shared staging script prepares the Windows tools for both CI and signed releases. The Linux GUI packages alone do not install the Omarchy input service. Beta artifacts are unsigned/not notarized; signing is needed before broad public distribution. No Intel Mac build or non-Hyprland Linux insertion support is claimed.

## Verification status

Portable Rust search/selection/shortcut tests, isolated IPC expiry/full-socket tests, installer ownership tests and shared UI stale-query/keyboard tests are automated. The live Omarchy smoke test confirmed global shortcut activation, a floating themed window, searching and exact insertion into the original GTK editor, clipboard restoration and Escape dismissal. Additional application/tray tests are recorded in delivery notes when completed.

macOS and Windows build success is not runtime verification. Their native behavior remains pending the user's checklist below.

## macOS / Windows checklist

1. Install and launch; allow Accessibility on macOS. Connect to your TypeRelay server using browser sign-in. Verify assigned libraries download and search still works offline.
2. Click the T icon: panel opens directly. Right-click: Sync now, Settings, Quit. Quit must not affect another separately running expansion client.
3. Press Ctrl+Shift+Comma from a browser field, text editor, notes app and terminal. Search, use arrows, press Enter: exactly one insertion into the originating window. Test multiline text, tabs, Unicode and snippets without abbreviations.
4. Open from a window on each monitor, including different display scales. Confirm centering and original-window restoration.
5. Test Escape, outside-click dismissal, closed target windows, permission denial and shortcut conflicts. No insertion into another app after a reported failure.
6. Copy rich text before insertion and check restoration afterward. Copy something new while insertion finishes and verify that newer copy survives. Unsupported clipboard formats must produce an error before replacement.
7. Change shortcut; confirm the old one stops working. Toggle launch at login; restart the session. Launch again while running: only one instance. Uninstall: startup entry gone, snippet data preserved.
8. On Windows, launch **TypeRelay TUI** from Start, edit a snippet, sync, and confirm the panel and web app show the same revision. Uninstall must remove the TUI shortcut while preserving the local database.
