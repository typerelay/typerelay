---
title: "TypeRelay signed desktop releases"
description: "Prepare and verify signed TypeRelay desktop releases from the root package version."
---

# Maintainer signed releases

TypeRelay uses a Tauri adapter in the shared desktop release toolkit. The Windows release command imports the existing Helpmonks YubiKey signer, certificate selection, PIN retry checks, signing probe, RFC 3161 timestamping and certificate-chain verification. It does not copy the signing implementation or export the private key.

Normal GitHub builds remain unsigned test candidates. These maintainer commands require a clean `develop` checkout, pull it with `git pull --ff-only`, and use frozen or locked dependencies. Pass `--publish` to upload verified artifacts, or `--publish-only` to reuse verified build receipts. Merge reviewed changes before running a release.

For a desktop version change, edit only `version` in the root `package.json`. Tauri resolves `../../../package.json` from `apps/desktop/src-tauri` and reads it directly, and the native panel, engine, and TUI embed its version during their normal builds. Cargo crate versions are internal metadata and do not need to change for a desktop release. The child desktop package has no release version. Builds read root metadata without rewriting tracked desktop files.

For credentialed local macOS testing without notarization, use `pnpm build:macos:local` in `apps/desktop`. It builds the app and TUI with the installed Developer ID Application identity, verifies the bundle, and creates a local DMG. Set `APPLE_SIGNING_IDENTITY` only when more than one matching identity is installed. The stable identity keeps Accessibility and Input Monitoring approvals valid across rebuilds; ad-hoc signing is unsuitable because macOS treats each build as new code.

## Build storage

Each signed desktop build has its own directory under `target/desktop-releases/`. After a release passes verification, the build script checks completed runs and removes their Cargo compiler caches. It keeps the signed packages, verification receipts, and notarization files needed to retry publication. Failed builds and pending notarizations keep their working files. Save external verification reports outside Cargo compiler caches. If you previously placed a report inside a cache, move it before your next build.

Project build scripts also check the size of `target/` and `apps/desktop/src-tauri/target/`. When either directory exceeds 20 GiB, cleanup starts with the oldest eligible compiler caches in that directory. Active builds and the profiles used by the build that just finished keep their caches. Binaries, bundles, and other retained artifacts can keep a directory above 20 GiB. A later build may take longer while Cargo recompiles dependencies.

Both target directories are ignored by Git. People who install a packaged desktop release do not create these build directories.

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

Tauri signs the app with hardened runtime enabled. The release adapter submits it to Apple once, saves the submission ID immediately in the run directory, and polls with visible status for at most ten minutes. Individual Apple requests time out after one minute; submission and stapling time out after two minutes. A timeout preserves the signed app and recovery state instead of rebuilding or resubmitting. The app bundles the matching native **TypeRelay TUI** sidecar, including a combined binary for universal builds. The command checks both panel and TUI architectures plus the resulting app with codesign, Gatekeeper and stapler. As with the existing release tooling, verification concerns the stapled application inside the DMG; no separate outer-DMG notarization claim is made. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

If Apple remains busy or a network/packaging step fails, rerun the same shared release command. It automatically resumes an unfinished run with the same source commit, version and target. It skips dependency installation, compilation, signing and resubmission, then staples a disposable copy, verifies it and creates the DMG and signed updater archive. The submitted bundle stays immutable. No verified report is produced until all steps succeed.

For an explicitly selected run, use the absolute directory printed by the failed command (existing Apple/updater credentials must be available):

```fish
node scripts/release-panel.mjs macos --resume /absolute/path/to/target/desktop-releases/macos/RUN_DIRECTORY
```

Explicit resume infers the target from the saved state and does not pull Git. It requires the original clean `develop` commit and version; changed source or signed bundle is refused. A normal shared invocation still pulls first; if that advances the source, the older run cannot be reused for the new commit. Earlier Tauri-managed builds without `notarization.json` cannot be adopted automatically.

If submission times out before Apple returns an ID, the saved `Submitting` state blocks duplicate uploads. Inspect `xcrun notarytool history` with the same credentials and recover the matching submission ID into that run's `notarization.json` before resuming; do not guess an ID or delete the state to retry. Apple rejection preserves its ID for `notarytool log` inspection. Credentials are never stored in recovery state.

## Linux on Omarchy

