# Settings

Use the avatar menu in the web app to open Settings. The available sections depend on your role, plan and whether hosted billing is enabled.

## Profile

Change your name or request a verified email-address change. See [Accounts and sign-in](./accounts).

## Security

Generate a new password, enable or disable authenticator-code two-factor authentication, and register or remove passkeys. Security changes require a browser sign-in from the last 15 minutes.

## My team

Switch to the intended account first. Owners and admins can rename the account, invite members, revoke pending invitations and manage groups. Only the owner can change admin roles. See [Teams and roles](./teams).

## Connected devices

This list contains your active desktop and CLI/TUI connections for the selected account. Each row shows client type, operating system, connection time and last authenticated activity in your browser’s local timezone. Older connections display Unknown for metadata they did not report. Revoking a device prevents it from refreshing credentials or syncing again. It does not delete the machine’s local SQLite data.

Hosted Free accounts can connect one machine. Pro trials, Pro and Team allow unlimited connected machines subject to platform safety limits. Stored extra device grants stop syncing after a downgrade until the account upgrades or the active Free-plan device is revoked.

## Access tokens

Create named personal access tokens for the API or MCP. Personal tokens do not expire and receive every API scope, but they never override your account role or library permissions. The secret is shown once; copy it before dismissing the confirmation.

Hosted API and MCP access require an active Pro trial, Pro or Team plan. Existing tokens remain stored after a downgrade but cannot authenticate. Delete a token to stop it immediately.

The **OAuth** tab shows discovery metadata and apps you have authorized. Revoking an app invalidates its refresh and delegated access. Account owners and admins can also pre-register public PKCE clients or confidential clients that authenticate with a client secret. Confidential secrets are shown only once.

## Subscription and white-label

Hosted account owners and admins can manage the plan, seats, payment details and invoices under **Subscription**. Team accounts can upload navigation/login logos and a favicon or configure a custom domain under **White-label**. See [Billing and white-label](../cloud/billing).

## Local desktop settings

The desktop panel has separate settings for the global search shortcut, launch at login, server authentication and local-library enrollment. The trigger prefix and server origin are stored per machine; they do not synchronize. See [Search panel](../desktop/panel) and [Sync](./sync).
