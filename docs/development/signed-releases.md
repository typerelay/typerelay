# Maintainer signed releases

TypeRelay uses a Tauri adapter in the shared desktop release toolkit. The Windows release command imports the existing Helpmonks YubiKey signer, certificate selection, PIN retry checks, signing probe, RFC 3161 timestamping and certificate-chain verification. It does not copy the signing implementation or export the private key.

Normal GitHub builds remain unsigned test candidates. These maintainer commands require a clean `develop` checkout, pull it with `git pull --ff-only`, use frozen/locked dependencies, and never publish. Merge reviewed changes before running a release.

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

Tauri performs signing/notarization with hardened runtime enabled. The command checks the resulting app with codesign, Gatekeeper, stapler and lipo. As with the existing release tooling, verification concerns the stapled application inside the DMG; no separate outer-DMG notarization claim is made. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

## Outputs and boundaries

The Omarchy command also builds Linux x86_64 AppImage, DEB, and a signed tar containing matching engine, TUI and panel binaries. Managed Omarchy installations update all three binaries together and roll back on failure.

Verified artifacts and a SHA-256/source-commit report go into a fresh commit-prefixed subdirectory of `target/desktop-releases/windows`, `linux`, or `macos`. Each invocation isolates its artifacts and report from previous builds. Failed builds must not be distributed. Bunny publication uploads immutable artifacts and platform metadata first; `latest.json` changes only after all three platforms match the same SemVer and commit.

The commands are covered by non-hardware tests and dry runs. Actual Windows signing still needs the local PIN/touch flow; macOS signing/notarization must be run and verified on the Mac. The Tauri updater public key is committed; the private updater key, Bunny credentials and YubiKey PIN remain outside Git. Existing clients require one manual installation of the first updater-enabled release.
