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

Read [Operating system notes](./platforms) before deployment. The resident app checks for signed updates shortly after launch and every six hours. Updates download in the background and prompt once to install and restart. Choose **Later** to keep working; the download stays ready for the next launch or **Install update…** in the tray/menu-bar menu. Use **Check for updates** for an immediate check when no update is ready.

## Search or expand while you work

Use the search panel when you remember part of a title or phrase but not its abbreviation. Select the matching snippet, fill any prompted variables, and insert it into the application where you are writing. The [search panel guide](./panel) covers the interaction and how to work with different snippet types.

Continuous expansion is useful for wording you type frequently. Store the bare abbreviation, such as `email`, then type the local prefix, abbreviation and Space. With the default prefix, that is `;email `. Keep shortcuts distinctive so they do not overlap with ordinary writing. For practical examples, read [typing shortcuts for replies, signatures and phrases](https://typerelay.com/blog/typing-shortcuts-for-reusable-replies-signatures-and-phrases/).

## Prepare content for offline use

The desktop keeps content in local SQLite storage. After synchronization, local snippets remain available without a network connection. Connecting a desktop does not automatically enroll every local library for upload: choose which local libraries should synchronize. Accessible server libraries download automatically. See [desktop synchronization](./sync) before moving between computers.

Use the TUI to maintain local content, or the web app to manage accounts, sharing and team access. Exported YAML and bundle files are transfer copies; editing them does not change the live local database.

## Install and verify your platform

Follow [installation](./installation), grant the required operating-system permissions, and try a short snippet in the application you use most. Rich formatting depends on what the destination accepts. If expansion or insertion fails, use [troubleshooting](./troubleshooting) and the platform notes above to distinguish configuration problems from unsupported environments.
