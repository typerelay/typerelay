---
title: "SSO troubleshooting and recovery"
description: "Recover a TypeRelay account when SSO is unavailable, rotate signing certificates, diagnose SAML errors, and restore device connections."
---

# SSO troubleshooting and recovery

## Owner recovery

1. Open the account's recovery URL shown in Single sign-on settings: `/auth/sso/ACCOUNT_ID/recovery` on its SSO hostname.
2. Sign in as the owner with password, Magic Link, or passkey, including TypeRelay two-factor authentication when enabled. An SSO session cannot authorize recovery.
3. Return to the recovery URL and enter the saved recovery code.
4. Recovery disables enforcement and consumes the code. Repair and test the provider, generate a new recovery code, then re-enable enforcement.

If you no longer have the code or access to the owner's ordinary sign-in, contact your TypeRelay operator/support. An administrator role or a URL parameter is not a recovery bypass.

## Common problems

| Symptom | Check |
| --- | --- |
| SAML response rejected | Sign the complete response with SHA-256 or stronger. Compare issuer, audience, ACS, recipient, and current certificate against settings. |
| Login expired or another browser | Start again from the TypeRelay SSO link in the same browser. Keep cookies enabled. Requests expire in ten minutes; the final handoff lasts one minute. |
| Test login rejected | Use the same email as the TypeRelay owner/admin who started the test. Assign that identity to the provider app. |
| User not added | Invite/add the user first, or test and enable provisioning. Check available seats and the provider's email NameID. |
| Device/app no longer connects | Reauthenticate through SSO and approve the account again. Settings changes invalidate earlier SSO credentials; enforcement also blocks credentials issued without SSO. |
| Domain changed | Update provider URLs to the values currently displayed in settings and repeat the test. |
| Account is on Free | SSO and enforcement are inactive. The owner can use ordinary sign-in to manage the plan. |

TypeRelay permits 30 seconds of clock skew and accepts assertions no older than five minutes. Synchronize provider and server clocks. Replayed assertions and responses without a matching TypeRelay request are rejected.

## Rotate a certificate

Keep an owner recovery code available. Disable enforcement before replacing the provider certificate, save the new current PEM certificate, and run **Test login** again. A provider change clears eligibility for enforcement/provisioning until the new test passes; uncheck those settings while saving the replacement. Only one signing certificate is supported at a time, so coordinate the cutover with your provider.

## Login logs

Owners/admins can select **Refresh logs** in Single sign-on settings. The latest 50 events from the last 30 days report configuration changes, provider tests, SAML response failures, identity verification, and recovery. They do not contain raw assertions, certificates, recovery codes, or provider error payloads. An identity-verification event does not mean a pending TypeRelay two-factor step has completed.
