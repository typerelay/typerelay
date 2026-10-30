---
title: "TypeRelay sync and offline use"
description: "Connect TypeRelay Desktop, enroll local libraries, synchronize offline changes, resolve conflicts, handle permission changes, and disconnect safely."
---

# Sync and offline use

TypeRelay is local-first. The desktop reads and writes SQLite; the server is used to synchronize enrolled libraries, distribute accessible server libraries and coordinate team permissions. Exported YAML is a portable copy, not live storage.

## What synchronizes

- Library names, snippets, ordering, content type, code language and template definitions.
- Sharing grants and read/edit/manage permissions.
- Trash state, restore deadlines, moves and conflict resolutions.
- Template defaults and definitions, but never answers entered while filling a template.

The trigger prefix, panel shortcut and launch-at-login setting are local to each machine.

Downloaded libraries receive an available local name when their server name is already in use. Existing local libraries are retained.

## Connect a machine

In the desktop panel, open **Settings → Sync**, enter the server origin and choose **Authenticate**. Sign in in the browser, select an account and approve the device. The connection uses short-lived access tokens and a rotating refresh token stored in the private local sync directory.

The CLI equivalent is:

```fish
typerelay connect --server https://app.example.com
```

Use `--no-browser` to print the approval URL without opening it. Authentication waits up to five minutes for the loopback callback.

## Enroll local libraries

Local libraries are never uploaded merely because the desktop is connected. Select them under **Desktop Settings → Sync → Local libraries** and choose **Upload selected**, or run:

```fish
typerelay enroll "Library name"
```

Enrollment queues creation of a private server library. Configure team sharing later in the web app. A library already synchronized does not appear in the local enrollment list.

Server libraries you are allowed to read download automatically. This includes your synchronized libraries and shared libraries assigned directly or through a group.

## Automatic and manual sync

The resident desktop worker checks every 30 seconds. Pending local changes trigger a faster retry after about two seconds. **Sync now** requests an immediate cycle; it does not replace or reload the current view.

The server retains an incremental window of 10,000 sequence steps. An older cursor receives a full snapshot automatically, including the current access manifest and deletion records. Pending local edits still follow the normal conflict and recovery rules. Compact deletion records remain on the server to prevent old uploads from restoring permanently removed snippets.

Manual sync reports start, success, failure or changes needing attention through desktop notifications and the panel status. Automatic background sync stays quiet. Notifications still depend on operating-system notification settings.

The CLI equivalent is:

```fish
typerelay sync
```

## Work offline

Search, expansion and editing continue without a network connection. Each change and its stable operation ID are committed to SQLite together, then retried unchanged. Temporary network and server failures leave the queue intact.

When a server rejects a stale or unauthorized operation, TypeRelay keeps recoverable local content in its recovery store, removes the rejected queue item and refreshes authoritative state. This includes edits rejected because a library is gone (HTTP 410) and invalid edits the server cannot accept (HTTP 400 or 422), such as rich text whose images exceed the size limit, so later changes continue to sync. The TUI sync status reports the failure. Permanently purged server content cannot be restored locally. Before a detached library is reconciled after reconnecting, TypeRelay creates a SQLite backup under the local `backups` directory.

## Recover rejected edits

Open **Desktop Settings → Sync → Recovered edits** to read the saved content and rejection reason. Choose **Copy** before dismissing an item. Dismiss removes only that recovery record from this device.

In the TUI, choose **Recovery (F12)** outside the editor. Use the arrow or Page Up/Page Down keys to read the records, `r` to resume one as a draft, `c` to copy, `e` to export, `d` to dismiss a preserved record, and Esc to return.

If a recovered snippet contains images, TUI JSON copy does not allow dismissal; export a `.typerelay.zip` bundle, which includes the image data, before dismissing.

The CLI prints the same records as JSON:

```fish
typerelay recovery
typerelay recovery --dismiss RECOVERY_ID
```

Copy or export the content before dismissing it. Recovery does not retry a rejected operation or restore server permissions.

## Conflicts

Different snippet IDs merge independently. If the same snippet changed from an older base on two devices, the server retains the local, base and current server versions as a conflict. Open the web app and choose **Resolve** and one of these options. Resolving a conflict deletes the stored versions.

- keep the local version, including a local deletion;
- keep the current server version; or
- edit and save a merged version.

Review conflicts in **Desktop Settings → Sync → Needs review**. It shows the base, local and server records and lets you keep either side or edit a merged record. You need current edit access to resolve a conflict. Other libraries and non-conflicting changes continue to sync.

## Permission changes and revocation

The server sends a complete access manifest. After a successful sync, a library you can no longer read is removed from active local search and expansion. Pending edits for that library are removed from the upload queue and retained in recovery. A read-only library remains searchable but local edits cannot upload.

Removing a team member revokes that member’s devices for the account. Revoking a single device blocks further sync without signing the user out elsewhere.

## Disconnect

Use the account’s **Connected devices** settings to revoke a machine remotely, or run locally:

```fish
typerelay disconnect
```

Local disconnect revokes the current device, removes its credentials, marks synchronized libraries as local and preserves snippets and their last server baselines. Pending changes are moved to recovery. When the same account reconnects, independent local and server edits are merged by stable snippet ID and same-snippet changes become reviewable conflicts. Libraries from another server or account remain independent local libraries. Changing only the server URL never redirects existing credentials.

Disconnect discards usage statistics that have not uploaded yet. Connecting to another account or server also removes usage queued for the previous identity. This applies to native clients and the browser extension.

## Compatibility

Desktop and server must both support sync protocol 6. A mismatch stops sync with an upgrade message before content is exchanged. Upgrade the engine, TUI and panel together on Omarchy. Rich-text image manifests sync with library records; authenticated binary transfers are deduplicated and completed before a changed snapshot becomes active.
