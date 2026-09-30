---
title: "Install TypeRelay Desktop"
description: "Install TypeRelay Desktop on Omarchy, macOS, or Windows, grant required permissions, verify packages, and understand upgrades and removal."
---

# Installation

Install only an artifact whose version, platform and architecture match the release announcement. The engine, panel and TUI must use the same version; desktop/server sync requires protocol 6. Test artifacts may be unsigned. Production releases should be signed, and macOS releases notarized.

## Linux

Download [AppImage](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.AppImage), [deb](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.deb), or [rpm](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.rpm), in that order of preference. Each x86_64 package includes the engine, TUI, panel, tray menu, sync, settings and update checking. Omarchy uses AppImage.

Make the AppImage executable and keep it at a stable path before launching. Install deb/rpm with the distribution package manager. First launch opens a setup prompt for the per-user expansion service and scoped keyboard permissions. Setup uses a foot terminal and requires Python 3, systemd, udev, ACL tools, kmod and notify-send; these are provided by Omarchy or declared as deb/rpm dependencies. Expansion currently supports Hyprland with a US keyboard layout.

The engine and TUI are staged under `~/.local/bin` so they remain available after an AppImage unmounts. The panel stays in its installed package. After a package update, launch TypeRelay to refresh the matching engine and TUI automatically. If keyboard access needs repair, setup asks again. Close the TUI before upgrading.

When moving from the former standalone installer, quit the old panel first, then launch the new package and complete setup. Existing snippets and settings are preserved. See [Linux service management](./omarchy) for keyboard selection, service commands and removal.

## macOS

Open the DMG and install **TypeRelay.app**. The app bundles **TypeRelay TUI**, available from **Settings → General**. Both use:

```text
~/Library/Application Support/TypeRelay
```

Grant Accessibility and Input Monitoring when macOS prompts. Accessibility lets TypeRelay identify/restore the original window and insert text; Input Monitoring lets it detect abbreviations typed in other apps. If a differently signed development build replaces the app, macOS may treat it as a different application and require permission again. Official releases use a stable signing identity.

Before manually removing an app installed in `/Applications`, unregister launch-at-login:

```fish
/Applications/TypeRelay.app/Contents/MacOS/typerelay-panel --uninstall
```

Then remove the app. Local snippets and settings remain.

## Windows

Run the x64 NSIS installer. It installs the resident panel plus **TypeRelay TUI** in the Start menu. Both use:

```text
%LOCALAPPDATA%\TypeRelay
```

The Windows uninstaller removes the startup entry and TUI shortcut but preserves the local database and settings.

## Upgrade and uninstall behavior

The app silently downloads and verifies signed updates, then asks once: **Install and restart** or **Later**. Choosing **Later** keeps the download ready and pauses automatic reminders for that version until the next launch. Use **Install update…** in the tray/menu-bar menu to reopen the prompt anytime. Cached downloads are verified again before reuse. Operating-system permission dialogs may still appear. Linux updates use the installed package format: AppImage, deb or rpm. deb/rpm installation may request administrator access. After restart, the bundled engine and TUI refresh together through the existing service setup. Legacy standalone installations retain their signed update path. Do not mix standalone binaries from different releases.

Uninstalling preserves snippets, settings and sync credentials unless you remove the platform data directory yourself. Back up or export important libraries before deleting that directory.
