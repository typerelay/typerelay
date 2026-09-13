# Code snippets (v0.9)

Snippets have an optional `title` and nullable `trigger`. Empty abbreviations are stored as null; only populated active abbreviations are indexed and activated. Existing IDs and text remain unchanged.

Content envelopes are `{version:1,type:"plain_text",text}` or `{version:1,type:"code",language,text}`. Code is literal, including template delimiters. Both types retain tabs, spaces, trailing whitespace and blank lines; CRLF becomes LF. Existing 64 KiB text and library limits apply. Unknown languages remain stored and use plain highlighting. No formatter, execution or variable interpolation is added.

Desktop sync requires `X-TypeRelay-Sync-Protocol: 4`. Older clients receive 426 before accessing records. Install matching clients/server together. MongoDB migration backs up records under `code-v4` in migrationbackups and replaces the active-abbreviation index. SQLite JSON records need no rewriting; the installer backs up the stopped client before replacement.

## Editing

The web Code editor uses CodeMirror 6, served locally from a bundle generated in `/data/editor` at startup. No CDN or remote language detection. Language packages load on demand. Tab inserts a literal tab by default; choosing spaces/width changes new typing only. Shift+Tab outdents. Escape then Tab leaves the editor without dismissing its modal. Copy retains exact text. Receiving applications can still format pasted text themselves.

TUI: F9 toggles Text/Code; F2 cycles abbreviation, expansion, title and language fields. Code Tab inserts a literal tab; Ctrl+T also inserts tabs. F10 copies the editor/current snippet through the existing detached clipboard helper. Browse Left/Right scrolls the preview. Ctrl+M/F8 moves and Ctrl+S saves. No TUI syntax highlighting in this release.

## SnippetsLab JSON

`POST /api/v2/import/snippetslab/preview` accepts `{source: <parsed JSON export>}` and returns entries, warnings and a Pug fragment. `POST /api/v2/import/snippetslab` accepts `{operation_id, source, selected:[{key,trigger?}]}`. The server reparses/revalidates source, imports selected valid fragments atomically into new private libraries and returns ordinary library updates. Stable operation IDs make retries idempotent.

Folder paths become library names separated by ›. Each fragment becomes a snippet with its parent/fragment title. Abbreviations default to null. Name collisions receive numeric suffixes; existing libraries are never replaced. Notes, rich note formatting, tags, pins, smart groups and shortcuts are reported as omitted. Native bundles and continuous SnippetsLab sync are unsupported. Imports are limited to 8 MiB, 1000 fragments, 256 folders and 20 hierarchy levels, plus existing engine limits.

TypeRelay YAML now includes `title`, `type` and `language` alongside `trigger` and `replace`; existing two-field YAML remains accepted. Exports remain derived, not watched.

Source format: https://www.renfei.org/snippets-lab/manual/mac/tips-and-tricks/json-import.html
Editor licensing: CodeMirror 6 and its language packages retain their MIT license notices in installed dependencies/generated bundles.

## Verification

46 Rust checks, 13 installer/terminal checks and 32 Node/browser/server checks passed during implementation, including two desktop databases, offline code edits, protocol-3 rejection and idempotent multi-fragment import. Clippy passes with warnings denied. Live input injection was not required.

Changelog drafting is unavailable in this checkout: no `.codex/managani-changelog.json` target or hook state was supplied. No release was published.

Installed v0.9 engine/TUI and restarted the development server. All 63 active local snippet IDs, locations, abbreviations and content match the pre-upgrade fingerprint; protocol 4 sync has zero pending operations. Installer backup: `~/.local/share/typerelay/storage-upgrade-4os9jmai`. Background browser verification confirmed Rust highlighting, literal Tab and Escape/Tab focus escape; the disposable draft was discarded and preview account signed out.

Code-editor Enter now copies the current line’s exact leading tabs/spaces, up to the insertion point, on both web and TUI. Pasting and saving still do not reformat existing content.
