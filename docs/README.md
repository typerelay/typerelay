# TypeRelay POC

Use [typerelay-tui](TUI.md) to select files, search, add and edit snippets. It installs with
the engine. Settings stores a future sync URL; Sync is currently disabled.

Headless Rust text expansion for Omarchy/Hyprland with keyd and a US keyboard layout.
This repository is private for now, intended for a later open-source release. No project
license has been selected yet; choose one before making the repository public.

## Build and run

For login startup, persistent permissions and multiple snippet files, use the
[terminal installer](INSTALLATION.md): `typerelay install`. Preview with
`typerelay install --dry-run`; remove the installation with `typerelay uninstall`.
The manual commands below remain supported.

Install Rust, keyd, Python and acl using your distribution's package manager.
Build and run on the actual desktop host: this client needs that session's input devices
and Wayland sockets. Unit tests do not require Docker or device access.

Fish-compatible commands, from the repository:

```fish
cargo build --locked
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
./target/debug/typerelay validate --file examples/matches.yml
./target/debug/typerelay doctor

# Temporary access for the current device nodes; review the script before running.
sudo python scripts/session-access.py grant (id -un)
espanso stop
./target/debug/typerelay run --file examples/matches.yml
```

Type `,brb` and Space in an ordinary text field. The Space is consumed and the result is
`Be right back.`. Press Ctrl+C in the launching terminal to stop the client. Stopping or
crashing releases its exclusive grab. Manual execution does not install autostart configuration.
Startup waits for the launching Enter key to be released and 50 ms of keyboard inactivity
(up to five seconds). Events already delivered before startup are discarded, not replayed.

To stop from another terminal: `pkill -INT -f '(^|/)typerelay run( |$)'`. This leaves any
clipboard-restoration helper alive until the next copy. Ctrl+Alt+Backspace is not a
TypeRelay shortcut. To undo the session access and return to Espanso:

```fish
sudo python scripts/session-access.py revoke (id -un)
espanso start
```

Access is granted only to the named keyd keyboard, detected pointer devices (for candidate
cancellation), and `/dev/uinput`. It expires when device nodes are recreated. Restart the
client and repeat setup after reboot, keyd restart or pointer hotplug. Do not run TypeRelay
as root, grant `cap_dac_override`, or add the desktop user to the broad input group.
`revoke` removes the named user's ACL entries; review existing ACLs if independently set.

## Local snippets

`matches` is a list of `trigger`/`replace` pairs, compatible with Espanso's static YAML
format. No Espanso code or runtime is used. Triggers start with comma followed by 1–63
lowercase ASCII letters, digits or hyphens. Replacements support Unicode, paragraphs,
newlines and tabs, up to 65536 UTF-8 bytes. CRLF line endings normalize to LF. Bare carriage
returns, other control characters, dynamic markers and additional options are rejected.

```yaml
matches:
  - trigger: ",naf"
    replace: |-
      Sincerely,
      Nitai
      Ceo & Founder
  - trigger: ",reply"
    replace: "First paragraph.\n\nSecond paragraph.\n"
```

Type `,naf` then Space. YAML `|-` removes the final newline, `|` keeps one, and `|+`
preserves all trailing newlines. Blank lines inside the text are preserved.

```fish
mkdir -p ~/.config/typerelay
chmod 700 ~/.config/typerelay
cp -n ~/.config/espanso/match/base.yml ~/.config/typerelay/matches.yml
chmod 600 ~/.config/typerelay/matches.yml
./target/debug/typerelay import-espanso ~/.config/typerelay/matches.yml ~/.config/typerelay/poc.yml
./target/debug/typerelay run --file ~/.config/typerelay/poc.yml
```