Run `./scripts/desktop-release/release-linux-windows.mjs typerelay --linux` from the shared release-tooling checkout. The command builds Linux packages on the Omarchy workstation in an isolated Debian 12 environment. It downloads and verifies the base on first use, then caches the build tools under `~/.cache/typerelay/linux-release` (or `XDG_CACHE_HOME`). Omarchy needs `bubblewrap` with `--tmp-overlay`, `libarchive`, `curl`, `jq`, `util-linux`, and working unprivileged user namespaces. The Linux build checks that the engine, TUI, panel, and AI worker require glibc 2.36 or earlier before signing. The DEB supports Debian 12 or later where its package dependencies are available.

### Linux AppImage only

For local testing, build only the AppImage and its updater signature:

```fish
node scripts/release-panel.mjs linux --appimage
```

Add `--dry-run` to preview the build command. This skips DEB, RPM, and the legacy archive (including its engine rebuild), and does not require `rpm`. Without the flag, Linux still builds all formats. Signing credentials, clean `develop`, and version/architecture checks still apply. Builds still use a fresh Cargo output directory, so native compilation remains part of each run. The partial verification report covers only the AppImage; use the default full build for publication.

## Verify the installed Linux upgrade before publishing

The Omarchy release command runs the upgrade checks when you pass `--publish` or `--publish-only` for Linux. A build-only run still ends after build and signing. The publisher starts the Omarchy, Debian 12, and Fedora guests in parallel and checks the exact signed AppImage, DEB, and RPM. It saves a passing record for that fingerprint before it starts uploading. A matching passing record skips the guest checks. If a check fails, use the printed log directory to diagnose the guest, then retry with `--publish-only` to reuse the signed build.

### Prepare the QA guests once

1. Make `qemu-system-x86_64` and `qemu-img` available on the Omarchy release host. Use a QEMU version that supports Unix-socket port forwarding and `-run-with exit-with-parent=on`, and confirm your user can access `/dev/kvm`. The runner also uses OpenSSH, OpenBSD netcat, and `bsdtar` from libarchive.
2. Start from verified x86-64 cloud images for Debian 12, Fedora 45, and Arch Linux. On Arch, enable the signed Omarchy repository and install the `omarchy` package. Boot the guests with SeaBIOS and KVM, and use OpenSSH and cloud-init NoCloud. Install the packages listed below inside the guests. Include the candidate package dependencies so QA can run with guest networking restricted.
3. Remove the provisioning SSH authorized keys and host keys inside each guest and run `sudo cloud-init clean --logs`. Shut down the guests. Use `qemu-img convert -f qcow2 -O qcow2` to create standalone copies named `omarchy.qcow2`, `debian.qcow2`, and `fedora.qcow2`. Set each copy to mode `0400` and run `qemu-img check` on each. Store them in `~/.cache/typerelay/linux-upgrade-qa` or set `TYPERELAY_LINUX_QA_DIR` to the directory you use. The runner supplies a temporary user and SSH keys through cloud-init and writes each test to a disposable disk overlay.
4. Create `legacy-profile.tar.gz` in the same directory. On Omarchy, run the command below with the signed legacy 1.3.3 archive. The seed script checks the legacy executable hashes and uses a temporary profile.

```fish
bash scripts/linux-upgrade-qa/guest.sh seed /absolute/path/to/TypeRelay-Linux-legacy-1.3.3-x86_64.tar.gz /absolute/qa/directory/legacy-profile.tar.gz
```

Refresh the guest images when a release introduces new OS dependencies. Test runs use the saved guest images and fixture.

| Guest | Packages to provision |
| --- | --- |
| Omarchy | `omarchy ttf-dejavu xorg-server-xvfb xdotool tmux fuse2 acl libayatana-appindicator webkit2gtk-4.1 jq weston python-atspi` |
| Debian 12 | `linux-image-amd64 xvfb xdotool tmux dbus-x11 acl kmod udev libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 libatspi2.0-0 at-spi2-core python3-pyatspi foot libnotify-bin pkexec jq xdg-utils` |
| Fedora 45 | `xorg-x11-server-Xvfb xdotool tmux dbus-x11 acl kmod systemd-udev gtk3 webkit2gtk4.1 libayatana-appindicator-gtk3 at-spi2-core python3-pyatspi gobject-introspection foot libnotify polkit jq xdg-utils` |

