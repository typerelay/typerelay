# Command line

The `typerelay` command manages local storage, synchronization and the Omarchy installation. Run `typerelay --help` for the exact commands in the installed version.

Common commands:

```fish
typerelay validate
typerelay connect --server https://app.example.com
typerelay enroll "Library name"
typerelay sync
typerelay disconnect
typerelay import ./snippets.yml --name "Imported"
typerelay export "Imported" ./export.yml
typerelay trash
```

`connect` opens a browser unless `--no-browser` is passed. `trash` prints recoverable items; use `--restore ID` to restore one. Permanent emptying requires both `--empty` and `--yes`.

On Omarchy, `typerelay doctor`, `install`, `install --dry-run`, `uninstall` and `uninstall --dry-run` inspect or manage the user service and scoped device access. Other platforms receive the engine/CLI through their desktop package but do not expose the Omarchy installer commands.

## Local files

The default configuration roots are `~/.config/typerelay` on Omarchy, `~/Library/Application Support/TypeRelay` on macOS and `%LOCALAPPDATA%\TypeRelay` on Windows. `XDG_CONFIG_HOME` can override the root for isolated Linux tests.

`settings.yml` stores only machine-local values:

```yaml
trigger_prefix: ";"
sync_url: "https://app.example.com"
```

Libraries live under `snippets/typerelay.sqlite`; `sync/credentials.json` contains private device credentials; `panel.json` contains the shortcut and launch-at-login choice. Edit libraries through TypeRelay, not directly in SQLite. Changing `sync_url` does not move existing credentials to another server; disconnect first.

There is no separate public-API CLI. External integrations use the [HTTP API](../api/) or [MCP](../mcp/).
