# Database-backed TypeRelay development

Run docker compose up -d --build from the repository root.
App: http://localhost:3040. Captured email: http://localhost:8040.
MongoDB runs an isolated replica set. Production deployment remains separate.

## Storage version 2

MongoDB stores library metadata/grants separately from individual snippets.
Content uses version:1, type:plain_text and text. Unknown types/versions are rejected; dynamic replacements are deferred.
The SQLite database is in the configured directory, normally ~/.config/typerelay/snippets/typerelay.sqlite.
It contains libraries, individual snippets, durable operations, cursors, staged downloads and recovery drafts.
Credentials remain in the private sync/credentials.json; prefix/server settings stay in settings.yml.

YAML is parsed only for import and generated only for export. Regular server editing uses structured Rust validation.
The engine no longer supports run --file: import the file, then run with --dir.
Hidden inspect/database-edit/database-replay commands support isolated integration tests.

## Migration and rollback

Before server conversion, library/account/change/conflict/operation documents are copied into migrationbackups.
Snippet extraction and removal of legacy YAML/arrays commit transactionally per library; records-v2 prevents repeated migration.
Retained deleted libraries receive a fresh 30-day Trash deadline. Previously deleted snippets cannot be recovered.

Desktop migration backs up legacy YAML and sync state under backups/database-migration-*, imports records/outbox state transactionally, then retires original files.
Interrupted v1 operations are reconciled against content-free server receipts before retrying through v2.
The installer snapshots the stopped client's config under its private installation data directory and restores it if the upgrade fails.

Old /api/v1 clients receive 426 and cannot upload. Install the matching v0.7 engine/TUI; credentials remain usable.
Keep backups until counts, IDs and text are verified. Backups and exports are outside Trash retention.

## Trash

Both apps support snippets and libraries in Trash. Restore is refused after 30 days.
Server cleanup runs at startup and hourly using transactions, not MongoDB TTL deletion.
Local-only cleanup runs on client startup and periodically.
Synced deadlines start at server acceptance. Offline operations remain queued until authorized.
Purge removes content, related conflicts and caches while retaining content-free IDs/receipts.
Library tombstones retain authorized reader IDs solely to distribute purge events without exposing private Trash.
Offline devices apply changes on their next successful connection.

## Verification

    docker compose run --rm --no-deps server node --test --test-force-exit test/*.test.js
    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    python3 -m unittest discover -s scripts/tests

Server tests use disposable typerelay_test, typerelay_e2e and typerelay_security databases and isolated desktop directories.
Tests cover migration, offline replay, conflicts, Trash/restore/purge, expiry, access revocation, staged collisions and incremental UI updates.
Do not run the retired file-based desktop smoke scripts against the database client.

## Move protocol upgrade (v0.8)

Install the matching v0.8 engine/TUI with the server. Desktop sync protocol is now 3; no account reconnection or content migration is required.
New SQLite base_libraries/base_snippets tables retain canonical server data while pending moves project into the working tables. They are populated on the first full protocol-3 sync and are cleared alongside content on purge/revocation.
The departures table keeps content-free former-location markers to prevent local resurrection when a move destination is inaccessible.
Pending enrollment remaps both source and destination references atomically.
