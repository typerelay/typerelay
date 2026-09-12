# TypeRelay

TypeRelay provides text expansion, offline snippet editing and team synchronization.
The current keyboard adapter supports Omarchy/Hyprland on Linux with a US layout.

Use typerelay-tui to create libraries, edit snippets and manage Trash. The web app adds account/team management, sharing and conflict resolution.
Type a prefix plus abbreviation, then Space to expand; the default prefix is a comma.

## Storage and setup

- Server: MongoDB library documents and individual snippet documents.
- Desktop: SQLite at ~/.config/typerelay/snippets/typerelay.sqlite.
- YAML: import/export only. Editing an exported file does not change stored snippets.
- Settings: ~/.config/typerelay/settings.yml; the prefix is local to each machine.

See [installation](INSTALLATION.md), [TUI](TUI.md) and [storage/migration](web/development.md).

Development app: http://localhost:3040. Mailpit: http://localhost:8040.

    typerelay connect --server http://localhost:3040
    typerelay import /path/to/snippets.yml --name Personal
    typerelay enroll Personal
    typerelay sync
    typerelay export Personal /path/to/export.yml

Only explicitly enrolled libraries upload. Assigned shared libraries download automatically.
The engine reads validated database snapshots. Networking runs in a separate worker.

## Expansion and recovery

Static text supports Unicode, multiline paragraphs, tabs and trailing newlines.
Dynamic templates, timestamp evaluation and field prompts are deferred.
Abbreviations use lowercase ASCII letters, digits and hyphens, 1–63 characters, unique across active libraries.

Trash supports restore for 30 days. Empty Trash requires confirmation; only creators/admins can purge shared content.
Local-only expiry runs in the client; synced expiry runs on the server. Offline devices apply changes on reconnection.
Exports and migration backups are outside Trash retention.