Use a kernel with `uinput`. On the Arch cloud image, after installing Omarchy, ensure `/boot/vmlinuz-linux` and `/boot/initramfs-linux.img` match the installed kernel. On Debian, boot the standard `amd64` kernel and mask `systemd-networkd-wait-online.service`. The QA NIC uses MAC address `52:54:00:12:34:56` and guest address `10.0.2.15/24`. If Debian does not set the address from NoCloud, add a matching static systemd-networkd configuration in the base image.

On the Omarchy QA image, mask the stock `sshd.service` and enable a dedicated `typerelay-qa-sshd.service` under `multi-user.target`. The unit needs `Wants=cloud-init-network.service` and `After=cloud-init-network.service` so NoCloud installs the keys before SSH starts. Set `ExecStart=/usr/bin/sshd -D -e -f /etc/ssh/typerelay-qa-sshd.conf`. Use this configuration only inside the disposable QA guest.

```text
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
AllowUsers relayqa
AuthenticationMethods publickey
PasswordAuthentication no
PermitRootLogin no
UsePAM yes
Subsystem sftp internal-sftp
```

### Installed-upgrade checklist

The automatic tests cover the steps below. For a manual check, build and sign the candidate without `--publish`. From the release-tooling checkout, run `./scripts/desktop-release/record-typerelay-linux-qa.mjs` to list the verified packages and their fingerprint. Install those exact packages in isolated Linux environments over managed standalone profiles. Use Omarchy with legacy 1.3.3 for the AppImage and check the DEB and RPM on their respective distributions.

1. Launch the candidate and finish setup. Open a fresh terminal. Check `type -a typerelay typerelay-tui` and run both commands with `--version`. Both must report the candidate version when invoked by name.
2. In the TUI, edit a text snippet, open F11, and select **Tab key**. Save with Ctrl+S and reopen the snippet. Confirm `{{key:tab}}` remains in the text.
3. Confirm snippets and settings survive, the managed legacy commands are in the backup directory, and a second launch makes no duplicate backup.
4. Repeat on a clean profile and with an unmanaged command in `~/.local/bin`. The clean install must use the candidate, and the unmanaged file must remain intact with its path shown in the warning.

After a manual run passes for AppImage, DEB, and RPM, run `./scripts/desktop-release/record-typerelay-linux-qa.mjs --passed <fingerprint>` to record the result.

Publish the tested artifacts with `--publish-only`. Both publish modes require a Linux upgrade record that matches the signed artifacts. If you rebuild a package, repeat the checks and record the result for the new fingerprint.

## Outputs and boundaries

The Linux build creates x86_64 AppImage, deb and rpm packages, each containing matching engine, TUI and panel binaries. Each package has its own signed updater target. A signed legacy archive remains internal to the updater feed for existing standalone installations; it is not advertised as a download. Native packages compile the engine without the legacy-install feature, excluding the embedded Python installer. deb/rpm install their service and device rules through package-managed files; AppImage starts its bundled engine directly. Missing keyboard access uses pkexec and the native input-access command. Only the compatibility archive rebuilds the engine with legacy-install enabled.

Verified artifacts and a SHA-256/source-commit report go into a fresh commit-prefixed subdirectory of `target/desktop-releases/windows`, `linux`, or `macos`. New builds isolate their artifacts and report; macOS recovery reuses only its validated unfinished run. Failed builds must not be distributed. R2 stores immutable artifacts and versioned updater metadata. The publisher advances `latest.json` after it verifies the macOS arm64 and x64, Windows x64, and Linux x64 targets for the same version. Current Linux releases also require AppImage, DEB, and RPM metadata from the same commit as the Linux archive. macOS, Windows, and Linux can use different source commits.

The commands are covered by non-hardware tests and dry runs. Actual Windows signing still needs the local PIN/touch flow; macOS signing/notarization must be run and verified on the Mac. The Tauri updater public key is committed; the private updater key, R2 credentials and YubiKey PIN remain outside Git. Existing clients require one manual installation of the first updater-enabled release.

Run the native updater and Linux tray regression tests on an isolated D-Bus session, without opening a desktop window or registering a tray icon in the current desktop:

```fish
dbus-run-session -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --include-ignored
```

The tray regression exercises updates from an async worker. Linux uses a blocking worker for ksni's blocking API; calling it directly from an async worker panics before the update check and leaves the menu disabled. macOS and Windows use Tauri's native menu API. Native dialog visibility and installation still require manual checks on each OS.
