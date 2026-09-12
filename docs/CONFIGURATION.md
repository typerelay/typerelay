# Snippets and local settings

Since 0.5.0, snippet files store **bare abbreviations**:

```yaml
matches:
  - trigger: "naf"
    replace: |-
      Sincerely,
      Nitai
      Ceo & Founder
```

`~/.config/typerelay/settings.yml` stores the local prefix separately:

```yaml
trigger_prefix: ","
sync_url: ""
```

The engine combines these into `,naf`, followed by Space. Changing the setting to `;`
changes activation to `;naf` without rewriting or resynchronizing any snippets. Settings
reload within 500 ms; changing the prefix cancels an unfinished trigger. Invalid settings
keep the previous working prefix. Missing prefix settings default to comma.

The current US-keyboard adapter accepts one unshifted punctuation character:
`,` `;` `.` `/` `'` `[` `]` `\` `` ` `` `=`. Empty, multi-character, shifted and alphanumeric
prefixes are rejected. Abbreviations remain 1–63 lowercase ASCII letters, digits or hyphens.

The TUI's Settings screen edits both the sync URL and prefix; Tab switches fields. The
snippet form displays the prefix separately and saves only the abbreviation. The prefix
is a local preference; future sync will share abbreviations and expansions, not this setting.
No remote sync is implemented yet.

## Upgrade and migration

The installer previews compatibility, stops the old engine, upgrades both binaries, and
migrates active snippets before starting the new engine. If startup fails, it restores the
previous binaries, installer manifest and migrated data. Existing device rules are reused
without administrator changes when their content and current access already match.

Migration removes **exactly one leading comma** from legacy triggers. Existing bare
abbreviations remain unchanged. Comments, expansions and other settings are preserved.
All candidate files are validated together; collisions or malformed input stop migration
before snippet/settings writes. Backups and a recovery manifest are saved under
`~/.config/typerelay/backups/prefix-migration-*/`. Re-running migration is a no-op once done.

For manual use with a 0.5.0 binary, save/close TUIs and stop the engine before applying:

```fish
typerelay migrate --check
systemctl --user stop typerelay
typerelay migrate
systemctl --user start typerelay
```

`--dir`, `--file`, and `--settings` can select explicit paths. `--json` returns a machine
readable report. Archived Espanso imports and old POC files outside the active directory
are left alone; migrate them explicitly if you want to use them with the new engine.
