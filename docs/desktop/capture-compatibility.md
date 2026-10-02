# Native capture: local Linux test build

This is an opt-in development build, not a declaration of cross-platform or IME coverage. On 2026-10-02 the user prioritized installing and testing Linux on the current Hyprland/Omarchy machine; the remaining platform and IME work stays pending.

## Evidence

| Combination | Evidence | Acceptance |
| --- | --- | --- |
| Linux, Hyprland/Omarchy, selected physical keyboard, US layout | Native worker/panel release builds; live focus/session/layout metadata probe; replay, XKB and IPC tests | User confirmed Zed and Obsidian work on 2026-10-02; VS Code acceptance for this build remains pending |
| German AltGr and US international dead keys | libxkbcommon deterministic tests | Physical layouts pending |
| Sway, X11, GNOME, KDE Plasma | Context adapters compile; GNOME/KWin helper sources included | Untested; no compatibility claim |
| macOS | Native-context implementation started | Build and device acceptance pending |
| Windows | Cross-compilation check passes | Device acceptance pending |
| IBus/Fcitx5 and native macOS/Windows IMEs | Shared commit/cancel arbitration replay tests only | Commit adapters unfinished; release blocker |
| Required app bridges | Official Zed extension API reviewed; no passive text-edit/commit hook found | Required IME coverage remains a release blocker where OS commit delivery is unavailable |

Source for the Zed API limitation: <https://github.com/zed-industries/zed/blob/main/crates/extension_api/src/extension_api.rs>. Ordinary keyboard capture does not require a bridge.

User confirmation covers the reported Zed/Obsidian result on this machine; specific email/URL, notification timing, review-flow and sustained-use checks were not individually reported. Windows and macOS testing is deferred by the user.

## Live acceptance and prior capture regression

The user's two different paragraphs/signatures containing “I wish you all the best.” pass deterministic passage and physical-US-key replay tests, but the initial live run retained only one closing. The first diagnostic retry reported shortcut resets with zero expired input, transport errors or context errors. Additional metadata-only counters now distinguish editing/navigation shortcuts, active modifier state and repaired key releases.

The selected-device owner's repaired releases and releases consumed while waiting for expansion now also reach the observation translator. Previously only the forwarding side received those releases. This mismatch is fixed and unit-tested; it is not yet proven to be the cause of the reported missed closing. End-to-end acceptance of that live example remains pending. Do not treat replay success as proof that the real failure is resolved.

On 2026-10-02, after build `47eabdc`, the user confirmed successful live discovery of “Hope this helps for today.” inside two different paragraphs with different signatures. This verifies the intended repeated-passage behavior on this Linux machine. The earlier exact “I wish you all the best.” case and the causal role of the key-release repair were not separately verified; broader edit-provider and platform limitations below remain.

## Repeated-passage engine

The detector now retains a 4,096-character editable window across pauses and Enter. It mines Unicode word-boundary passages of 12 non-whitespace characters to 1,000 characters, including multiple sentences. Email addresses and URLs are atomic. Matching normalizes Unicode NFC and whitespace; words, case and punctuation are not fuzzily matched.

Discovery stores keyed fingerprints and opaque context/range/revision receipts in the existing private database. Only qualifying suggestion text is materialized. Revisions retract changed ranges; repeated analysis cannot create another occurrence. The longest overlapping qualified passage is preferred; shorter passages need independent uses. A growing card retains its ID and notification state. Deletion and ignoring suppress fragments from the rejected occurrences.

The private schema migrates existing exact counts and qualifying cards without manufacturing historical substring matches. Discovery is capped at 250,000 fingerprints, separately from 5,000 cards. Expired patterns are removed before old single-occurrence patterns; Check setup reports capacity pressure. Mining advances in 256-span transactions on the observation worker's database connection. Capture heartbeat publication runs independently of indexing. No raw text/event queues are written to disk.

## Local test procedure

Keep the existing occurrence threshold (this machine: two). Write two different realistic messages in allowed apps, each containing the same closing, such as “I hope this help. Just reply and I'll help.” Separate them with unrelated writing; use different openings and endings. The complete repeated closing should appear once, without requiring consecutive identical lines. Repeat with embedded emails and URLs.

Pause mid-closing, continue across sentences or lines, and correct an end-of-buffer typo with Backspace before and after a pause. Verify the full corrected passage and counts. Verify a growing suggestion updates its existing card without another notification. Then check two independent qualifying passages notify without an hourly delay, review/save with prefix and library selection, Cancel, Delete/Never suggest again, Escape, ordinary snippet expansion and sustained responsiveness.

Frontend regression execution and physical acceptance remain assigned to the user. `typerelay-panel --capture-status` exposes metadata-only diagnostics, including discovery capacity, without returning captured text.

## Current implementation boundaries

The existing selected-device reader observes physical events through a bounded nonblocking queue before expansion output. There is no second keyboard grab. Unknown fields are permitted only after acknowledgment; known protected fields, excluded apps, terminals and inactive/locked sessions are skipped. Secure-field metadata is best effort. Unfinished text and event queues remain memory-only. Backspace after idle analysis is covered by a regression test. Verified replacement ranges are supported by the shared contract, but native keyboard-only capture cannot infer arbitrary selections or word-deletion ranges. Those app edit-provider integrations remain release blockers for complete correction coverage; Zed, Obsidian and VS Code selection/replacement behavior has not been claimed as supported.

The observation-only path outside Hyprland does not grab or create a virtual keyboard. Its hotplug/session/helper behavior still needs acceptance. Expansion support has not been broadened. IME services detected without a verified commit source pause native capture rather than learning preedit. IME discovery is incomplete; this test build must not be used to claim IME support.

Existing users retain the prior accessibility mode until opting in. This machine's previously authorized broad mode is enabled during local installation; existing snippets and suggestion data are retained.

## Validation commands

Backend tests: `cargo test -p typerelay-client --lib --no-default-features --features desktop observation::`, the same command filtered to `capture`, and `cargo test -p typerelay-client --bin typerelay --no-default-features --features desktop omarchy::tests`.

Live metadata probe (no typing content): `cargo test -p typerelay-client --lib --no-default-features --features desktop live_context_and_layout_metadata -- --ignored --nocapture`.

Frontend regression coverage was added but execution and physical acceptance remain assigned to the user.
