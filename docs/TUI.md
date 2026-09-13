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

The TUI requests enhanced keyboard reporting so supported terminals distinguish Ctrl+M from Enter. F8 also opens the editor destination picker on terminals without that protocol; terminal keyboard mode is restored on exit.

## Editor field layout and navigation

Title and a visible Type indicator stay above Abbreviation in both modes. The TUI has no language selector; edit language in the web app. Existing language metadata is preserved when saving in the TUI. F9 toggles Text/Code without moving fields or focus. Tab/Shift+Tab cycle Title, Abbreviation and Expansion. In code, Tab inserts a literal tab (display width four); F2 or Ctrl+Tab leaves for Title, and Shift+Tab returns to Abbreviation. F2 advances from every field; Shift+F2 goes backward. Indentation width/spaces configuration is currently web-only.

In code mode, Enter continues the current line’s leading tabs and spaces without converting them. Text-mode Enter remains a plain newline. The toolbar distinguishes F3 Move to Trash (selected/current snippet) from F7 Trash (open recovery), and F1 is labeled Libraries. Narrow terminals wrap the toolbar onto two rows.

## Terminal closure

Normal quit and terminal hangup exit successfully. Closed-terminal I/O errors are ignored during shutdown; other errors remain visible. Terminal cleanup uses fallible restoration and a disconnect-aware output writer, avoiding Ratatui’s stderr panic/double-abort when its cursor restoration fails after a PTY closes. No Omarchy crash notifications are disabled. Closing a terminal does not save an unsaved draft; normal quit retains the existing save/discard prompt.
