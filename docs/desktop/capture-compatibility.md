# Native capture: local Linux test build

This is an opt-in development build, not a declaration of cross-platform or IME coverage. On 2026-10-02 the user prioritized installing and testing Linux on the current Hyprland/Omarchy machine; the remaining platform and IME work stays pending.

## Evidence

| Combination | Evidence | Acceptance |
| --- | --- | --- |
| Linux, Hyprland/Omarchy, selected physical keyboard, US layout | Native worker/panel release builds; live focus/session/layout metadata probe; replay, XKB and IPC tests | Physical typing in Zed, Obsidian and VS Code pending user test |
| German AltGr and US international dead keys | libxkbcommon deterministic tests | Physical layouts pending |
| Sway, X11, GNOME, KDE Plasma | Context adapters compile; GNOME/KWin helper sources included | Untested; no compatibility claim |
| macOS | Native-context implementation started | Build and device acceptance pending |
| Windows | Cross-compilation check passes | Device acceptance pending |
| IBus/Fcitx5 and native macOS/Windows IMEs | Shared commit/cancel arbitration replay tests only | Commit adapters unfinished; release blocker |
| Required app bridges | Official Zed extension API reviewed; no passive text-edit/commit hook found | Required IME coverage remains a release blocker where OS commit delivery is unavailable |

Source for the Zed API limitation: <https://github.com/zed-industries/zed/blob/main/crates/extension_api/src/extension_api.rs>. Ordinary keyboard capture does not require a bridge.

## Local test procedure

Keep the existing occurrence threshold (this machine: two), 12 non-whitespace character minimum and notification settings. In each app, manually type a fresh phrase twice, pressing Enter each time, then wait five seconds. Use different phrases in different apps to identify results. Repeat with an email and URL. Pasting is not a keyboard-capture test.

Check that two different qualifying suggestions notify without an hourly delay. Review each suggestion, verify prefix/library selection, Save/Cancel, Delete/Never suggest again and Escape. Verify ordinary snippet expansion still works. Use Settings → Suggestions → Check setup to see the selected keyboard, desktop, layout, source, blocked reason and recent verified input. Run sustained typing and focus changes to check responsiveness.

## Current implementation boundaries

The existing selected-device reader observes physical events through a bounded nonblocking queue before expansion output. There is no second keyboard grab. Unknown fields are permitted only after acknowledgment; known protected fields, excluded apps, terminals and inactive/locked sessions are skipped. Secure-field metadata is best effort. Unfinished text and event queues remain memory-only.

The observation-only path outside Hyprland does not grab or create a virtual keyboard. Its hotplug/session/helper behavior still needs acceptance. Expansion support has not been broadened. IME services detected without a verified commit source pause native capture rather than learning preedit. IME discovery is incomplete; this test build must not be used to claim IME support.

Existing users retain the prior accessibility mode until opting in. This machine's previously authorized broad mode is enabled during local installation; existing snippets and suggestion data are retained.

## Validation commands

Backend tests: `cargo test -p typerelay-client --lib --no-default-features --features desktop observation::`, the same command filtered to `capture`, and `cargo test -p typerelay-client --bin typerelay --no-default-features --features desktop omarchy::tests`.

Live metadata probe (no typing content): `cargo test -p typerelay-client --lib --no-default-features --features desktop live_context_and_layout_metadata -- --ignored --nocapture`.

Frontend regression coverage was added but execution and physical acceptance remain assigned to the user.
