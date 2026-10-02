# Maintainer signed releases

TypeRelay uses a Tauri adapter in the shared desktop release toolkit. The Windows release command imports the existing Helpmonks YubiKey signer, certificate selection, PIN retry checks, signing probe, RFC 3161 timestamping and certificate-chain verification. It does not copy the signing implementation or export the private key.

Normal GitHub builds remain unsigned test candidates. These maintainer commands require a clean `develop` checkout, pull it with `git pull --ff-only`, use frozen/locked dependencies, and never publish. Merge reviewed changes before running a release.

For a desktop version change, edit only `apps/desktop/package.json`. Tauri reads it directly, and the native panel, engine, and TUI embed its version during their normal builds. Cargo crate versions are internal metadata and do not need to change for a desktop release.

For credentialed local macOS testing without notarization, use `pnpm build:macos:local` in `apps/desktop`. It builds the app and TUI with the installed Developer ID Application identity, verifies the bundle, and creates a local DMG. Set `APPLE_SIGNING_IDENTITY` only when more than one matching identity is installed. The stable identity keeps Accessibility and Input Monitoring approvals valid across rebuilds; ad-hoc signing is unsuitable because macOS treats each build as new code.

## Windows on Omarchy

```fish
cd ~/repos/helpmonks-install-script
./scripts/desktop-release/release-windows.mjs typerelay --dry-run
./scripts/desktop-release/release-windows.mjs typerelay
./scripts/desktop-release/release-windows.mjs typerelay --publish
```

The shared helper defaults to `~/repos/helpmonks-install-script/scripts/desktop-release`; set `TYPERELAY_RELEASE_TOOLS` to override that directory. Its existing `WINDOWS_SIGNING_*` selection and provider settings continue to apply.

Requirements: Node 24+, pnpm, Rust, `cargo-xwin`, the `x86_64-pc-windows-msvc` Rust target, LLVM/Clang/LLD, NSIS (`makensis`), Wine, and the shared signing tools (`ykman`, `p11tool`, `pkcs11-tool`, `osslsigncode`, OpenSSL and expect). See the [official Tauri cross-build instructions](https://v2.tauri.app/distribute/windows-installer/).

Enter the PIN only in the local release terminal's hidden prompt. Hardware touch may be required for each signature. PIN retries and the signing probe follow the existing shared tool. Never send the PIN through chat, save it in a file, or add it to a command line.

A private per-run Unix socket connects Tauri's `bundle.windows.signCommand` hook to the shared signer. Build/hook children receive no PIN. Requests are restricted to PE artifacts in the current target/temp directories, are serialized, and must verify successfully before the hook returns. The application and installer must both have passed the hook; signing just the outer installer is insufficient.

## macOS on the Mac

```fish
cd ~/repos/helpmonks-install-script
./scripts/desktop-release/release-macos-linux.mjs typerelay --dry-run
./scripts/desktop-release/release-macos-linux.mjs typerelay
./scripts/desktop-release/release-macos-linux.mjs typerelay --publish
```

Uses the installed Developer ID Application identity and existing Apple notarization credentials. Set `APPLE_SIGNING_IDENTITY` if identity selection is ambiguous. The default target matches the Mac; `--target universal-apple-darwin` builds both architectures when their Rust targets are installed.

Existing credential names are supported: `APPLE_APP_SPECIFIC_PASSWORD` maps to Tauri's `APPLE_PASSWORD`; the Electron-style `APPLE_API_KEY` path plus `APPLE_API_KEY_ID` maps to Tauri's key path/ID variables. Already configured Tauri-style variables also work. Credentials and certificate contents are never written into generated configuration.

Tauri performs signing/notarization with hardened runtime enabled. The app bundles the matching native **TypeRelay TUI** sidecar, including a combined binary for universal builds. The command checks both panel and TUI architectures plus the resulting app with codesign, Gatekeeper and stapler. As with the existing release tooling, verification concerns the stapled application inside the DMG; no separate outer-DMG notarization claim is made. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

## Linux AppImage only

For local testing, build only the AppImage and its updater signature:

```fish
node scripts/release-panel.mjs linux --appimage
```

Add `--dry-run` to preview the build command. This skips DEB, RPM, and the legacy archive (including its engine rebuild), and does not require `rpm`. Without the flag, Linux still builds all formats. Signing credentials, clean `develop`, and version/architecture checks still apply. Builds still use a fresh Cargo output directory, so native compilation remains part of each run. The partial verification report covers only the AppImage; use the default full build for publication.

## Outputs and boundaries

The Linux build creates x86_64 AppImage, deb and rpm packages, each containing matching engine, TUI and panel binaries. Each package has its own signed updater target. A signed legacy archive remains internal to the updater feed for existing standalone installations; it is not advertised as a download. Native packages compile the engine without the legacy-install feature, excluding the embedded Python installer. deb/rpm install their service and device rules through package-managed files; AppImage starts its bundled engine directly. Missing keyboard access uses pkexec and the native input-access command. Only the compatibility archive rebuilds the engine with legacy-install enabled.

Verified artifacts and a SHA-256/source-commit report go into a fresh commit-prefixed subdirectory of `target/desktop-releases/windows`, `linux`, or `macos`. Each invocation isolates its artifacts and report from previous builds. Failed builds must not be distributed. Bunny publication uploads immutable artifacts and platform metadata first; `latest.json` changes only after all three platforms match the same SemVer and commit.

The commands are covered by non-hardware tests and dry runs. Actual Windows signing still needs the local PIN/touch flow; macOS signing/notarization must be run and verified on the Mac. The Tauri updater public key is committed; the private updater key, Bunny credentials and YubiKey PIN remain outside Git. Existing clients require one manual installation of the first updater-enabled release.

Run the native updater and Linux tray regression tests on an isolated D-Bus session, without opening a desktop window or registering a tray icon in the current desktop:

```fish
dbus-run-session -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --include-ignored
```

The tray regression exercises updates from an async worker. Linux uses a blocking worker for ksni's blocking API; calling it directly from an async worker panics before the update check and leaves the menu disabled. macOS and Windows use Tauri's native menu API. Native dialog visibility and installation still require manual checks on each OS.
