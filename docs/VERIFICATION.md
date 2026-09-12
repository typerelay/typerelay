# POC verification — 2026-09-11

## Installer and snippet directories (0.3.0)

- Rust regression coverage includes multiple files, additions/edits/deletions, duplicate
  trigger diagnostics and recovery, empty-directory behavior, and competing-device detection.
- Six Python installer tests cover dry run/cancellation without writes, install/upgrade/
  uninstall preserving snippets, restoring Espanso on failure, preserving replaced binaries,
  unit path quoting and restoring previous scoped ACLs.
- `systemd-analyze --user verify` accepted the generated service. `udevadm verify` accepted
  the generated persistent access rules on systemd/udev 261.
- A read-only installer preview detected the existing manual client and Espanso autostart.
- The actual installer was opened in a terminal and cancelled at its first prompt; no service
  or configuration was created, and the existing client continued running.
- No actual service switchover, uninstall or reboot test was performed in this implementation
  session; those require the interactive installer. The user's running client was left alone.

## Startup fix (0.2.1)

- Startup waits for release of the launching key plus 50 ms of idle time (five-second bound).
- Tests cover launch-key release, renewed activity resetting the idle period and timeout.

## Multiline update (0.2.0)

- Twelve unit tests and strict Clippy passed, including CRLF normalization, YAML literal
  blocks, trailing blank lines, long paragraphs and no Enter events in multiline insertion.
- Live GTK4 TextView, native Wayland Chromium textarea and Foot tests passed with consecutive
  native/multiline expansions, blank lines, tabs, Unicode and immediate following typing.
- Foot's raw-input fixture verified every pasted linebreak arrived inside bracketed-paste
  delimiters. Clipboard text was restored; prior desktop focus and Espanso state were restored.
- Multiline, non-ASCII, tabbed and long text now use clipboard paste; short ASCII text still
  uses native uinput strokes. All offered clipboard formats are captured and republished;
  explicit binary/multi-format ownership-race tests remain future coverage.
- The original personal YAML was untouched. Two previously skipped static text entries were
  added to the local POC file, bringing it to 63 snippets. Existing entries were not overwritten.

## Initial implementation (0.1.0)

Host: Omarchy 4.0.3, Hyprland 0.56.2, Linux x86_64, US layout, keyd, Rust 1.98.1.

- Eight unit tests passed: trigger matching, correction, cancellation, overlap, snapshot
  replacement, unsupported YAML, invalid reload recovery and ASCII key mapping.
- Clippy passed with warnings denied.
- Live `scripts/desktop-smoke.py` passed in GTK4, native Wayland Chromium and Foot.
- Each desktop target verified exact expansion output, rapid following text, consecutive
  expansions, overlapping abbreviations, Backspace correction, unknown triggers and mixed
  case/punctuation in replacements.
- Clipboard contents were unchanged by the desktop run.
- Test processes were stopped; Espanso and previous focus were restored.

The first wtype implementation was discarded after live tests exposed lost replacement
text and inconsistent ordering. The shipped adapter forwards ordinary typing and expanded
ASCII text through the same uinput output device, with a bounded queue for incoming keys
while expansion runs. It never starts shell commands or modifies the clipboard.

Not verified: physical-device hotplug, prolonged stress/overflow, lock during insertion,
all focus-race cases, IMEs, non-US layouts, remote sync, macOS/Windows input adapters.
Unicode, multiline text and interactive variables are explicitly outside this POC.
