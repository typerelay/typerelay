---
title: "Snippet suggestions"
description: "Find repeated wording locally and review it before creating a Typerelay snippet."
---

# Snippet suggestions

Open **Settings → Suggestions** and enable **Observe repeated text**. Observation and automatic notifications are off initially. This feature uses no AI model or cloud processing.

Typerelay observes newly entered text in supported, focused editable fields. After four separate occurrences of a sentence or completed typing burst, it offers a snippet suggestion. A burst completes after five seconds without typing. Short fragments, uncertain edits, paste, recognized automated insertion, and Typerelay expansions are excluded.

The tray's **Suggestions** action opens the review list. Choose:

- **Create snippet:** review and edit text, title, abbreviation, and destination library. Nothing is saved until you click **Save**. A synced or shared destination uploads the reviewed snippet through normal synchronization.
- **Dismiss:** hide the candidate for at least seven days and four additional occurrences.
- **Never suggest this again:** discard the candidate and remember only a keyed fingerprint for suppression.

Notifications contain no observed wording. They appear after a typing pause, at most once per hour, and open the local review list. Notification delivery also requires the operating system's permission.

## Settings and privacy

Change the repetition threshold (2–100), retention period (7, 30, or 90 days), and excluded applications. Enter one application identifier per line: a macOS bundle ID, Windows executable name, or Linux executable name. Exclusions affect future observation.

Disabling observation immediately stops collection and clears unfinished input. Existing candidates remain until their retention period expires or you choose **Forget learned text**. Forgetting removes candidates, counts, ignored fingerprints, and pending input; it leaves saved snippets and settings intact. Observation continues afterward if still enabled.

Observed candidates are held in a private `observations/private.sqlite3` database beneath the device's Typerelay configuration directory, separate from snippet data. No keystroke transcript, clipboard contents, window titles, or pre-existing document contents are imported. Candidate storage is limited to 5,000 entries. Candidates, counts, and ignored fingerprints are excluded from synchronization, library exports, AI requests, logs, and notifications. Local file access is restricted to the owner. This is not encryption at rest and cannot erase copies made by OS backups.

## Platform requirements

| Platform | Observation requirements |
| --- | --- |
| macOS | Accessibility and Input Monitoring; an identifiable editable field and caret. Restart Typerelay after granting missing monitoring permission. |
| Windows | A normal user desktop, UI Automation support, editable field metadata, and identifiable selection. Protected/elevated or unsupported controls are skipped. |
| Linux | AT-SPI 2, accessible text and direct key events, and an active unlocked login1/elogind session. The observer does not use Hyprland sockets or raw keyboard devices. |

Linux observation targets GNOME, KDE, Hyprland, and other AT-SPI desktops on Wayland and X11. Application/toolkit accessibility support still varies. A field without direct key provenance is skipped; Typerelay never falls back to unrestricted keyboard recording. AppImage users need the host AT-SPI library (`libatspi.so.0`). This does not broaden the existing Linux abbreviation-expansion support.

Password fields, terminals, unsupported controls, uncertain composition, and fields whose safety cannot be established are excluded on every platform. Supported composed characters retain their Unicode text. Not every input method exposes enough information for safe observation.

## Acceptance checks

Build checks are not live application certification. Test a native text editor and browser composer on macOS and Windows; repeat on GNOME/KDE Wayland and X11 and on Hyprland/Omarchy:

1. Enable observation, enter the same sentence in four separate entries, and review exactly one candidate.
2. Verify password fields, excluded apps, paste, and snippet expansion produce no candidates.
3. Try accents/composed input, corrections, field switches, screen lock/unlock, and permission revocation.
4. Create, edit, choose a local or synced library, save, and cancel. Confirm only reviewed saves create snippets.
5. Dismiss, ignore, disable, forget, and restart. Confirm stale responses do not restore forgotten text.
6. Confirm normal typing, expansion, selection, focus, and clipboard behavior remain intact.

Frontend regression tests are in `apps/desktop/test/suggestions.test.mjs`; run them with the existing desktop test command.
