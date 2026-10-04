---
title: "Snippet suggestions"
description: "Find repeated wording locally and review it before creating a Typerelay snippet."
---

# Snippet suggestions

Open **Settings → Suggestions** and enable **Observe repeated text**. Observation and automatic notifications are off initially. This feature uses no AI model or cloud processing.

The **Check setup** section checks observation settings, macOS permissions, notification settings, and whether typing was received from an application in the last minute. It appears automatically when opening Suggestions. Type a few words in your editor, return to Suggestions, and click **Check setup**. A successful typing check names that app; it does not claim that every field in every app is supported. This check retains only the last app identifier and time in memory, never a separate typing transcript.

Use **Send test notification** to verify system delivery without waiting for repeated text. If it does not appear, the app explains notification permissions and Focus/Do Not Disturb. Missing macOS permissions have buttons to the corresponding System Settings pages. **Help with your app** includes VS Code setup and platform-specific troubleshooting.

Typerelay observes newly entered text in supported, focused editable fields. After four separate occurrences by default, it offers a snippet suggestion. Single words, email addresses, URLs, and phrases qualify when they contain at least 12 characters excluding spaces; there is no minimum word count. A burst completes after five seconds without typing. Short fragments, uncertain edits, bulk paste, recognized automated insertion, and existing snippets are excluded.

Click a suggestion notification, the tray’s **Suggestions** action, or **Review suggestions** in Settings to open the dedicated suggestions panel. It uses the settings styling with an extra 1rem of horizontal padding. Press **Escape** to close it. Each row shows the captured text and **Store as snippet**, with smaller underlined **Never suggest again** and **Delete** actions below. Choose:

- **Store as snippet:** replace the list with an editable form. Abbreviation and optional title share the first row, followed by text and the destination library. The device’s configured prefix appears before the abbreviation input; enter only the abbreviation itself. **Cancel** returns to the list; **Save** creates the snippet and returns to the list. A synced or shared destination uploads the reviewed snippet through normal synchronization.
- **Delete:** remove the captured candidate and its counts. Repeated text can be learned again later.
- **Never suggest again:** discard the candidate and remember only a keyed fingerprint for suppression.

Notifications contain no observed wording. They appear after a typing pause, including after you switch away from the editor, with no hourly limit, and open the local review list. Each newly eligible candidate is notified once; additional occurrences update its count without repeatedly notifying for the same pending candidate. Linux notifications request a 10-second on-screen duration and support opening the panel by clicking the notification body. Notification delivery also requires the operating system’s permission; Windows and macOS control banner duration through their own notification policies.

## Settings and privacy

Change the repetition threshold (2–100), retention period (7, 30, or 90 days), and excluded applications. **Choose apps…** opens the native file picker; choose one or more installed applications. Each row shows the app name and its capture identifier. **Remove** changes only that row. Additions and removals take effect after **Save settings**, and affect future observation. Existing learned candidates are not deleted. Canceling the picker changes nothing.

Typerelay adds removable defaults once for new and existing installations, including apps not currently installed. Custom exclusions are preserved; removed defaults stay removed after restarting or forgetting learned text. The defaults are:

| Platform | Password apps |
| --- | --- |
| macOS | 1Password (including 7), Bitwarden, Proton Pass, NordPass, Keeper, KeePassXC (current and legacy bundle IDs), Apple Passwords |
| Windows | 1Password, Bitwarden, Proton Pass, NordPass, Keeper, KeePass, KeePassXC |
| Linux | 1Password, Bitwarden, Proton Pass, NordPass, Keeper, KeePassXC |

The picker resolves macOS `.app` bundles to bundle IDs, Windows `.exe` files and `.lnk` shortcuts to executable filenames, and Linux executables or resolvable `.desktop` files to the actual executable basename (following symlinks). Names and identifiers stay in the device-private settings database. Previous manually entered identifiers remain valid and display verbatim when their name is unknown. Matching is exact and case-insensitive, not a substring match.

Linux scripts, AppImages, and generic Flatpak/Snap/interpreter launchers cannot reliably identify the process that eventually owns the window; the picker rejects these and asks for the installed app binary. KeePass running through the shared Mono interpreter is not a Linux default because excluding `mono` would affect unrelated apps. Windows shortcuts to launchers such as `Update.exe` are likewise rejected. Typerelay never runs selected files or evaluates launcher commands. If any selected file cannot be resolved, the selection is not added; choose valid applications again.

Browser extensions and password-manager websites share their browser's process identity and cannot be excluded separately. Excluding the browser excludes the whole browser. Password fields, terminals, and unsupported fields remain protected even after a password-manager exclusion is removed. **Check setup** identifies a recently focused excluded app separately from input-worker failures.

