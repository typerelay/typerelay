---
title: "Sync TypeRelay Desktop"
description: "Connect TypeRelay Desktop to an account, enroll local libraries, synchronize offline changes, merge content, and recover from conflicts."
---

# Desktop sync

Open **Settings → Sync**, enter the server origin and choose **Authenticate**. The browser asks you to sign in, select an account and approve the device. The desktop stores credentials outside the webview in its private sync directory.

After connecting, select local-only libraries under **Local libraries** and choose **Upload selected**. Enrollment is explicit and creates private server libraries. Accessible server libraries, including assigned shared libraries, download automatically.

Choose **Merge…** beside a library to move all its active snippets into another editable library. The destination keeps its name, sharing and sync settings; destination sharing applies to moved snippets. The source moves to 30-day Trash only after the merge succeeds. A local-only source may merge into a synchronized destination, but a synchronized source requires a synchronized destination.

SQLite retains offline edits and a durable upload queue. Sync polls every 30 seconds; pending work retries sooner, and **Sync now** requests an immediate cycle. Transport failures never discard queued operations. Authorization, stale-revision or validation failures preserve recoverable drafts and refresh server state.

Conflicts keep the base, local and server records for review in **Settings → Sync → Needs review**. Keep either side or edit a merged record without replacing the surrounding settings view. Permission revocation removes inaccessible content from active local search/expansion on the next successful sync and preserves unsent edits in recovery. Exported YAML is not active storage.

Hosted Free accounts can connect one machine. Pro trials, Pro, and Team allow unlimited connected machines subject to platform safety limits. Extra device grants remain stored after a downgrade but cannot sync until the account upgrades or the primary machine is revoked.

For the complete behavior, CLI commands and disconnect semantics, see [Sync and offline use](../guide/sync).
