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
