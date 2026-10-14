---
title: "SAML provider configuration"
description: "Map TypeRelay SAML settings to Microsoft Entra ID, Okta, OneLogin, and Auth0, including response signatures, email NameID, and callback URLs."
---

# SAML provider configuration

Complete the [TypeRelay setup](./sso-setup) alongside these instructions. Copy URLs from your account; do not reuse another account's URLs. The provider must return the original RelayState unchanged.

## Microsoft Entra ID

Create an enterprise application and select SAML single sign-on. Set **Identifier (Entity ID)** to TypeRelay's metadata URL and **Reply URL** to its Assertion Consumer Service URL. Use the TypeRelay sign-in link for application-initiated login. Map the unique user identifier to the email address used in TypeRelay.

In the signing certificate settings, choose **Sign SAML response and assertion** or **Sign SAML response**, with **SHA-256**. Copy the Microsoft Entra Identifier, Login URL, and Base64 certificate into TypeRelay's issuer, login URL, and certificate fields. Assign the application to your test administrator and members, then launch **Test login from TypeRelay**. Microsoft documents these [signing options](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/certificate-signing-options).

## Okta

Create a SAML 2.0 app integration. Set **Single sign-on URL** to TypeRelay's ACS URL and **Audience URI (SP Entity ID)** to its metadata URL. Use email for the application username and NameID.

Under advanced settings, set **Response** to signed, select RSA-SHA256/SHA256, and leave assertion encryption and signed requests disabled. Assertion signing can also be enabled. Copy the identity-provider issuer, SSO URL, and certificate from Okta's sign-on details into TypeRelay. Assign users and run TypeRelay's test. Configure any dashboard bookmark to open the TypeRelay SSO sign-in link. See Okta's [SAML field reference](https://help.okta.com/en-us/Content/Topics/Apps/aiw-saml-reference.htm).

## OneLogin

Use **SAML Custom Connector (Advanced)**. Set Audience to TypeRelay's Entity ID, Recipient and ACS Consumer URL to its ACS URL, and Login URL to its SSO sign-in link. Set the ACS validator to an anchored, escaped regular expression matching that exact URL. Avoid wildcard validators.

Choose **Service Provider** as the initiator, **Email** as NameID, and **Response** as the signature element. Select SHA-256 and a short assertion validity period. Copy OneLogin's issuer, SAML endpoint, and public certificate into TypeRelay, assign the administrator, and test from TypeRelay. See OneLogin's [connector reference](https://onelogin.service-now.com/kb?id=kb_article_view&sysparm_article=KB0011004).

## Auth0

Create an application and enable its **SAML2 Web App** addon. Set Application Callback URL to TypeRelay's ACS URL. Configure the audience to TypeRelay's Entity ID, use the email-address NameID format, and set `nameIdentifierProbes` to `["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"]`. Enable response signing with `signResponse: true`, `signatureAlgorithm: "rsa-sha256"`, and `digestAlgorithm: "sha256"`.

Copy the issuer, identity-provider login URL, and signing certificate from the addon's Usage tab into TypeRelay. Enable the appropriate user connection and test from TypeRelay. Auth0 documents the [SAML2 addon](https://auth0.com/docs/authenticate/single-sign-on/outbound-single-sign-on/configure-auth0-saml-identity-provider) and [assertion configuration](https://auth0.com/docs/authenticate/protocols/saml/saml-configuration/customize-saml-assertions).

## Verify your tenant

Provider menus and policies vary. These mappings describe the required configuration; run the administrator test and a member/device sign-in in your own tenant before enforcing SSO. TypeRelay's automated tests use signed SAML fixtures and do not certify your provider tenant's settings.
