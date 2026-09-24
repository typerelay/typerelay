---
title: "TypeRelay terminal editor"
description: "Use the keyboard-first TypeRelay TUI to browse libraries, search snippets, edit content and variables, sync changes, and handle concurrent edits."
---

# Terminal editor

Run `typerelay-tui` to edit the same local SQLite libraries used by the engine and desktop panel. It works offline. Normal exit prompts before discarding a draft; closing the terminal does not save unsaved changes.

The library picker shows each library's active snippet count, such as `mysnippets (6)`. Its search field finds snippets across all active local libraries by title, abbreviation, or expansion. Results show the source library and a preview. Select a result and press Enter to edit it, or F10 to fill and copy it. Returning from the editor keeps the global query. Search inside an opened library stays limited to that library.

## Library and list controls

| Key | Action |
| --- | --- |
| F1 | Open the library picker |
| F2 | Add a snippet, or move to the next editor field |
| Enter | Open the selected library or snippet |
| `/` | Focus search in the library picker or current library |
| Space | Select the current snippet |
| Shift+Up/Down | Extend selection from its anchor |
| Ctrl+A / Ctrl+D | Select visible matches / clear selection |
| F3 | Move selected/current snippets to Trash |
| F4 | Move the current library to Trash, or add an image while editing Rich text |
| F5 | Sync now |
| F6 | Open prefix and server settings |
| F7 | Open Trash |
| F8 | Move selected snippets, or choose a destination while editing |
| M | Merge the selected library from the library picker |
| Ctrl+Q / Ctrl+C | Quit |

Trash actions use R to restore and E to empty eligible items. Destructive actions require confirmation. Trash retains recoverable content for 30 days.

D confirms a Trash action, M confirms a bulk move or library merge, and Enter/Escape cancels the confirmation. Left/Right scrolls a long preview. Narrow terminals wrap the toolbar without changing shortcuts.

## Editing

Ctrl+S saves the snippet atomically with its queued sync operation. Tab and Shift+Tab move between Title, Abbreviation and Expansion. In Code, Tab inserts a literal tab, F2 or Ctrl+Tab leaves the editor, and Enter continues the current line’s exact indentation. Ctrl+T inserts a literal tab in text/value fields.

F9 cycles Text, Code and Rich text. Text and Rich text support variables through F11. Rich text edits canonical Markdown/raw HTML. F12 toggles a styled preview; links include their destination, and images use Kitty/iTerm2/Sixel or half-block rendering with an alt-text fallback. F4 imports a local path or remote URL with alt text, title and display width. The TUI preserves code language metadata but does not select a language or provide syntax highlighting; use the web editor for those options.

Ctrl+M or F8 chooses another editable library with the same sync status. A save-and-move is one operation. Local-only and synchronized libraries cannot be mixed in an offline move because their server identities differ.

## Variables

F11 opens the variable picker/settings. Ctrl+S inserts the selected variable; F4 saves settings for an existing variable without inserting a duplicate reference. F10 opens **Fill and copy**. In the fill form, Tab/F2 changes fields, Ctrl+T inserts a tab and Ctrl+S copies the result.

## Concurrent changes

External database changes refresh lists without discarding an active draft. Saving a stale editor is rejected so it cannot overwrite a newer revision. On Windows, continuous expansion is paused while the TUI is focused; on Omarchy only the registered TUI terminal window is suppressed.

The TUI requests enhanced keyboard reporting when supported so Ctrl+M remains distinct from Enter, and restores terminal keyboard mode on exit. F8 remains the move shortcut in terminals without that protocol.
