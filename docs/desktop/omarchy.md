---
title: "Install TypeRelay on Omarchy"
description: "Install, update, preview, operate, or uninstall TypeRelay on Omarchy, including systemd services, keyboard and uinput permissions, and local files."
---

# Omarchy installation and uninstall

## Install the latest Linux release

Requirements: Omarchy/Hyprland on x86_64, `curl`, Python 3 and `tar`. Omarchy provides the desktop runtime dependencies. No checkout, Rust compiler or Node.js installation is needed.

Run this command in **fish, bash or zsh** to download and start the installer:

```sh
curl -fsSLo /tmp/typerelay-install.sh https://raw.githubusercontent.com/typerelay/typerelay/main/scripts/install.sh && sh /tmp/typerelay-install.sh
```

The script downloads the latest prebuilt engine, TUI and desktop panel together. It checks
the bundle's SHA-256 checksum and size against that release's metadata before opening the
interactive installer. It does not stop the current client until you confirm the installer
prompts. Temporary downloads are cleaned up afterward.

To inspect or preview first, run only the `curl` command above. `less` displays the script;
press **q** to return to your terminal. Then preview or install:

```sh
less /tmp/typerelay-install.sh
```

```sh
sh /tmp/typerelay-install.sh --dry-run
```

```sh
sh /tmp/typerelay-install.sh
```

Always invoke the installer with `sh`, including from fish. If you already downloaded
an Omarchy `.tar.gz` archive, extract it and run `./typerelay install` in the directory
containing `typerelay`, `typerelay-tui` and `typerelay-panel`.

## Build a specific source revision

Passing `--ref` selects a source build instead of the prebuilt release. This requires
Rust/Cargo, Python 3 and `tar`; building the desktop panel also requires Node.js, pnpm,
`pkg-config`, GTK 3 and WebKitGTK 4.1 development packages. The script resolves the tag,
branch or commit to a pinned commit and builds with locked dependencies. For example:

```sh
sh /tmp/typerelay-install.sh --ref main
```

For a private checkout, authenticate GitHub CLI and stream the same file:

```sh
gh api --hostname github.com -H 'Accept: application/vnd.github.raw+json' 'repos/typerelay/typerelay/contents/scripts/install.sh?ref=main' | sh -s -- --ref main --dry-run
```

## Install or update an existing binary

Run from a terminal as your desktop user:

```fish
typerelay install
```

From a fresh checkout, first build with `cargo build --workspace --bins --release --locked`, then run
`./target/release/typerelay install`. The installer is embedded in the executable;
it does not need the checkout afterward. Python 3, systemd, acl, udev, modprobe,
notify-send and sudo or pkexec must be available. Building the panel also requires Node.js,
pnpm, GTK 3 and WebKitGTK 4.1 development packages. Omarchy provides the runtime dependencies.

The installer prints the exact paths and asks before proceeding. It also asks before
stopping manual TypeRelay clients or stopping/disabling Espanso. Possible conflicts with
AutoKey, xremap and kmonad are reported but are never silently killed. These checks do not
detect every possible third-party text expander or input injector. Keyd and Fcitx are
compatible components, not competing expanders. Keyd is optional.

When keyd is running, TypeRelay selects its effective virtual keyboard. Without keyd,
the installer selects a single built-in keyboard, or a single physical keyboard if no
built-in keyboard exists. Ambiguous selection requires an exact device name:

```fish
typerelay install --device-name 'AT Translated Set 2 keyboard'
```

The selected keyboard is saved for future updates. Direct input expands only on that
keyboard; other keyboards keep working normally. Stop keyd before selecting physical
input. Native Caps-to-Ctrl (`ctrl:nocaps` or `caps:ctrl_modifier`) is supported; use the
same option for the selected keyboard and TypeRelay's virtual keyboard, normally by
setting it globally in Hyprland. Caps shortcuts cancel pending abbreviations, and
expansion resumes after releasing Caps. Other native remappings are not supported.

Administrator authentication is requested only to install scoped device-access rules.
The expander runs under a **systemd user service**, never as root. It starts with the
graphical session, stops with that session, and restarts after recoverable process/device
failures. Hyprland/Wayland environment variables come from the session, not hardcoded values
in the service file. The installer imports the current session values when available.

## Files installed

- `~/.local/bin/typerelay`: engine executable, replaced atomically during upgrades.
- `~/.local/bin/typerelay-tui`: [terminal snippet editor](../cli/tui), installed with the engine.
- `~/.local/bin/typerelay-panel`: desktop search panel when included in the bundle.
- `~/.config/systemd/user/typerelay.service`: graphical-session service.
- `~/.config/typerelay/snippets/`: your library SQLite database and related storage.
- `~/.local/share/typerelay/`: installer state and the device-access helper.
- `/etc/udev/rules.d/99-typerelay-<uid>.rules`: access for the selected keyboard,
  pointer devices used for cancellation, and `/dev/uinput`.
- `/etc/modules-load.d/typerelay-<uid>.conf`: load uinput at boot.
- `/var/lib/typerelay/access-<uid>.json`: previous per-user ACL entries for uninstall.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` override their respective user directories. No broad
input-group membership, world-writable device modes or root execution capability is added.
The persistent rules reapply access when the relevant device nodes are created. Installer
updates preserve the original Espanso startup state for a later uninstall.

## Database-backed libraries

Libraries live in SQLite under the configured directory. Manage them through the TUI or web app.
YAML is explicit import/export only. First startup backs up and imports legacy YAML/sync state, then archives original files.
The installer also backs up the stopped client configuration before replacing binaries for rollback.
Active limits remain 256 libraries, 1 MiB serialized content per library, 8 MiB combined and 64 KiB per expansion.

## Service control and interference alerts

```fish
systemctl --user status typerelay
systemctl --user stop typerelay
systemctl --user restart typerelay
journalctl --user -u typerelay -f
```

If Espanso is detected at startup or appears while TypeRelay is running, TypeRelay reports
the conflict in the terminal/journal, sends a desktop notification, and stops. The service
does not repeatedly restart on this conflict. Stop Espanso and explicitly restart TypeRelay.
Checking for a competing device runs every two seconds.

The service stops only the main client, allowing its clipboard-restoration owner to retain
your clipboard. That helper exits automatically when another application takes clipboard
ownership. Snippet contents remain outside the repository.

## Preview and uninstall

```fish
typerelay install --dry-run
typerelay uninstall --dry-run
typerelay uninstall
```

Uninstall asks for confirmation, stops TypeRelay, removes its managed service and persistent
device rules, and restores prior ACL entries. It offers to restore the previous Espanso
startup/running state. Each managed binary is removed only if it still matches its installed
hash; replacements made outside the installer are preserved. Legacy engine-only manifests
remain supported. Snippets and settings are preserved.

The engine and TUI must be present with matching versions before installation changes any
service state. When the panel binary is present, it must match too. The Linux script downloads
all three by default; `--without-panel` installs only the engine and TUI. The TUI is never started as a service.

**All snippet/configuration files are kept.** Installation never deletes legacy YAML
or Espanso files. If installation fails after permissions were configured, installer
state remains available so rerunning install or uninstall can recover.

Install/start/stop require the user’s systemd manager to be available. Keyboard reconnects are
handled by restarting the service. Test hotplug and your exact keyboard/layout before team rollout.
