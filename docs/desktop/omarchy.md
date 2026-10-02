---
title: "TypeRelay on Omarchy"
description: "Install the compiled TypeRelay AppImage on Omarchy, retain keyboard access after reboot, and use the desktop panel and terminal editor."
---

# Omarchy

Download the compiled [Linux x86_64 AppImage](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.AppImage), make it executable, and launch it from a stable location. It includes the expansion engine, TUI, desktop panel, tray menu and sync. No source build or separate installer is required. Follow the [installation guide](./installation) for package verification and updates.

## First launch

Accept **Keyboard access** and authenticate with Linux once. Setup installs persistent access for physical keyboards in Automatic mode (or your explicitly selected keyboard), pointer devices used to cancel abbreviations, and `/dev/uinput`. It also loads uinput at boot. Access returns after reboot or device reconnection without another routine permission prompt. The engine runs as your desktop user while the AppImage is open; Quit stops it. Enable **Launch at login** in Settings for automatic startup.

Setup installs the `typerelay` and `typerelay-tui` terminal launchers in `/usr/local/bin`. They run the matching binaries inside your registered AppImage; no independently updated engine or TUI copies are needed. Each desktop user registers their own AppImage on first launch. The panel/search and TUI also appear in the application menu.

```fish
typerelay --version
typerelay-tui --version
typerelay-tui
```

Keep the AppImage at its registered path. If you move it, launch the new location once to refresh its registration. Updates replacing the AppImage at the same path automatically update both terminal commands.

## Keyboard support

Expansion requires Hyprland with a US keyboard layout. **Automatic — all keyboards** listens to connected physical text keyboards together, including the laptop, USB and Bluetooth keyboards. New keyboards receive access through the persistent udev rule. Software-generated virtual keyboards are excluded to prevent feedback; keyd is not required. Existing explicit keyboard selection remains available under **Settings → Advanced → Miscellaneous → Keyboard**. A previous Automatic fallback no longer limits input to one device.

Devices are identified using their kernel identity and capabilities, so a mouse or media interface with the same name is not grabbed as a text keyboard. Numeric Hyprland name suffixes are resolved without choosing a different layout arbitrarily. Ambiguous or incompatible layouts leave that device unavailable and report the reason; other usable keyboards keep working.

New keyboards activate after their keys are released and a short idle period. Disconnects release only that device's held keys, cancel pending insertions and preserve the other keyboards. Switching keyboards cancels an unfinished abbreviation. The existing watchdog releases all grabs if forwarding stalls for five seconds. Temporary input/compositor failures reconnect automatically; no startup or pre-reconnect typing is replayed.

The panel reports input as ready, degraded or unavailable, independently of observation. **Suggestions → Check setup → Repair keyboard input** repairs persistent permissions when needed and restarts the worker. `typerelay-panel --capture-status` includes an `input` object with active devices, unavailable reasons, and reconciliation/heartbeat timestamps; no typed content is logged. A running process alone does not establish readiness.

For Caps mapped to Ctrl/Escape, use Hyprland's native `caps:ctrl_modifier` consistently for both the selected keyboard and TypeRelay's virtual keyboard. Caps shortcuts cancel pending abbreviations; expansion resumes after releasing Caps. Other native remappings are not supported.

Espanso or another conflicting expander must be stopped before using TypeRelay. AppImage setup preserves your snippets, settings and any saved keyboard selection from a previous managed installation. It retires the previous managed TypeRelay user service; unmanaged services are preserved and reported as conflicts.

## Installed integration

- `/usr/local/bin/typerelay` and `/usr/local/bin/typerelay-tui`: shared terminal launchers that resolve each user's registered AppImage.
- `~/.local/share/typerelay/appimage-path`: the current user's AppImage location.
- `~/.local/share/applications/typerelay-panel.desktop` and `typerelay-tui.desktop`: menu entries.
- `/etc/udev/rules.d/99-typerelay-<uid>.rules`: persistent access covering physical keyboards in Automatic mode (or the explicit selection), pointer devices and uinput.
- `/etc/modules-load.d/typerelay-<uid>.conf`: load uinput at boot.
- `~/.config/typerelay/`: settings and local SQLite libraries.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` override their respective user directories. Setup preserves unmanaged files and does not add broad input-group membership or world-writable device modes. Manage libraries through the [TUI](../cli/tui), desktop or web app; YAML is explicit import/export.

## Legacy source installations

The old standalone installer is retained only for existing installations and developer builds with the `legacy-install` feature. Its `install`, `setup` and `uninstall` commands are excluded from current desktop packages. Install a compiled desktop release for normal use. deb/rpm use their package-managed user service; AppImage runs its bundled engine directly.

## Reliability acceptance for development builds

After installing an input change, verify shortcut and plain/rich/template expansion on both laptop and external keyboards across three cold boots, three unplug/replug cycles and three suspend/resume cycles. Also boot without the external keyboard and attach it afterward. Check ordinary typing, Caps-to-Ctrl and discovery capture after recovery. Automated tests and live device readiness do not replace these physical checks.
