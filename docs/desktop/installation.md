---
title: "Install TypeRelay Desktop"
description: "Install TypeRelay Desktop on Omarchy, macOS, or Windows, grant required permissions, verify packages, and understand upgrades and removal."
---

# Installation

Install only an artifact whose version, platform and architecture match the release announcement. The engine, panel and TUI must use the same version; desktop/server sync requires protocol 6. Test artifacts may be unsigned. Production releases should be signed, and macOS releases notarized.

## Linux

Install a compiled release: [AppImage](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.AppImage) for Omarchy/Arch, [deb](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.deb) for Debian/Ubuntu, or [rpm](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.rpm) for compatible RPM distributions. Prefer the distribution package when available; AppImage remains the portable option. Each x86_64 package includes the engine, TUI, panel, tray menu, sync, settings and update checking. Installing a release requires no Rust compiler or source checkout.

Make the AppImage executable and keep it at a stable path before launching. Install deb/rpm with the distribution package manager. Each package runs without the former Python installer or a setup terminal. Expansion currently supports Hyprland with a US keyboard layout.

AppImage runs the bundled engine directly while the panel is open; Quit stops its engine. First launch registers menu entries for the panel/search and TUI. Accepting the setup prompt also installs `typerelay` and `typerelay-tui` launchers in `/usr/local/bin`, on the standard terminal PATH. Each launcher resolves the current user's AppImage through `~/.local/share/typerelay/appimage-path` (`XDG_DATA_HOME` is respected), so multiple users can use their own installations. Terminal commands run the bundled engine/TUI in the existing terminal and forward command-line arguments. Moving an AppImage requires launching its new location once; updates at the same path need no command reinstallation. Native `/usr/bin` commands take precedence when a deb/rpm is also installed. Use the app’s launch-at-login setting to start the AppImage at login.

deb/rpm install the panel/search launcher, TUI launcher, engine, TUI, user service, udev rules and uinput module configuration through the package manager. The app starts the packaged user service. Device rules grant access to the active desktop session for keyd, pointers and uinput. A physical keyboard or missing device access triggers an in-app permission prompt followed by Linux administrator authentication, without opening a terminal. AppImage uses the same native setup prompt. Authorization installs persistent per-user rules for the selected keyboard, pointer cancellation and uinput, plus uinput loading at boot. Access applies immediately and returns when device nodes are recreated after reboot or reconnection; routine boots require no further permission prompt. A changed keyboard selection or administrator removal of these rules can require setup again.

When moving from the former standalone installer, quit the old panel first. The package stops the previous managed expansion service and removes its old user service override; snippets, settings and keyboard selection remain. An unmanaged service is preserved and reported as a conflict. Standalone binaries are left untouched but no longer launched by the package.

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

The app silently downloads and verifies signed updates, then asks once: **Install and restart** or **Later**. Choosing **Later** keeps the download ready and pauses automatic reminders for that version until the next launch. Use **Install update…** in the tray/menu-bar menu to reopen the prompt anytime. Cached downloads are verified again before reuse. Operating-system permission dialogs may still appear. Linux updates use the installed package format: AppImage, deb or rpm. deb/rpm installation may request administrator access. After restart, AppImage runs its new bundled engine; deb/rpm restart the updated packaged service. Legacy standalone installations retain their signed update path. Do not mix standalone binaries from different releases.

Uninstalling preserves snippets, settings and sync credentials unless you remove the platform data directory yourself. Back up or export important libraries before deleting that directory.