The importer leaves the exact copy untouched, changes leading `;`/`:` to `,` (or prepends
`,` to unprefixed triggers), and reports unsupported entry numbers without printing their
content. Static entries with Espanso's `force_mode: clipboard` are accepted; insertion mode
is chosen automatically. It refuses to overwrite an existing destination or accept duplicate normalized
triggers. Personal files stay outside Git. Edit `poc.yml` to update snippets; the running
client checks every 500 ms. Invalid changes keep the previous valid snapshot.
For multiple files, use `--dir` or the default `~/.config/typerelay/snippets/` directory.
See [directory loading and conflict handling](INSTALLATION.md#multiple-snippet-files).

## Architecture and remote sync

- `crates/core`: source- and OS-independent validated snapshots and matching.
- `crates/client`: YAML loading, CLI, and the Omarchy adapter.
- `apps/server`: intentionally absent until there is server work.

The engine's `replace_snapshot` method is the integration boundary. Future HTTP sync
validates a complete downloaded snapshot, caches it atomically, then publishes it through
that same boundary. It must never put network work in the keyboard loop. Local snippet
paths/input configuration remain separate from synchronized content. No premature server
API, account schema, authentication or team model exists in the POC.

## Input behavior and limitations

The adapter exclusively reads keyd's effective keyboard and forwards through a dedicated
uinput keyboard. It uses keyd's reserved virtual vendor ID to prevent feedback into keyd.
The physical source is never read a second time. Short printable ASCII replacements use
the same native output device as normal typing, without clipboard modification. Multiline,
tabbed, Unicode and longer-than-512-byte replacements use a plain-text clipboard paste.
Newline characters are never emitted as Enter keys. The adapter uses Ctrl+Shift+V for
windows carrying Omarchy's `terminal` tag and Ctrl+V elsewhere. Terminal behavior relies
on the target program's bracketed-paste support; terminals without it can interpret pasted
newlines as commands, just as with a manual paste.

Clipboard preparation/restoration runs off the keyboard loop. Existing clipboard formats
and bytes are saved (maximum 64 formats / 16 MiB); if preservation fails, paste is declined.
A unique MIME marker prevents restoration from overwriting a newer user copy. The offer
stays available for 300 ms after the paste shortcut while following typing is buffered.
A lightweight clipboard owner preserves restored contents even after the client exits and
terminates when another application replaces them. The primary selection is not changed.
Clipboard managers may record transient expansion text. Apps that delay or intercept paste
can require additional integration; clipboard handoff is not an application-level receipt.

Space is suppressed only for a valid match, and subsequent physical input waits until
insertion ends. No snippet is executed as a shell command by TypeRelay.

Backspace edits the candidate. Unsupported keys, modifiers, pointer activity, desktop focus
events and ten seconds of inactivity cancel it. Expansion checks the lock state and target
window immediately before insertion. New expansions cannot start in a locked session. Caps Lock and layouts
other than US are outside this POC's supported configuration. IME/composition workflows,
password-field detection, rich text, variable forms and other OS adapters
are not implemented. Never treat a global expander as a password manager.

There is no compositor-wide atomic transaction for deletion plus insertion: a focus change
*during* insertion can still interrupt it. Application-specific behavior and all application
versions are not guaranteed. If clipboard paste fails, there is no automatic retry; text may
be partially edited. Fatal input-device errors stop the client.
External input injectors and all input-device disconnect scenarios need further
hardening before release. The POC is not ready for unattended installation across a team.

## Desktop verification

`python scripts/desktop-smoke.py` creates disposable GTK, Chromium and Foot windows, runs
the native input tests, then restores Espanso and prior focus. Keep keyboard and mouse idle
during this explicitly invoked test. Build the driver with `cargo build --examples` first.
The `send_keys` driver requires test text and the disposable window's exact class; it aborts
if that window loses focus. Never point it at a shell prompt. Tests cover GTK text input,
a browser field and a terminal text reader. Check exact output, overlapping triggers,
Backspace, unknown triggers, trailing typing, punctuation, multiline text, blank lines,
tabs, Unicode and clipboard preservation. The terminal fixture enables bracketed paste and
asserts that line breaks arrive within its paste delimiters rather than as Enter keys.

Native UI testing requires a live desktop and temporary input access; ordinary CI validates
core logic on Linux, macOS and Windows and the client/configuration on Linux. It does not
validate system-wide expansion on other OSes.
