# TypeRelay mobile development

The mobile app lives in `apps/mobile`. It uses Mailtwine's React, TypeScript, Vite and Capacitor stack. Swift and Kotlin implement the snippet keyboards. The existing Rust client supplies SQLite storage, outbox replay, asset normalization, conflict recovery and rendering through `crates/mobile`.

The application shell follows Mailtwine's mobile interaction model: safe-area screens, a logo/profile header, fixed equal-size Add/Search bottom actions, compact touch rows, and bottom drawers for create, view/copy, and edit flows. Tapping the backdrop closes a drawer; dirty editor drawers persist their draft before reconciliation. The profile opens Settings; the Search action scrolls to and focuses the search field. The browser preview renders the same shell used by the installed iOS and Android apps.

The editor exposes the current three authoring types: Text, Code, and Rich text. Variables stay available for Text and Rich text; Text containing variables/actions is stored as the backward-compatible internal `template` type. Legacy template records reopen as Text without losing definitions. Editor selects use anchored in-app menus so browser previews and native WebViews share consistent placement.

Snippet rows support configurable gestures. Defaults are left swipe to Copy, right swipe to Edit, and far-right swipe to move the snippet to Trash. Releasing after the action threshold executes immediately: Copy writes directly to the clipboard and Edit opens the editor. Tapping the row remains the prompted template/copy flow. Device-local settings under the keyboard section can assign Copy, Edit, Delete, or no action to each gesture. Vertical movement cancels a gesture so normal list scrolling remains available. Unsaved drafts appear above the list, can be resumed or discarded from the list, and expose a Trash action next to Save inside the editor.

Saved snippets show a Trash action beside Save only when their library grants edit permission; the native store repeats permission and revision validation. Settings includes a Trash drawer. Returned items always expose Restore, while permanent deletion appears only for items whose library grants manage permission. All actions update the offline database and keyboard snapshot before synchronization.

## Build

Requirements: Node 24, pnpm, Rust, Xcode for iOS; Android SDK 36, Java 21 and NDK 28.2.13676358 for Android. Native build scripts install the required Rust targets. Set `ANDROID_HOME` and `ANDROID_NDK_HOME` when using nondefault SDK paths.

Run from the repository root, in Fish:

```fish
pnpm install --frozen-lockfile
pnpm run mobile:sync
pnpm run native:ios
pnpm run native:android
```

The server package supplies the existing editor modules, Pug partials and artwork tooling; it does not need to be running to build the mobile frontend. Native scripts compile optimized Rust by default; append `--debug` for Rust debugging. Rebuild native libraries after changing Rust code, then build the corresponding platform app. Generated libraries are deliberately excluded from Git.

```fish
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' -derivedDataPath apps/mobile/ios/App/build CODE_SIGNING_ALLOWED=NO build
env JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' apps/mobile/android/gradlew -p apps/mobile/android assembleDebug
```

Android packages include ARM64 devices and x86_64 emulators; 32-bit Android is not included.

Android debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

Create a signed Android App Bundle from the repository root with `pnpm run android:release`. On macOS it loads the existing `HELPMONKS_ANDROID_*` signing values from the sibling `helpmonks-install-script/macos_config.fish`; `TYPERELAY_ANDROID_*` values override them. The command requires NDK `28.2.13676358`, rebuilds the Rust bridge and web assets, synchronizes Capacitor, signs the release, verifies its signature, and writes `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`. Install the exact side-by-side NDK with Android Studio's SDK Manager; set `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT` only when it is outside the selected Android SDK.

For iOS device installation, open `apps/mobile/ios/App/App.xcodeproj`, select your development team for **App** and **TypeRelayKeyboard**, and provision `group.com.typerelay.mobile` for both. Bundle identifiers are `com.typerelay.mobile` and `com.typerelay.mobile.keyboard`. App Group provisioning and physical-device acceptance remain necessary before TestFlight.

## Browser testing on dbh

A dedicated `mobile` Compose service runs Vite on port 5174, following Mailtwine's mobile-container pattern. Run `dbh-run urls` for its named URL (currently `https://mobile.tr.n.lan/`). Point this hostname at dbh in your hosts file, as with the other mobile development apps.

```fish
dbh-run urls
dbh-run secrets
dbh-run compose -- build mobile
dbh-run exec -- python3 scripts/setup-mobile-dbh.py n
dbh-run compose -- up -d app mobile
```

The route setup command adds the named development Caddy mobile route, keeps a backup, validates the configuration and reloads the running development proxy. The mobile source is mounted for hot reload.

The browser runs the actual mobile UI. Its development-only web bridge calls the same Rust SQLite/outbox/rendering code in the mobile container. Preview caches are isolated by authenticated user, account and browser ID. Browser OAuth uses only the explicitly configured `TYPERELAY_MOBILE_PREVIEW_URL` callback; production rejects this callback. Native builds retain their original secure-storage and callback paths. The preview uses the browser implementation of the storage plugin, like Mailtwine; sign out after testing on a shared browser.

Edits sync to real development account data. Keyboard extensions, native secure storage and device-offline operation still require the installed app. Browser preview storage resides on dbh, so the preview itself needs network access. `pnpm --dir apps/mobile dev` without the preview environment remains a native frontend development server.

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

iOS reads the App Group snapshot without requesting Full Access. The extension never opens the app database or performs network requests. Its keys type into the destination app; an exact, unique bare abbreviation expands immediately. Partial or ambiguous abbreviations appear above the keys. The left magnifier opens an empty snippet search, while All opens an unfiltered list; both keep the keys available and show Back above single-line abbreviation — expansion previews. Direct insertion uses plain text; secure fields and apps rejecting third-party keyboards use the system keyboard. Physical-device verification of read-only App Group access is required.

Android uses an `InputMethodService`. Ordinary keys commit to the destination field, while the shared local matcher reads only bounded text before the cursor. A unique exact bare abbreviation expands immediately; a tapped suggestion replaces the typed fragment. The left magnifier opens an empty snippet search, while All opens an unfiltered list; both keep the keys available and show Back above single-line abbreviation — expansion previews. Formatted text is offered through `commitText`; destination apps may discard formatting. Images are separate explicit insertions using `commitContent`, advertised MIME types, and temporary URI grants. Unsupported destinations retain a plain-text option. Password fields have no snippet matching or expansion.

Keyboards render templates locally without embedding image binaries into HTML/RTF. Images stay in separate snapshot files, preventing large rich snippets from unnecessarily exhausting keyboard memory. The main app provides rich clipboard output and supports image files, remote-image import and refresh. New remote images require a connection; already-cached images work offline.

Desktop Enter actions remain preserved in content but block mobile insertion/copy with an explanation. Mobile expansion uses bare abbreviations without the desktop prefix. The keyboard verifies the destination context before replacing typed text; snippets with prompted fields wait until those fields are complete. Libraries are managed in the web/desktop app.

The app uses React subscriptions with Pug-rendered fragments, including the existing rich-text and template editor partials. Mutations reconcile individual snippet rows by stable IDs; they preserve filters, focus, scroll and open editor drafts. No full-page or surrounding-panel reload runs after saves or sync.

## Verification

```fish
cargo test -p typerelay-mobile -p typerelay-client --lib
pnpm run mobile:build
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

Run the supplied frontend regression checks with `pnpm --filter @typerelay/mobile test:ui` (Node 24). They verify item-only replacement, preserved surrounding state/focus, and duplicate/create/delete handling. These checks are intentionally left for the user to execute.

Frontend interaction testing belongs to the user. Native builds and unit/API tests do not establish device usability or App Store/Play approval.
