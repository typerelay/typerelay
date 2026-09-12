# TypeRelay POC

Headless Rust text expansion for Omarchy/Hyprland with keyd and a US keyboard layout.
This repository is private for now, intended for a later open-source release. No project
license has been selected yet; choose one before making the repository public.

## Build and run

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
crashing releases its exclusive grab. No startup/autostart configuration is installed.

To stop from another terminal: `pkill -INT -x typerelay`. Ctrl+Alt+Backspace is not a
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
lowercase ASCII letters, digits or hyphens. Replacements are single-line printable ASCII text,
up to 4096 UTF-8 bytes. Newlines, tabs, control characters, dynamic markers and additional
options are rejected. This deliberately prevents imported shell snippets from sending Enter.

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
content. It refuses to overwrite an existing destination or accept duplicate normalized
triggers. Personal files stay outside Git. Edit `poc.yml` to update snippets; the running
client checks every 500 ms. Invalid changes keep the previous valid snapshot.

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
The physical source is never read a second time. Replacement strokes use the same native output device as normal typing,
without subprocesses, shell execution or clipboard modification. Space is
suppressed only for a valid match, and subsequent physical input waits until insertion ends.

Backspace edits the candidate. Unsupported keys, modifiers, pointer activity, desktop focus
events and ten seconds of inactivity cancel it. Expansion checks the lock state and target
window immediately before insertion. New expansions cannot start in a locked session. Caps Lock and layouts
other than US are outside this POC's supported configuration. IME/composition workflows,
password-field detection, Unicode replacement, rich text, multiline insertion, variable forms and other OS adapters
are not implemented. Never treat a global expander as a password manager.

There is no compositor-wide atomic transaction for deletion plus insertion: a focus change
*during* insertion can still interrupt it. Application-specific behavior and all application
versions are not guaranteed. If insertion fails, the client exits; text may be partially edited.
External input injectors and all input-device disconnect scenarios need further
hardening before release. The POC is not ready for unattended installation across a team.

## Desktop verification

`python scripts/desktop-smoke.py` creates disposable GTK, Chromium and Foot windows, runs
the native input tests, then restores Espanso and prior focus. Keep keyboard and mouse idle
during this explicitly invoked test. Build the driver with `cargo build --examples` first.
The `send_keys` driver requires test text and the disposable window's exact class; it aborts
if that window loses focus. Never point it at a shell prompt. Tests cover GTK text input,
a browser field and a terminal text reader. Check exact output, overlapping triggers,
Backspace, unknown triggers, trailing typing, punctuation, clipboard preservation and restart.

Native UI testing requires a live desktop and temporary input access; ordinary CI validates
core logic on Linux, macOS and Windows and the client/configuration on Linux. It does not
validate system-wide expansion on other OSes.
