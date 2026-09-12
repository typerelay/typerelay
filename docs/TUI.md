# TypeRelay TUI

Run `typerelay-tui` from a focused Hyprland terminal. The engine and TUI are installed
together. Update the engine too: older versions do not recognize editor suppression.
The TUI runs on demand and requires no extra device permissions.

Choose a `.yml`/`.yaml` file or **New file** at startup. The default directory is
`~/.config/typerelay/snippets/`; override with `typerelay-tui --dir /path/to/snippets`.
Names without an extension gain `.yml`. Existing files are never overwritten by creation.

The trigger form displays the local prefix beside an **Abbreviation** field. Enter `naf`;
saving writes `trigger: "naf"` to YAML. The engine adds the prefix from Settings. A pasted
full trigger has its current prefix removed automatically. See [configuration and migration](CONFIGURATION.md).

## Controls

| Control | Action |
|---|---|
| F1 / Files | File picker |
| F2 / Add | Add a snippet to the selected file |
| F3 / Delete | Confirm deletion of the selected saved snippet |
| Delete in the snippet list | Same as F3; in search/edit fields it edits text |
| Up / Down | Select a file or snippet |
| Enter | Open selected file or edit selected snippet |
| `/` | Search trigger and expansion in the selected file |
| Tab | Switch search/list focus or trigger/expansion fields |
| Ctrl+S / Save | Validate and save |
| Enter in expansion | Insert a newline |
| Ctrl+T in expansion | Insert a literal tab |
| Esc / Cancel | Go back; ask about unsaved changes |
| Ctrl+Q or Ctrl+C | Quit; ask about unsaved changes |
| F5 / Sync | Request an immediate sync after connecting |
| F6 / Settings | Edit the sync URL |

Mouse clicks operate toolbar buttons, lists, field focus and Save/Cancel. In the
unsaved-change dialog, **S** saves, **D** discards, and **Esc** cancels. Textarea keyboard
controls provide cursor movement, selection and undo. Search is case-insensitive.
Multiline text, tabs and trailing blank lines are preserved. Moving snippets between files is not included.

Deletion asks which abbreviation to remove. Press **D** or click **Delete** to confirm;
**Esc** or **Enter** cancels. The YAML file remains, even when its last snippet is deleted.
Read-only shared libraries block deletion. Deletions in enrolled files sync automatically.

## Safe saves

The TUI shares the engine's parser and combined-directory validation. Duplicate triggers
across files are rejected. Saves use an edit lock, external-change checks and atomic
replacement. Failures keep the draft open. If another editor changed the file, reopen it
before reapplying changes; the TUI does not silently overwrite external edits.

Lossless syntax-tree ranges locate edited fields. Comments and untouched entries remain
intact. Edited scalar values use quoted YAML; new entries may use flow mappings. Escaped
newlines do not change the actual expansion. Resolve YAML aliases manually before editing
their fields. Malformed files and symlinks are reported without being overwritten.

The running engine picks up saves through its existing watcher; no restart is needed.

## Settings and sync

`~/.config/typerelay/settings.yml` stores `sync_url` and `trigger_prefix` outside the snippet directory.
`XDG_CONFIG_HOME` is respected. Accepts absolute HTTP(S) URLs; empty clears the value.
Tab switches between URL and prefix. Prefix changes reload in the engine automatically.
Saving settings makes no network request. Connect with `typerelay connect --server URL`,
then explicitly enroll chosen files with `typerelay enroll filename.yml`. F5 requests sync;
the status line shows results and pending conflicts. See [sync setup](web/development.md).

## Editor suppression

The TUI registers its window address, PID and process start time under
`$XDG_RUNTIME_DIR/typerelay-tui/`. The engine suppresses expansion only in that window while
that same process is alive. Other application windows continue expanding. Registration is
removed on exit; stale records and reused PIDs are ignored.

The focused window must belong to the launching terminal, preventing a background launch
from suppressing another app. SSH/non-Hyprland sessions are not supported by the initial
Linux integration. Terminal mode, alternate screen, mouse capture and registration are
cleaned up on exit, errors and handled signals. SIGKILL cannot restore terminal state;
use `reset` if needed. Unsaved drafts are not crash recovery files.
Terminal disconnection exits the reader. Rendering is event-driven and capped at 30 fps;
ignored mouse-motion events do not cause redraws.

## Tests

Unit tests cover file creation/search/editing, multiline fidelity, comments, duplicates,
external edits, locked writes, settings, disconnected Sync, confirmed/filtered deletion, read-only deletion, unsaved-change decisions, rendering
and mouse navigation. Installer tests cover both binaries and legacy manifests.

`python scripts/tui-smoke.py` runs disposable desktop tests. It temporarily stops the
installed engine service, checks editor suppression and expansion in another app, then
restores the service and focus. Only run with the user's keyboard/mouse idle.
