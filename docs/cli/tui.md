---
title: "TypeRelay terminal editor"
description: "Use the keyboard-first TypeRelay TUI to browse libraries, search snippets, edit content and variables, sync changes, and handle concurrent edits."
---

# Terminal editor

Run `typerelay-tui` to edit the same local SQLite libraries used by the engine and desktop panel. It works offline. Edits are stored as local drafts as you work, including when the terminal closes unexpectedly.

On Linux, deb/rpm install the command directly. AppImage's one-time setup installs a terminal launcher that runs its bundled TUI in the current terminal. It remains available when the desktop app is closed. No source build is required; see [installation](../desktop/installation).

The library picker shows each library's active snippet count, such as `mysnippets (6)`. Its search field finds snippets across all active local libraries by title, abbreviation, or expansion. Results show the source library and a preview. Select a result and press Enter to edit it, or Ctrl+C to copy it. Copy also works while the search field has focus. Returning from the editor keeps the global query. Search inside an opened library stays limited to that library.

## Library and list controls

| Key | Action |
| --- | --- |
| Ctrl+P | Open Commands |
| F1 | Open the library picker |
| F2 | Add a snippet, or move to the next editor field |
| Enter | Open the selected library or snippet |
| `/` | Focus search in the library picker or current library |
| Space | Select the current snippet |
| Shift+Up/Down | Extend selection from its anchor |
| Ctrl+A / Ctrl+D | Select visible matches / clear selection |
| Ctrl+C | Copy the highlighted snippet, including when other rows are selected |
| F3 | Move selected/current snippets to Trash |
| F4 | Move the current library to Trash, or add an image while editing Rich text |
| F5 | Sync now |
| F6 | Open prefix and server settings |
| F7 | Open Trash |
| F8 | Move selected snippets, or choose a destination while editing |
| M | Merge the selected library from the library picker |
| Ctrl+Q | Quit |

The toolbar's Copy button provides a mouse action. Super+C or Meta+C also copies when the terminal sends that key event to TypeRelay; a terminal that handles the shortcut itself cannot forward it. F10 remains a copy shortcut for existing users. Trash actions use R to restore and E to empty eligible items. Destructive actions require confirmation. Trash retains recoverable content for 30 days.

D confirms a Trash action, M confirms a bulk move or library merge, and Enter/Escape cancels the confirmation. Left/Right scrolls a long preview. Narrow terminals wrap the toolbar without changing shortcuts.

## Editing

Ctrl+S saves the snippet locally and queues the change for sync if the library is enrolled. Tab and Shift+Tab move between Title, Abbreviation and Expansion. In Code, Tab inserts the selected indentation, F2 or Ctrl+Tab leaves the editor, and Enter continues the current line’s exact indentation. Choose **Code language** and **Code indentation** from Commands. Ctrl+T inserts a literal tab in text/value fields.

F9 cycles Text, Code and Rich text. Text and Rich text support variables through F11. Rich text edits canonical Markdown/raw HTML. F12 toggles a styled preview; links include their destination, and images use Kitty/iTerm2/Sixel or half-block rendering with an alt-text fallback. F4 imports a local path or remote URL with alt text, title and display width. The language is stored with the snippet. The TUI does not provide syntax highlighting.

Ctrl+M or F8 chooses another editable library with the same sync status. A save-and-move is one operation. Local-only and synchronized libraries cannot be mixed in an offline move because their server identities differ.

## Variables

F11 opens the variable picker/settings. Ctrl+S inserts the selected variable; F4 saves settings for an existing variable without inserting a duplicate reference. Copy opens **Fill and copy** when the snippet needs values. In the fill form, Tab/F2 changes fields, Ctrl+T inserts a tab and Ctrl+C copies the result.

## Drafts and local saves

Edits are saved to a local draft while you work. If drafts remain when you start the TUI, resolve each available draft before navigating: Enter resumes it, S saves it, N saves it as a new snippet, C copies it, E exports it, L chooses a destination, and D discards it after confirmation. Q quits and keeps unresolved drafts. A draft open in another terminal stays with that session.

Ctrl+S saves locally. Changes to enrolled libraries are queued for background sync, so a local save does not mean the server has received it. If validation or a save fails, the draft remains available. When leaving an edited snippet, choose Save, Discard, or Cancel. Q in the confirmation quits and keeps the draft.

Press Ctrl+P and type to find commands for connection, enrollment, import, export, conflict resolution, personal abbreviations, validation, and legacy migration. Espanso conversion produces YAML; import that YAML to create a library. Use the web app for billing and team administration, and the desktop app for OS permissions and autostart. `typerelay doctor` remains a CLI command.

## Concurrent changes

External database changes refresh lists without discarding an active draft. Saving a stale editor is rejected so it cannot overwrite a newer revision. Use Commands to review the saved version, export the draft, or save it as a new snippet. On Windows, continuous expansion is paused while the TUI is focused; on Omarchy only the registered TUI terminal window is suppressed.

The TUI requests enhanced keyboard reporting when supported so Ctrl+M remains distinct from Enter, and restores terminal keyboard mode on exit. F8 remains the move shortcut in terminals without that protocol.

## Rejected offline edits

Choose **Recovery** from Commands to handle edits rejected by the server. Select a record and use R to resume recoverable snippet content, C to copy the record, or E to export it as JSON. After preserving it, use D and confirm to dismiss it. Recovery is separate from unsaved local drafts.
