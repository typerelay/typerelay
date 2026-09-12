# Install TypeRelay on Omarchy

## Install directly from GitHub

No checkout is needed. While the repository is private, sign in using `gh auth login`
with an account that has repository access, then run this Fish-compatible command:

```fish
gh api --hostname github.com -H 'Accept: application/vnd.github.raw+json' 'repos/typerelay/typerelay/contents/scripts/install.sh?ref=main' | sh
```

The bootstrap resolves the requested ref to a commit, downloads that exact source archive,
builds with the locked dependencies, then opens the existing interactive installer. It
does not stop the current client until you confirm the installer prompts. Temporary source
and build files are cleaned up afterward. Rust/Cargo, Python 3 and tar must be installed.
This initial distribution builds from source; it does not download a prebuilt release.

To preview without changing the installation, append `-s -- --dry-run` to `sh`. To select
a tag, branch or commit, append `-s -- --ref <ref>`. For example:

```fish
gh api --hostname github.com -H 'Accept: application/vnd.github.raw+json' 'repos/typerelay/typerelay/contents/scripts/install.sh?ref=main' | sh -s -- --dry-run
```

After the repository becomes public, this unauthenticated command will also work:

```fish
curl -fsSL https://raw.githubusercontent.com/typerelay/typerelay/main/scripts/install.sh | sh
```

## Install or update an existing binary

Run from a terminal as your desktop user:

```fish
typerelay install
```

From a fresh checkout, first build with `cargo build --workspace --bins --release --locked`, then run
`./target/release/typerelay install`. The installer is embedded in the executable;
it does not need the checkout afterward. Python 3, systemd, keyd, acl, udev, modprobe,
notify-send and sudo or pkexec must be available. Omarchy provides these dependencies.

The installer prints the exact paths and asks before proceeding. It also asks before
stopping manual TypeRelay clients or stopping/disabling Espanso. Possible conflicts with
AutoKey, xremap and kmonad are reported but are never silently killed. These checks do not
detect every possible third-party text expander or input injector. Keyd and Fcitx are
expected components, not competing expanders.

Administrator authentication is requested only to install scoped device-access rules.
The expander runs under a **systemd user service**, never as root. It starts with the
graphical session, stops with that session, and restarts after recoverable process/device
failures. Hyprland/Wayland environment variables come from the session, not hardcoded values
in the service file. The installer imports the current session values when available.

## Files installed

- `~/.local/bin/typerelay`: engine executable, replaced atomically during upgrades.
- `~/.local/bin/typerelay-tui`: [terminal snippet editor](TUI.md), installed with the engine.
- `~/.config/systemd/user/typerelay.service`: graphical-session service.
- `~/.config/typerelay/snippets/`: your active YAML files.
- `~/.local/share/typerelay/`: installer state and the device-access helper.
- `/etc/udev/rules.d/99-typerelay-<uid>.rules`: access for the effective keyd keyboard,
  pointer devices used for cancellation, and `/dev/uinput`.
- `/etc/modules-load.d/typerelay-<uid>.conf`: load uinput at boot.
- `/var/lib/typerelay/access-<uid>.json`: previous per-user ACL entries for uninstall.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` override their respective user directories. No broad
input-group membership, world-writable device modes or root execution capability is added.
The persistent rules reapply access when the relevant device nodes are created. Installer
updates preserve the original Espanso startup state for a later uninstall.

## Multiple snippet files

```text
~/.config/typerelay/snippets/
  mysnippets.yml
  sales.yml
  code.yaml
```

Each file has the same `matches:` list. TypeRelay loads all top-level regular `.yml` and
`.yaml` files in filename order. It does not follow snippet-file symlinks or recurse into
subdirectories. Keep backup files outside this folder or use a different extension.

Changes, additions and deletions are checked every 500 ms and replace the entire validated
snapshot. Duplicate triggers are errors, including duplicates across files; the error names
both files. Invalid edits retain the last working snapshot. An empty directory intentionally
loads zero snippets. Limits: 256 files, 1 MiB per file, 8 MiB combined.

On first installation, if this directory contains no active YAML files, an existing
`~/.config/typerelay/poc.yml` is copied to `mysnippets.yml`. The original and all existing
snippet files are preserved. Otherwise an empty `mysnippets.yml` is created.

```fish
typerelay validate                 # validate the default snippets directory
typerelay validate --dir ~/snippets
typerelay run --dir ~/snippets      # manual use with a different directory
typerelay run --file ~/one-file.yml # original single-file mode remains supported
```

Do not run a manual client while the service is active. The existing process lock prevents
two TypeRelay clients from taking over the keyboard.

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

Both source binaries must be present with matching versions before installation changes any
service state. The GitHub bootstrap builds both. The TUI is never started as a service.

**All snippet/configuration files are kept.** Installation never deletes the original POC
file or Espanso files. If installation fails after permissions were configured, installer
state remains available so rerunning install or uninstall can recover.

For this POC, install/start/stop require the user's systemd manager to be available. Keyboard
reconnects are handled by restarting the service; broad hotplug/compositor coverage still
requires more testing before deployment across a team.
