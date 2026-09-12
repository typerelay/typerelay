# TypeRelay TUI

Run typerelay-tui in a focused Hyprland terminal. Choose a library or New library.
Libraries are SQLite records, including those never enrolled for synchronization.

| Control | Action |
|---|---|
| F1 | Library picker |
| F2 | Add snippet |
| Enter | Open library / edit snippet |
| / | Search abbreviations and expansions |
| Tab | Switch fields or search/list focus |
| Ctrl+S | Save atomically to SQLite |
| Enter in expansion | Newline |
| Ctrl+T in expansion | Literal tab |
| F3 / Delete in list | Move snippet to Trash |
| F4 in library | Move library to Trash |
| F5 | Sync now |
| F6 | Prefix and server settings |
| F7 | Trash |
| R in Trash | Restore |
| E in Trash | Empty eligible Trash |
| Esc | Back/cancel |
| Ctrl+Q or Ctrl+C | Quit, prompting about drafts |

D confirms moving to Trash, R confirms restore, E confirms permanent emptying; Enter/Esc cancel.
Only creators/admins can purge shared content. Restoring a library does not restore independently trashed snippets.
Restore collisions fail without replacing the working snapshot.

The form displays the local prefix separately. Stored abbreviations exclude it.
Multiline text, Unicode, tabs and trailing blank lines are preserved.
Writes include the durable outbox operation in the same SQLite transaction.
External database changes refresh lists; active drafts remain available and stale saves are rejected.

The TUI suppresses expansion only in its own registered live terminal window.
No live keystroke tests should run without keyboard/mouse coordination.
YAML is import/export only; use CLI commands or web import.

## Selection and moves (v0.8)

- Space toggles the current row; Ctrl+A selects visible filtered matches; Ctrl+D clears selection.
- Shift+Up/Down extends the range from the selection anchor.
- F8 opens the move destination picker. F3 trashes selected snippets, or the current row when none are selected.
- M confirms a bulk move; D confirms bulk Trash; Enter/Esc cancel confirmation.
- In the editor, Ctrl+M chooses a library; Ctrl+S saves content and destination together.
- Only active editable destinations with the same sync status are offered. Local-only/synced moves are intentionally blocked.
- Moves preserve IDs, ordering and offline queues. Rejected sync operations keep unsent content in recovery and restore server state without blocking other operations.
