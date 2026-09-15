# Settings

Use the avatar menu in the web app to open Settings. The available sections depend on your role, plan and whether hosted billing is enabled.

## Profile

Change your name or request a verified email-address change. See [Accounts and sign-in](./accounts).

## Security

Generate a new password, enable or disable authenticator-code two-factor authentication, and register or remove passkeys. Security changes require a browser sign-in from the last 15 minutes.

## My team

Switch to the intended account first. Owners and admins can rename the account, invite members, revoke pending invitations and manage groups. Only the owner can change admin roles. See [Teams and roles](./teams).

## Connected devices

This list contains your active desktop connections for the selected account. Revoking a device prevents it from refreshing credentials or syncing again. It does not delete the machine’s local SQLite data.

Hosted Free accounts can connect one machine. Pro trials, Pro and Team allow unlimited connected machines subject to platform safety limits. Stored extra device grants stop syncing after a downgrade until the account upgrades or the active Free-plan device is revoked.

## Access tokens

Create named personal access tokens for the API or MCP with a 1–365 day expiry and only the scopes needed. The secret is shown once. Tokens belong to you and the selected account; their scopes never override your library permissions.

Hosted API and MCP access require an active Pro trial, Pro or Team plan. Existing tokens remain stored after a downgrade but cannot authenticate. Creating or revoking tokens requires a recent sign-in.

## Subscription and white-label

Hosted account owners and admins can manage the plan, seats, payment details and invoices under **Subscription**. Team accounts can upload navigation/login logos and a favicon or configure a custom domain under **White-label**. See [Billing and white-label](../cloud/billing).

## Local desktop settings

The desktop panel has separate settings for the global search shortcut, launch at login, server authentication and local-library enrollment. The trigger prefix and server origin are stored per machine; they do not synchronize. See [Search panel](../desktop/panel) and [Sync](./sync).
