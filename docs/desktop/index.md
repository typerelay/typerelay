---
title: "TypeRelay Desktop"
description: "Use TypeRelay Desktop to search, expand, edit, and synchronize snippets from the menu bar or system tray on macOS, Windows, and Omarchy."
---

# Overview

The TypeRelay desktop app provides a resident search panel, continuous abbreviation expansion, local SQLite storage, background sync and the TypeRelay TUI.

| Platform | Package | Current scope |
| --- | --- | --- |
| Omarchy/Hyprland x86_64 | Installer plus engine, panel and TUI | Primary verified target; continuous expansion uses keyd/uinput and a US keyboard layout |
| macOS Apple Silicon | App/DMG with panel and TUI | Beta; Accessibility and Input Monitoring required |
| Windows x64 | NSIS installer with panel, CLI and TUI | Beta; layout-aware expansion |
| Other Linux desktops | GUI packages may launch | Continuous expansion and safe insertion are not supported; no non-Hyprland claim |

Read [Operating system notes](./platforms) before deployment. The resident app checks for signed updates shortly after launch and every six hours. Use **Check for updates…** from the tray/menu-bar menu for an immediate check.
