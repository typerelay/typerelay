# v0.7.0 database and Trash delivery

Implemented per-snippet MongoDB storage, SQLite desktop storage, protocol v2 and 30-day Trash.
YAML is import/export only; the engine reads validated SQLite snapshots.

Verified 76 checks: 39 Rust, 13 Python installer/terminal, 24 server/end-to-end.
Tests include local/server migration, offline retries, structured two-device edits, conflicts, Trash/restore/purge, expiry, role/privacy checks, export isolation and rollback.
Clippy passes with warnings denied. Docker build passed.
Background browser checks confirmed moving a disposable snippet to Trash and restoring it without a page reload.

Live migration preserved all 62 local snippets and all 63 server snippets across two libraries. Content hashes and server snippet IDs match before/after.
Engine/TUI v0.7.0 installed; engine active, zero restarts. Sync completed with zero pending operations/conflicts.
No desktop keystrokes were injected.

Backups retained:
- Client originals: ~/.config/typerelay/backups/database-migration-9b7b3a04-2b74-4fed-8904-4450bd0477f8
- Pre-upgrade client: ~/.local/share/typerelay/storage-upgrade-p4h7w3f_
- Final installer backup: ~/.local/share/typerelay/storage-upgrade-h4s8479x
- Server originals: migrationbackups collection, records-v2 keys.

TypeRelay still has no configured Managani changelog target; no external release draft was created.

---

# v0.6.0 verification

Implemented the web app and two-way sync in the existing monorepo.
Development preview: http://localhost:3040; captured sign-in/invitation emails: http://localhost:8040.

Verified 62 checks: 36 Rust, 12 installer/terminal Python, and 14 server/end-to-end checks.
The server suites use two isolated databases, multiple test accounts, and several disposable desktop configuration directories.
The actual desktop browser PKCE callback, token persistence, enrollment, offline pending replay, two-device merge, conflict recovery, read-only restore, revocation manifests and activation collisions pass.
Browser DOM tests preserve panel identity, unrelated snippet nodes, active search focus and filter text during a snippet update.
Manual background browser verification covered sign-in, YAML preview/import and multiline rendering.
Clippy passes with warnings denied.
The existing installer validates both binaries, preserves configuration, and installs v0.6.0; local engine service is active. Snippet/settings checksums match before/after installation.
No live desktop keystrokes were injected. Production deployment is outside this delivery.

Changelog workflow checked: this repository has no .codex/managani-changelog.json or configured TypeRelay target, so no external changelog draft was created.
