> Historical file-based POC verification. Current database/sync checks are documented in [development](web/development.md).

# POC verification — 2026-09-11

## Local prefix / bare abbreviation migration (0.5.0, 2026-09-12)

- Core tests cover bare abbreviations, configurable prefix matching, rejecting invalid
  prefixes, and clearing unfinished matches when the prefix changes.
- Settings/TUI tests cover persistence, live reload and saving bare abbreviations while
  displaying the local prefix. Migration tests cover comments/text preservation, backups,
  idempotence and rejecting collisions/double prefixes before data writes.
- Installer rollback testing verifies restoration of original snippet data, binaries and
  manifest if the new service fails to start.
- Live GTK test verified comma activation, changing to semicolon without restarting the
  engine, rejecting the old prefix and leaving the snippet file byte-for-byte unchanged.
- Installed v0.5.0 engine and TUI on the user's machine. Migrated 64 active triggers with
  backups and confirmed every expansion remained identical. A second migration preview
  reported zero changes. The service was active afterward and the user was told to resume.
- Existing persistent device permissions were reused; no administrator changes were needed.

## Append fix (0.4.1, 2026-09-12)

- Reproduced failed additions to an indentless YAML list ending with a multiline quoted
  scalar: the editing library inserted the new dash at the wrong indentation.
- Block-list append now uses the actual existing dash column and syntax-tree end range.
  Flow lists retain their own append path; full validation still occurs before any write.
- Regression tests cover quoted multiline endings, zero/four-space indentation, CRLF,
  missing final newlines, flow lists and explicit YAML document endings.
- Verified against a temporary copy of the user's complete file: the requested new snippet
  saved while all 63 existing entries remained unchanged. The live file was untouched.

## TUI (0.4.0)

- A failed early desktop test left a TUI on a closed PTY consuming a CPU core. That orphan
  was stopped. The reader now uses Crossterm's alternate Unix backend, checks terminal
  hangup, and redraws only on changes (maximum 30 fps). Isolated PTY regression tests cover
  idle CPU, terminal closure, closure during an incomplete escape sequence and SIGTERM
  restoring the original terminal mode. These run in Linux CI without desktop access.

- Shared-library tests cover lossless edits, comments, multiline and trailing-newline fidelity,
  file creation, duplicate rejection, external edits, locked/read-only writes, settings and
  window-scoped editor registration with PID-start-time validation.
- TUI state/render tests cover file selection/creation, search, add/edit, save/discard/cancel,
  failed saves retaining drafts, Settings, disabled Sync and mouse navigation.
- Installer tests verify matching engine/TUI bundles before mutations, installing/removing
  both binaries, preserving edited files and reading legacy engine-only manifests.
- The live TUI smoke test passed: add/save with literal trigger text, search/edit with exact
  multiline output, Settings persistence, and expansion in another GTK window while the TUI
  remained open. The TUI exited cleanly; the user's original service and focus were restored.
- A live test caught startup registering the previous application window. Registration now
  requires a focused Omarchy terminal belonging to the editor's process ancestry; the fixed
  path passed the repeated desktop test.
- No real remote synchronization exists. The URL setting is local and Sync is disabled.

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
