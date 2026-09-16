# Installation

Install only an artifact whose version, platform and architecture match the release announcement. The engine, panel and TUI must use the same version; desktop/server sync requires protocol 6. Test artifacts may be unsigned. Production releases should be signed, and macOS releases notarized.

## Omarchy/Hyprland

The repository installer builds and installs the matching engine, panel and TUI, configures a systemd user service and adds narrowly scoped device permissions. It never runs TypeRelay as root. Review the complete [Omarchy installation and uninstall guide](./omarchy) before running it.

The generic Linux AppImage or DEB installs only the GUI. It does not configure the Omarchy input service, keyd/uinput permissions or non-Hyprland insertion support.

## macOS

Open the DMG and install **TypeRelay.app**. The app bundles **TypeRelay TUI**, available from the menu-bar menu or **Settings → General**. Both use:

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

The app checks for updates automatically and offers to download and restart. On Omarchy, a managed update replaces the engine, TUI and panel together and rolls back on failure. Do not mix standalone binaries from different releases.

Uninstalling preserves snippets, settings and sync credentials unless you remove the platform data directory yourself. Back up or export important libraries before deleting that directory.
