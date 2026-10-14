---
title: "SAML single sign-on"
description: "Use SAML single sign-on with TypeRelay Pro or Team, manage enforcement and member provisioning, and understand account and device access."
---

# SAML single sign-on

SSO lets members sign in to a TypeRelay account through their organization's SAML 2.0 identity provider. It is available on **Pro and Team**, including the Pro trial. Self-hosted installations follow the existing unrestricted entitlement policy when billing is disabled.

Owners and admins manage one provider per account under **Settings → Single sign-on**. Start with the [setup guide](./sso-setup), then follow the [provider instructions](./sso-providers).

## Sign in

Open the SSO sign-in link shared by your administrator. Alternatively, expand **Sign in with your organization's SSO** on the login page and enter that link or the account ID. Complete your provider's authentication and any authenticator-code step enabled on your TypeRelay user.

Desktop, mobile, the browser extension, and OAuth integrations use this same browser sign-in. After SSO, return to the account/device approval screen and complete the connection. Keep the flow in the same browser; it expires after ten minutes.

SSO signs you into the selected account. To access other accounts or change your personal profile, password, email, passkeys, or two-factor settings, sign in separately with password, Magic Link, or passkey.

## Require SSO

After a successful administrator test and generation of an owner recovery code, enable **Require SSO for this account**. Password, Magic Link, and passkey sessions cannot access that account while enforcement is active. Previously connected devices and apps that were authorized without SSO must reconnect through SSO. Existing offline copies on devices are not remotely erased.

Each settings save invalidates earlier SSO sessions and credentials. The administrator making the change keeps their current SSO session when SSO remains enabled. This does not end sessions at the identity provider.

## Automatic provisioning

Provisioning is off by default. When enabled after a successful test, an assigned provider user can join on first SSO sign-in. TypeRelay creates a **Member**, never an Owner or Admin, and checks the account's member and purchased-seat limits. Existing members keep their roles. Provisioning does not purchase seats or create personal accounts.

Groups and library access are managed in TypeRelay; provider group/role claims are not imported. Private libraries stay private. Remove users from the provider application's assignments as well as TypeRelay when deprovisioning: a removed member can rejoin if provisioning is enabled and the provider still grants access. SCIM and automatic provider-driven deprovisioning are not included.

## Plan changes

On Free, SSO sign-in and enforcement become inactive. The owner can use ordinary sign-in to manage the account. Provider configuration is retained for a later upgrade, but earlier SSO sessions and credentials stop working. Pro/Team eligibility is checked again when the provider returns, so an in-progress login cannot bypass a downgrade.

For recovery, certificate changes, or rejected logins, see [SSO troubleshooting](./sso-troubleshooting).
