# TypeRelay mobile development

The mobile app lives in `apps/mobile` on `codex/mobile-app`. It uses Mailtwine's React, TypeScript, Vite and Capacitor stack. Swift and Kotlin implement the snippet keyboards. The existing Rust client supplies SQLite storage, outbox replay, asset normalization, conflict recovery and rendering through `crates/mobile`.

## Build

Requirements: Node 24, pnpm, Rust, Xcode for iOS; Android SDK 36, Java 21 and NDK 28.2.13676358 for Android. Native build scripts install the required Rust targets. Set `ANDROID_HOME` and `ANDROID_NDK_HOME` when using nondefault SDK paths.

Run from the repository root, in Fish:

```fish
pnpm --dir apps/server install --frozen-lockfile
pnpm --dir apps/mobile install --frozen-lockfile
pnpm --dir apps/mobile cap:sync
pnpm --dir apps/mobile native:ios
pnpm --dir apps/mobile native:android
```

The server package supplies the existing editor modules, Pug partials and artwork tooling; it does not need to be running to build the mobile frontend. Native scripts compile optimized Rust by default; append `--debug` for Rust debugging. Rebuild native libraries after changing Rust code, then build the corresponding platform app. Generated libraries are deliberately excluded from Git.

```fish
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' -derivedDataPath apps/mobile/ios/App/build CODE_SIGNING_ALLOWED=NO build
env JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' apps/mobile/android/gradlew -p apps/mobile/android assembleDebug
```

Android packages include ARM64 devices and x86_64 emulators; 32-bit Android is not included.

Android debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

For iOS device installation, open `apps/mobile/ios/App/App.xcodeproj`, select your development team for **App** and **TypeRelayKeyboard**, and provision `group.com.typerelay.mobile` for both. Bundle identifiers are `com.typerelay.mobile` and `com.typerelay.mobile.keyboard`. App Group provisioning and physical-device acceptance remain necessary before TestFlight.

`pnpm --dir apps/mobile dev` serves the web bundle, but the database and keyboard bridge require a native app; there is no browser database substitute.

On NadaMini, backend development uses `dbh-run`. Run `dbh-run urls` for the current named endpoints. Mobile login requires HTTPS, including custom development servers with trusted certificates. Do not use local Docker.

## Data and authentication

- Browser authorization: public client `typerelay-mobile`, S256 PKCE, state verification, exact callback `com.typerelay.mobile://oauth/callback`. Both warm and cold callbacks are handled.
- Device metadata: `client_type=mobile`; `os=ios|android`. Authorization codes and mobile refresh tokens are bound to the mobile client. Existing desktop callbacks and legacy desktop refresh requests remain supported.
- Credentials stay in Capacitor secure storage. Rust receives only an access token during synchronization; it never writes mobile refresh credentials into SQLite, the filesystem, or keyboard snapshots.
- SQLite stores local edits and outbox operations transactionally. Mobile save receipts make native callback retries idempotent, including creates. Existing sync protocol 6 handles server retries and conflicts.
- Unsaved editor drafts persist locally. A changed snippet cannot silently overwrite a newer local revision; **Save as new** preserves both versions. Recovered edits can be restored into an editable library.
- Account/server binding prevents cached libraries being mixed with another sign-in. Signing out explicitly removes local drafts, outbox, snapshots and cached images. Reconnecting the same account retains them.
- Sync runs while the app is active, on reconnect/resume, after saves, and on explicit Sync. Background execution is not promised.

## Keyboards

The containing app publishes an atomic snapshot. Its generation is derived from content rather than SQLite connection-local counters. Keyboard insertion checks the generation again, rejecting stale selections. Revoked libraries are removed on the next successful sync; a rejected refresh token suspends the keyboard snapshot. Offline devices cannot learn about server revocation immediately.

iOS reads the App Group snapshot without requesting Full Access. The extension never opens the app database or performs network requests. Search and template fields have a compact built-in character pad. Direct insertion uses plain text; secure fields and apps rejecting third-party keyboards use the system keyboard. Physical-device verification of read-only App Group access is required.

Android uses an `InputMethodService`. Formatted text is offered through `commitText`; destination apps may discard formatting. Images are separate explicit insertions using `commitContent`, advertised MIME types, and temporary URI grants. Unsupported destinations retain a plain-text option. Password fields are excluded.

Keyboards render templates locally without embedding image binaries into HTML/RTF. Images stay in separate snapshot files, preventing large rich snippets from unnecessarily exhausting keyboard memory. The main app provides rich clipboard output and supports image files, remote-image import and refresh. New remote images require a connection; already-cached images work offline.

Desktop Enter actions remain preserved in content but block mobile insertion/copy with an explanation. The keyboard is a snippet picker, not a full typing keyboard or abbreviation expander. Libraries are managed in the web/desktop app.

The app uses React subscriptions with Pug-rendered fragments, including the existing rich-text and template editor partials. Mutations reconcile individual snippet rows by stable IDs; they preserve filters, focus, scroll and open editor drafts. No full-page or surrounding-panel reload runs after saves or sync.

## Verification

```fish
cargo test -p typerelay-mobile -p typerelay-client --lib
pnpm --dir apps/mobile build
dbh-run compose -- exec -e APP_URL=http://localhost:3040 -e API_RATE_LIMIT_ENABLED=false app node --test --test-force-exit --test-name-pattern 'mobile|desktop PKCE|device enrollment|PKCE account binding' test/sync.test.js
```

The new native tests cover durable offline edits, acknowledgement replay, transactional rollback, stale selections, account isolation, suspended/revoked snapshots, assets, template validation and queued conflict resolution. OAuth tests cover callback restrictions, PKCE, client isolation, metadata, code replay and refresh rotation.

The broader server suite is not currently green. Baseline verification at `df7a8a1`, using an isolated copy of the unmodified server sources, reproduced five failures in scheduler job-count and existing sync ordering/collision expectations. The initial full-suite run also reported web AJAX and import-order failures. These are outside the mobile implementation; do not interpret the focused mobile checks as a full-suite pass.

### User device/UI checklist

- Sign in with the app both closed and running; cancel/retry; reconnect the same account. Verify account switching requires sign-out.
- Enable each keyboard and switch between TypeRelay and the normal keyboard. On iOS, keep Full Access off.
- Search and filter libraries; verify read-only libraries cannot be edited.
- Create/edit plain text, code, templates and rich text. Close/relaunch offline; verify drafts, pending saves and cached images survive.
- Reconnect after edits from two devices; resolve conflicts and restore recovered changes. Verify unrelated rows, filters and scroll stay unchanged.
- Insert Unicode, multiline text, prompted values and dates. Verify desktop Enter actions explain their limitation.
- Try Notes, mail, messaging and browser fields. On Android, test formatted text, supported images and refusal/fallback. On iOS, test secure fields and an app that blocks custom keyboards.
- Revoke access or sign out; verify snapshots and images disappear when the device learns the change.

Run the supplied frontend regression checks with `pnpm --dir apps/mobile test:ui` (Node 24). They verify item-only replacement, preserved surrounding state/focus, and duplicate/create/delete handling. These checks were intentionally left for the user to execute.

Frontend interaction testing belongs to the user. Native builds and unit/API tests do not establish device usability or App Store/Play approval.
