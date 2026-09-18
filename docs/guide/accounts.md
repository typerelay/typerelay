# Accounts and sign-in

## Create an account

When public sign-up is enabled, choose **Create one**, enter your name and email address, then use the link in the email to finish. The link is single-use and expires after 15 minutes. The first verified sign-in creates your personal account and makes you its owner.

Some self-hosted installations disable public sign-up. In that case, the sign-up page says it is disabled; an existing team administrator must invite you or the operator must enable sign-up.

Hosted custom/branded domains are account-specific: they do not show public sign-up, and sign-in succeeds only for an existing member of that account. Create an account at the canonical TypeRelay hostname or accept an invitation first.

## Sign-in methods

- **Password** — available after a password has been generated under **Settings → Security** or through **Forgot password**.
- **Magic Link** — emails a 15-minute, single-use sign-in link. Request a new link if it expires or has already been used.
- **Passkey** — available after registering a passkey under **Settings → Security**. Passkeys require a current browser, HTTPS or localhost, and user verification such as Touch ID, Windows Hello or a security key.

If two-factor authentication is enabled, password and Magic Link sign-in continue to a six-digit authenticator-code step. A code can be used only once in its 30-second time window. A successful passkey sign-in already provides the required second factor.

## Passwords and recovery

TypeRelay generates a random password instead of asking you to choose one. Use either **Forgot password** on the sign-in page or **Settings → Security → Reset password**. Copy the displayed password before leaving; TypeRelay stores only its password hash and cannot show it again.

A password reset link expires after 15 minutes. Resetting the password invalidates older browser sessions.

## Profile and email address

Open **Settings → Profile** to change your name or email address. A name change is immediate. An email change is sent to the new address and does not take effect until you confirm it while signed in. The confirmation fails if the address is already in use or the account changed after the request.

Changing security settings, registering or removing passkeys, changing email, and managing access tokens require a browser sign-in from the last 15 minutes. If prompted, sign out and sign in again before retrying.

## Two-factor authentication and passkeys

Under **Settings → Security**:

- **Enable 2FA** displays a QR code and manual secret. Add it to an authenticator app, then confirm a current six-digit code.
- **Disable 2FA** requires a current code.
- **Add passkey** registers a named discoverable credential. Removing a passkey affects only that credential.

Passkeys are bound to the hostname configured as the main TypeRelay application. Hosted branded domains therefore use password, Magic Link and authenticator-code sign-in; register and use passkeys at `app.typerelay.com`.

## Multiple accounts

An invitation can add the same user to another TypeRelay account. Use the account selector above the library list to switch. Libraries, team roles, devices, subscriptions and access tokens are scoped to the selected account.

On hosted plans, non-owner membership in another account requires that account to remain on Team. A desktop connection is also bound to one selected account; disconnect and authenticate again to switch it.

## Sign out

Choose the avatar menu, then **Sign out**, to end the current browser session. This does not disconnect desktop devices or revoke API/MCP tokens. Manage those separately under **Connected devices** and **Apps Access**.
