# Getting started

## 1. Sign in

Create an account when sign-up is available, or sign in with password, Magic Link or a registered passkey. New accounts are completed through a 15-minute, single-use email link. See [Accounts and sign-in](./accounts) for password setup, two-factor authentication and account switching.

## 2. Install the desktop app

Install the package for your operating system. On macOS, grant Accessibility and Input Monitoring when prompted. On Omarchy, the installer configures the user service and scoped input-device permissions. Windows needs no equivalent permission, but cannot insert into an elevated application from a normally running TypeRelay process.

See [Desktop installation](../desktop/installation) and [Operating system notes](../desktop/platforms) before rollout.

## 3. Connect the desktop

Open **Settings → Sync** in the desktop panel, enter the TypeRelay server origin, and choose **Authenticate**. The address must be an HTTPS origin such as `https://app.example.com`, with no path. Loopback HTTP is allowed for development.

The browser opens an approval page. Sign in, choose the account to connect, and approve the device. Authentication returns to the desktop through a temporary loopback callback. Closing the browser early or waiting more than five minutes cancels the connection.

Free hosted accounts allow one connected machine. Revoke an old machine under **Settings → Connected devices** before connecting another. Self-hosted installations do not apply hosted plan limits.

## 4. Create or download a library

You can start either place:

- In the TUI, create a local library and add snippets. Local libraries stay only on that machine until you explicitly select them under **Desktop Settings → Sync → Local libraries** and choose **Upload selected**.
- In the web app, choose **New library**. Server libraries you can access download during sync. Libraries assigned to you by a team also download automatically.

The first upload creates a private server library. It does not share the library with a team. Configure sharing separately in the web app.

## 5. Add and use a snippet

Give the snippet an optional title, an optional abbreviation and its expansion. Abbreviations contain lowercase letters, numbers or hyphens and do not include the local prefix. A snippet without an abbreviation is still available in search and Copy.

Open the search panel with **Ctrl+Shift+;** or the **T** tray/menu-bar icon. Select a result and press Enter to insert it into the application that was active before the panel opened.

For continuous expansion, type the prefix, abbreviation and Space. If the default prefix is `;` and the abbreviation is `email`, type `;email `.

## 6. Confirm synchronization

Use **Sync now** from the tray/menu-bar menu or desktop settings. Background sync also runs every 30 seconds and retries queued offline changes. If a change needs attention, review the status in the TUI and resolve conflicts in the web app.
