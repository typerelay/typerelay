---
title: "Accounts and sign-in"
description: "Create a TypeRelay account, sign in with passwords, Magic Links or passkeys, manage two-factor authentication, recover access, and switch accounts."
---

# Accounts and sign-in

## Create an account

When public sign-up is enabled, choose **Create one** and enter your name and email address. TypeRelay creates your personal account, makes you its owner, and signs you in right away.

We also send a confirmation email. Until you confirm your email address, a banner at the top of the app reminds you; choose **Resend** to get a new email (at most once a minute). Open the link and choose **Confirm email address**. Accounts without a confirmed email address are deleted, with their data, 24 hours after signup. Until you confirm, you can use your snippets and connect the desktop and mobile apps, but you cannot add or invite team members, set a password, set up two-factor authentication or passkeys, create API tokens, or connect integrations. If you sign in with a Magic Link before confirming, that also confirms the address and, for safety, signs out other sessions and devices.

If an account already exists for the email address, sign-up does not sign you in. Instead, we email a sign-in link to that address.

In the TypeRelay mobile app, choose **Create account** on the sign-in screen. After you sign up, the app asks you to connect the device and then signs you in; the same confirmation banner appears above your snippets. On iOS, sign-in uses Safari's secure sign-in sheet, so saved passwords and an existing Safari session are available; iOS asks once to allow TypeRelay to use the TypeRelay website to sign in.

Some self-hosted installations disable public sign-up. In that case, the sign-up page says it is disabled; an existing team administrator must invite you or the operator must enable sign-up.

Hosted custom/branded domains are account-specific: they do not show public sign-up, and sign-in succeeds only for an existing member of that account. Create an account at the canonical TypeRelay hostname or accept an invitation first.

## Sign-in methods

- **Password** — available after a password has been generated under **Settings → Security** or through **Forgot password**.
- **Magic Link** — emails a 15-minute, single-use sign-in link. Request a new link if it expires or has already been used.
- **Passkey** — available after registering a passkey under **Settings → Security**. Passkeys require a current browser, HTTPS or localhost, and user verification such as Touch ID, Windows Hello or a security key.

If two-factor authentication is enabled, password and Magic Link sign-in continue to a six-digit authenticator-code step. Codes from the previous or next 30-second window are also accepted to allow for small clock differences. Each code can be used only once. A successful passkey sign-in already provides the required second factor.

## Passwords and recovery

TypeRelay generates a random password instead of asking you to choose one. Use either **Forgot password** on the sign-in page or **Settings → Security → Reset password**. Copy the displayed password before leaving; TypeRelay stores only its password hash and cannot show it again.

A password reset link expires after 15 minutes. Resetting the password invalidates older browser sessions.

## Profile and email address

Open **Settings → Profile** to change your name or email address. A name change is immediate. An email change is sent to the new address and does not take effect until you confirm it while signed in. The confirmation fails if the address is already in use or the account changed after the request.

Changing security settings, registering or removing passkeys, and changing email require an active browser session. There is no additional sign-in time limit for these actions. Personal tokens and OAuth apps are managed separately under **Settings → Apps Access**.

## Two-factor authentication and passkeys

Under **Settings → Security**:

- **Enable 2FA** displays a QR code and manual secret. Add it to an authenticator app, then confirm a current six-digit code.
- **Disable 2FA** requires a current code.
- **Add passkey** registers a named discoverable credential. Removing a passkey affects only that credential.

Passkeys are bound to the hostname configured as the main TypeRelay application. Hosted branded domains therefore use password, Magic Link and authenticator-code sign-in; register and use passkeys at `app.typerelay.com`.

## Multiple accounts

An invitation can add the same user to another TypeRelay account. Use the account selector above the library list to switch. Libraries, team roles, devices, subscriptions and access tokens are scoped to the selected account.

On hosted plans, non-owner membership in another account requires that account to remain on Pro or Team. A desktop connection is also bound to one selected account; disconnect and authenticate again to switch it.

## Sign out

Choose the avatar menu, then **Sign out**, to end the current browser session. This does not disconnect desktop devices or revoke API/MCP tokens. Manage those separately under **Connected devices** and **Apps Access**.

## Organization SSO

Pro and Team accounts can enable [SAML single sign-on](./sso). Use the SSO link supplied by your administrator. SSO sessions are limited to that account; personal security changes require ordinary sign-in.
