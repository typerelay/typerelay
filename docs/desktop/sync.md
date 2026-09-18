# Desktop sync

Open **Settings → Sync**, enter the server origin and choose **Authenticate**. The browser asks you to sign in, select an account and approve the device. The desktop stores credentials outside the webview in its private sync directory.

After connecting, select local-only libraries under **Local libraries** and choose **Upload selected**. Enrollment is explicit and creates private server libraries. Accessible server libraries, including assigned shared libraries, download automatically.

SQLite retains offline edits and a durable upload queue. Sync polls every 30 seconds; pending work retries sooner, and **Sync now** requests an immediate cycle. Transport failures never discard queued operations. Authorization, stale-revision or validation failures preserve recoverable drafts and refresh server state.

Conflicts keep both versions for resolution in the web app. Permission revocation removes inaccessible content from active local search/expansion on the next successful sync and preserves unsent edits in recovery. Exported YAML is not active storage.

Hosted Free accounts can connect one machine. Pro trials, Pro, and Team allow unlimited connected machines subject to platform safety limits. Extra device grants remain stored after a downgrade but cannot sync until the account upgrades or the primary machine is revoked.

For the complete behavior, CLI commands and disconnect semantics, see [Sync and offline use](../guide/sync).
