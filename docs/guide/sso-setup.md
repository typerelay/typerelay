---
title: "Set up SAML SSO"
description: "Configure a TypeRelay SAML provider, exchange Entity ID and ACS URLs, test administrator sign-in, and prepare an owner recovery code."
---

# Set up SAML SSO

You need owner/admin access to a Pro or Team account and permission to configure an application at your identity provider.

1. Open **Settings → Single sign-on** in the correct TypeRelay account. The cards group **Identity provider**, **Service provider**, **Settings**, and **Owner recovery**.
2. Create a SAML 2.0 application at your provider. Copy TypeRelay's **Entity ID / metadata URL** into the provider's audience/identifier field and **Assertion Consumer Service URL** into its ACS/reply/recipient fields.
3. Configure **NameID as the user's email address**. It must match an existing TypeRelay member unless you later enable provisioning. Optional `displayName` supplies a new member's initial name.
4. Configure the provider to sign the complete **SAML response** using RSA SHA-256 (or stronger). Signing the assertion too is supported. Assertion-only signing is insufficient. Use an unencrypted assertion, HTTP-POST responses, and application-initiated sign-in.
5. Copy the provider's **Entity ID / issuer**, **HTTPS login URL**, and **public X.509 signing certificate** into TypeRelay. The certificate must be a current PEM certificate with an RSA key of at least 2048 bits. Do not paste a private key.
6. Save settings with enforcement and provisioning off. You can leave **Enable SSO sign-in** off while testing.
7. Select **Test login** and authenticate as the same administrator who opened the test. On a custom hostname, you may first need to sign in to TypeRelay on that hostname. A test checks the provider without changing your signed-in user or provisioning anyone.
8. After the success page, return to settings and choose **Reload settings**. Enable SSO sign-in, save, and share the displayed SSO sign-in link.

Use [provider-specific instructions](./sso-providers) for Entra ID, Okta, OneLogin, and Auth0.

## Prepare recovery before enforcement

The owner signs in with password, Magic Link, or passkey, opens Single sign-on settings, and selects **Generate new recovery code**. Copy the code immediately into a secure place outside TypeRelay. It is shown once; a replacement invalidates the previous code.

Once the provider test passes and the recovery code is ready, enable **Require SSO for this account**. Inform members that existing device and app connections may require reconnection. [Recovery instructions](./sso-troubleshooting#owner-recovery) remain available even when the provider is unavailable.

## Hostnames and metadata

Pro works on the standard TypeRelay hostname. An active Team custom domain becomes the account's SSO hostname. Always copy the exact URLs shown in settings. Activating, removing, or changing that domain changes the provider URLs; update the identity provider and repeat the test before relying on SSO.

**View metadata** provides the public service-provider XML after the provider has been saved. The identity provider must echo the original RelayState and respond to a TypeRelay authentication request. Provider dashboard tiles should open the displayed SSO sign-in link. Unsolicited provider-initiated assertions, signed authentication requests, encrypted assertions, and SAML Single Logout are not supported. Signing out ends the TypeRelay session only.
