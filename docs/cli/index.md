---
title: "TypeRelay command line"
description: "Use the TypeRelay CLI to validate, connect, synchronize, import, export, merge, trash, and manage local snippet libraries."
---

# Command line

The `typerelay` command manages local storage, synchronization and the Omarchy installation. Run `typerelay --help` for the exact commands in the installed version.

Common commands:

```fish
typerelay validate
typerelay connect --server https://app.example.com
typerelay enroll "Library name"
typerelay sync
typerelay disconnect
typerelay import yaml ./snippets.yml --name "Imported"
typerelay export "Imported" ./export.yml
typerelay merge "Recovered snippets" "My snippets"
typerelay trash
```

`connect` opens a browser unless `--no-browser` is passed. `trash` prints recoverable items; use `--restore ID` to restore one. Permanent emptying requires both `--empty` and `--yes`.

On Omarchy, `typerelay doctor`, `install`, `install --dry-run`, `uninstall` and `uninstall --dry-run` inspect or manage the user service and scoped device access. Other platforms receive the engine/CLI through their desktop package but do not expose the Omarchy installer commands.

## Imports and legacy migration

Run `typerelay import --help` to choose a format:

- `import yaml SOURCE --name NAME` imports TypeRelay YAML into a local library.
- `import bundle SOURCE --name NAME` imports a TypeRelay ZIP bundle, including images.
- `import espanso SOURCE DESTINATION` converts supported static Espanso matches to a new YAML file. Then use `import yaml` to add that file to your libraries.

`typerelay migrate` upgrades legacy YAML files: it removes the leading comma from triggers such as `,hello` and adds the local prefix setting if missing. Existing settings are preserved; changed files are backed up. It does not import YAML into the database. Preview with `typerelay migrate --file ./legacy.yml --check`, then omit `--check` to apply.

`sync` prints progress and the saved result, including conflicts or rejected operations. Import, export, connection and trash mutations also report completion.

## Local files

The default configuration roots are `~/.config/typerelay` on Omarchy, `~/Library/Application Support/TypeRelay` on macOS and `%LOCALAPPDATA%\TypeRelay` on Windows. `XDG_CONFIG_HOME` can override the root for isolated Linux tests.

`settings.yml` stores only machine-local values:

```yaml
trigger_prefix: ";"
sync_url: "https://app.example.com"
```

Libraries live under `snippets/typerelay.sqlite`; `sync/credentials.json` contains private device credentials; `panel.json` contains the shortcut and launch-at-login choice. Edit libraries through TypeRelay, not directly in SQLite. Changing `sync_url` does not move existing credentials to another server; disconnect first.

There is no separate public-API CLI. External integrations use the [HTTP API](../api/) or [MCP](../mcp/).
