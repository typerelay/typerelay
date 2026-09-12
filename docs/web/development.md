# TypeRelay web and sync development

Run from the repository root:

```fish
docker compose up -d --build
```

App: http://localhost:3040. Local mail inbox: http://localhost:8040.
Sign in with an email address; the development mail server captures the link. No external delivery occurs.
MongoDB is isolated, unexposed, and runs a single-node replica set for transactions.
Session secrets are generated once in the private server volume. MongoDB stores sessions; no separate cache is needed.
Dependencies use pnpm 12 and a frozen lockfile. Docker builds the Rust YAML helper and desktop executable.
Only the development stack is included. Production SMTP, HTTPS/proxy settings, replicas, backups, monitoring and deployment remain separate work.

## Verification

```fish
docker compose run --rm --no-deps server node --test --test-force-exit test/*.test.js
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
python3 -m unittest discover -s scripts/tests
```

The integration suites create and drop only `typerelay_test` and `typerelay_e2e` databases. They create disposable desktop directories in the container, exercise the actual CLI, and never access input devices. Do not point this development Compose configuration at production.

## Connect a desktop

Build/install the matching engine and TUI using the existing installer. Then:

```fish
typerelay connect --server http://localhost:3040
typerelay enroll mysnippets.yml
typerelay sync
```

Browser approval selects the account. Enrollment is explicit, one local filename at a time. Files not enrolled remain local-only.
The engine and on-demand TUI run a background worker: two-second local debounce, 30-second remote polling. F5 requests immediate sync. The CLI can run a cycle without the engine.
Use HTTPS for remote servers. HTTP is accepted only on localhost/127.0.0.1.
`typerelay disconnect` revokes the current device, archives its mapping, removes local credentials, and leaves local snippets intact.
The server origin is pinned to credentials; changing the settings URL alone never redirects authenticated requests. Disconnect/reconnect to change accounts or servers.
The TUI displays server library names, blocks edits to known read-only libraries, and shows conflict status with the web URL.

## Storage and recovery

YAML contains only `matches`, bare `trigger`, and `replace`. Prefix stays in local settings.
Under the XDG TypeRelay config directory:

- `sync/credentials.json`: private mode 0600 access/refresh tokens, server origin.
- `sync/state.json`: directory binding, library mappings, revisions, baselines, cursor, durable pending operation and conflicts.
- `sync/staged/<library-id>.json`: last downloaded candidate, retained for diagnostics.
- `sync/recovery/`: preserved conflicting, unauthorized, or concurrent local drafts.
- `sync/status`: last cycle result.
- `sync/request`: manual sync request marker.

Permission changes apply on the next successful connection. Revoked access cannot erase copies on an offline machine.
Downloaded filename collisions, duplicate abbreviations and engine limits stop activation and report an error; the active files remain valid. Resolve the local collision, then sync again.
Concurrent YAML formatting/comment changes keep the canonical server version and archive the local draft when replacement is necessary. Nonconflicting snippet edits merge by stable identity.
A refresh-token rotation interrupted before its local atomic save may require browser reconnection. No distributed filesystem can atomically commit both remote token rotation and a local credentials write.
