---
title: "TypeRelay on Omarchy"
description: "Install the compiled TypeRelay AppImage on Omarchy, retain keyboard access after reboot, and use the desktop panel and terminal editor."
---

# Omarchy

Download the compiled [Linux x86_64 AppImage](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.AppImage), make it executable, and launch it from a stable location. It includes the expansion engine, TUI, desktop panel, tray menu and sync. No source build or separate installer is required. Follow the [installation guide](./installation) for package verification and updates.

## First launch

Accept **Keyboard access** and authenticate with Linux once. Setup installs persistent access for your selected keyboard, pointer devices used to cancel abbreviations, and `/dev/uinput`. It also loads uinput at boot. Access returns after reboot or device reconnection without another routine permission prompt. The engine runs as your desktop user while the AppImage is open; Quit stops it. Enable **Launch at login** in Settings for automatic startup.

Setup installs the `typerelay` and `typerelay-tui` terminal launchers in `/usr/local/bin`. They run the matching binaries inside your registered AppImage; no independently updated engine or TUI copies are needed. Each desktop user registers their own AppImage on first launch. The panel/search and TUI also appear in the application menu.

```fish
typerelay --version
typerelay-tui --version
typerelay-tui
```

Keep the AppImage at its registered path. If you move it, launch the new location once to refresh its registration. Updates replacing the AppImage at the same path automatically update both terminal commands.

## Keyboard support

Expansion currently requires Hyprland with a US keyboard layout. When keyd is active, TypeRelay uses `keyd virtual keyboard`; stop keyd before selecting a physical keyboard. Otherwise it selects a single built-in keyboard, or a single non-virtual keyboard when no built-in keyboard exists. If several keyboards qualify, choose **Settings → General → Keyboard** and save. Your choice is retained after restart; changing it updates the expansion engine and prompts for access when necessary. Devices are identified by keyboard capabilities, so a mouse or media interface with the same device name is not grabbed as a keyboard.

**Automatic selection** uses normal detection when it resolves one keyboard. If detection is ambiguous, it retains your previous keyboard choice while that device remains available. Saving Automatic selection preserves this fallback across restarts. TypeRelay's own virtual output is never a candidate.

If input forwarding stops making progress for five seconds, the engine exits to release its keyboard grab. A stalled template also releases buffered typing after five seconds without progress. Restart TypeRelay to resume expansion after an engine error.

For Caps mapped to Ctrl/Escape, use Hyprland's native `caps:ctrl_modifier` consistently for both the selected keyboard and TypeRelay's virtual keyboard. Caps shortcuts cancel pending abbreviations; expansion resumes after releasing Caps. Other native remappings are not supported.

Espanso or another conflicting expander must be stopped before using TypeRelay. AppImage setup preserves your snippets, settings and any saved keyboard selection from a previous managed installation. It retires the previous managed TypeRelay user service; unmanaged services are preserved and reported as conflicts.

## Installed integration

- `/usr/local/bin/typerelay` and `/usr/local/bin/typerelay-tui`: shared terminal launchers that resolve each user's registered AppImage.
- `~/.local/share/typerelay/appimage-path`: the current user's AppImage location.
- `~/.local/share/applications/typerelay-panel.desktop` and `typerelay-tui.desktop`: menu entries.
- `/etc/udev/rules.d/99-typerelay-<uid>.rules`: persistent access scoped to the selected keyboard, pointer devices and uinput.
- `/etc/modules-load.d/typerelay-<uid>.conf`: load uinput at boot.
- `~/.config/typerelay/`: settings and local SQLite libraries.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` override their respective user directories. Setup preserves unmanaged files and does not add broad input-group membership or world-writable device modes. Manage libraries through the [TUI](../cli/tui), desktop or web app; YAML is explicit import/export.

## Legacy source installations

The old standalone installer is retained only for existing installations and developer builds with the `legacy-install` feature. Its `install`, `setup` and `uninstall` commands are excluded from current desktop packages. Install a compiled desktop release for normal use. deb/rpm use their package-managed user service; AppImage runs its bundled engine directly.