Catalog identity references: [1Password package](https://github.com/Homebrew/homebrew-cask/blob/master/Casks/1/1password.rb), [Bitwarden build configuration](https://github.com/bitwarden/clients/blob/main/apps/desktop/electron-builder.json), [Proton Pass packaging](https://github.com/ProtonMail/WebClients/blob/main/applications/pass-desktop/forge.config.ts), [NordPass package](https://github.com/Homebrew/homebrew-cask/blob/master/Casks/n/nordpass.rb), [Keeper package](https://github.com/Homebrew/homebrew-cask/blob/master/Casks/k/keeper-password-manager.rb), [Keeper deployment](https://docs.keeper.io/enterprise-guide/deploying-keeper-to-end-users/desktop-application), [KeePass downloads](https://keepass.info/download.html), [KeePassXC package](https://github.com/Homebrew/homebrew-cask/blob/master/Casks/k/keepassxc.rb), and [Apple Passwords](https://support.apple.com/guide/passwords/welcome/mac).

Disabling observation immediately stops collection and clears unfinished input. Existing candidates remain until their retention period expires or you choose **Forget learned text**. Forgetting removes candidates, counts, ignored fingerprints, and pending input; it leaves saved snippets and settings intact. Observation continues afterward if still enabled.

Observed candidates are held in a private `observations/private.sqlite3` database beneath the device's Typerelay configuration directory, separate from snippet data. No keystroke transcript, clipboard contents, window titles, or pre-existing document contents are imported. Candidate storage is limited to 5,000 entries. Candidates, counts, and ignored fingerprints are excluded from synchronization, library exports, AI requests, logs, and notifications. Local file access is restricted to the owner. This is not encryption at rest and cannot erase copies made by OS backups.

## Platform requirements

| Platform | Observation requirements |
| --- | --- |
| macOS | Accessibility and Input Monitoring; an identifiable editable field and caret. Restart Typerelay after granting missing monitoring permission. |
| Windows | A normal user desktop and UI Automation editable field metadata. Standard Edit controls and accessible document editors are supported; protected/elevated controls are skipped. |
| Linux | AT-SPI 2 committed text-change events from an editable field, and an active unlocked login1/elogind session. The observer does not use Hyprland sockets or raw keyboard devices. |

Linux observes newly committed text changes in the focused accessible editor. Keyboard events are optional: Electron on Wayland can expose text changes without key events. An autocomplete popup can temporarily hold accessibility focus without clearing the text being collected from its editor; changing to another field or application still clears unfinished input. When an editor replaces its accessibility text, Typerelay reduces the paired delete/insert events to the changed characters. The old event payload is held briefly in memory and is never learned as a candidate. Duplicate refreshes are ignored. Large insertions and rewrites are discarded; small programmatic edits that look identical to typing cannot always be distinguished by the application interface.

For VS Code, set **Editor: Accessibility Support** to **On** (`editor.accessibilitySupport: "on"`). An explicit **Off** setting hides the editor from assistive applications, including Typerelay. This is a VS Code setting, separate from enabling observation in Typerelay. No document text is imported when enabling it.

Linux observation targets GNOME, KDE, Hyprland, and other AT-SPI desktops on Wayland and X11. Application/toolkit accessibility support still varies. Fields without accessible edit events are skipped; Typerelay never falls back to unrestricted keyboard recording. AppImage users need the host AT-SPI library (`libatspi.so.0`). This does not broaden the existing Linux abbreviation-expansion support.

Password fields, terminals, unsupported controls, uncertain composition, and fields whose safety cannot be established are excluded on every platform. Supported composed characters retain their Unicode text. Not every input method exposes enough information for safe observation.

## Acceptance checks

Build checks are not live application certification. Test a native text editor and browser composer on macOS and Windows; repeat on GNOME/KDE Wayland and X11 and on Hyprland/Omarchy:

1. Enable observation and notifications, enter the same sentence in four separate entries (or lower the threshold to two), and review exactly one candidate. End each occurrence with Enter or a five-second pause. Include capitals and punctuation, and repeat in VS Code with accessibility support enabled. Switch to Settings immediately after the final Enter and confirm a notification still arrives after five seconds.
2. Verify password fields, excluded apps, paste, and snippet expansion produce no candidates.
3. Try accents/composed input, corrections, field switches, screen lock/unlock, and permission revocation.
4. Create, edit, choose a local or synced library, save, and cancel. Confirm only reviewed saves create snippets.
5. Delete, ignore, disable, forget, and restart. Confirm stale responses do not restore forgotten text.
6. Confirm normal typing, expansion, selection, focus, and clipboard behavior remain intact.

Frontend regression tests are in `apps/desktop/test/suggestions.test.mjs`; run them with the existing desktop test command.
