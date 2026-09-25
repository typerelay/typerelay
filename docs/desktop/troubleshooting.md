---
title: "Troubleshoot TypeRelay Desktop"
description: "Troubleshoot TypeRelay Desktop panel, expansion, insertion, synchronization, and update problems on Omarchy, macOS, and Windows."
---

# Troubleshooting

## The panel does not open

- Left-click the **T** icon or open TypeRelay from the application launcher.
- Try the tray/menu-bar **Settings** action and choose a different global shortcut if the current one conflicts.
- On Omarchy, confirm the panel is running separately from the expansion service.

## Expansion does not run

- Confirm the snippet has an abbreviation and that you type the local prefix, abbreviation and Space.
- Confirm the library is active and readable, and no other active snippet uses the same abbreviation.
- Modifier shortcuts, clicks, focus changes and unsupported characters cancel a pending match.
- On Omarchy, run `systemctl --user status typerelay` and check that Espanso is not running.
- On macOS, grant Input Monitoring and test with a physical/local keyboard. Apple Screen Sharing/VNC input may bypass abbreviation detection.
- On Windows, leave the TypeRelay TUI and test a non-elevated target application.

## Insertion fails or goes to Copy

TypeRelay inserts only after restoring and rechecking the original window. A closed window, operating-system focus refusal, permission denial, protected application or unsupported clipboard state causes a safe failure. Reopen the target and retry, or use **Copy**.

On macOS, confirm Accessibility for focus restoration/insertion; Input Monitoring is also needed for continuous expansion. On Windows, TypeRelay cannot insert from a normal process into an elevated/protected application. On Remote Desktop, prior clipboard content may not be restorable.

## Sync fails

Check the server origin, network connection, selected account, plan/device limit and current library permission. The URL must be an HTTPS origin without a path, except loopback HTTP for development.

Read-only libraries cannot upload edits. After access revocation, the next successful sync removes the library from active search and expansion and preserves unsent edits in recovery. Resolve same-snippet conflicts in the web app. If the server reports protocol 6 is required, upgrade the engine, TUI and panel together.

Use **Settings → Connected devices** to confirm the device is still active. A revoked device must disconnect locally and authenticate again if access should be restored.

## Updates fail

Use **Check for updates** to see the immediate error. Verify network access to the configured updater endpoint and install only matching signed artifacts. On Omarchy, never update the engine, TUI or panel independently.

See [Operating system notes](./platforms) for platform-specific limits and [Sync and offline use](../guide/sync) for queue/recovery behavior.
