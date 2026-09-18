# Sync and offline use

TypeRelay is local-first. The desktop reads and writes SQLite; the server is used to synchronize enrolled libraries, distribute accessible server libraries and coordinate team permissions. Exported YAML is a portable copy, not live storage.

## What synchronizes

- Library names, snippets, ordering, content type, code language and template definitions.
- Sharing grants and read/edit/manage permissions.
- Trash state, restore deadlines, moves and conflict resolutions.
- Template defaults and definitions, but never answers entered while filling a template.

The trigger prefix, panel shortcut and launch-at-login setting are local to each machine.

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

Manual sync reports start, success, failure or changes needing attention through desktop notifications and the panel status. Automatic background sync stays quiet. Notifications still depend on operating-system notification settings.

The CLI equivalent is:

```fish
typerelay sync
```

## Work offline

Search, expansion and editing continue without a network connection. Each change and its stable operation ID are committed to SQLite together, then retried unchanged. Temporary network and server failures leave the queue intact.

When a server rejects a stale or unauthorized operation, TypeRelay keeps recoverable local content in its recovery store, removes the rejected queue item and refreshes authoritative state. The TUI sync status reports the failure. Permanently purged server content cannot be restored locally.

## Conflicts

Different snippet IDs merge independently. If the same snippet changed from an older base on two devices, the server retains the local, base and current server versions as a conflict. Open the web app and choose **Resolve** to:

- keep the local version, including a local deletion;
- keep the current server version; or
- edit and save a merged version.

You need current edit access to resolve a conflict. Other libraries and non-conflicting changes continue to sync.

## Permission changes and revocation

The server sends a complete access manifest. After a successful sync, a library you can no longer read is removed from active local search and expansion. Pending edits for that library are removed from the upload queue and retained in recovery. A read-only library remains searchable but local edits cannot upload.

Removing a team member revokes that member’s devices for the account. Revoking a single device blocks further sync without signing the user out elsewhere.

## Disconnect

Use the account’s **Connected devices** settings to revoke a machine remotely, or run locally:

```fish
typerelay disconnect
```

Local disconnect revokes the current device, removes its credentials, marks synchronized libraries as local and preserves snippets. Pending changes are moved to recovery. After reconnecting, run a first sync so accessible server libraries are recognized again, then explicitly enroll only the remaining local libraries you want to upload. Changing only the server URL never redirects existing credentials.

## Compatibility

Desktop and server must both support sync protocol 6. A mismatch stops sync with an upgrade message before content is exchanged. Upgrade the engine, TUI and panel together on Omarchy. Rich-text image manifests sync with library records; authenticated binary transfers are deduplicated and completed before a changed snapshot becomes active.
