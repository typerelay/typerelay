TypeRelay's server adapts account membership, invitations, hashed one-time authentication tokens, and OAuth authorization code / S256 PKCE design patterns from Streamient (https://github.com/streamient/streamient), copyright its contributors, licensed AGPL-3.0. The upstream license is retained in Streamient-LICENSE. TypeRelay has separate storage and credentials; it does not connect to Streamient data.

Restored login/signup/recovery forms, random-password reset, TOTP setup and passkeys adapt Streamient's views/auth, views/includes/settings_profile_content.pug, routes/auth.js and services/passkey_service.js. WebAuthn uses the same SimpleWebAuthn server library; TypeRelay requires user verification and stores one-use challenges separately.

Settings sidebar navigation and the navbar search palette follow Streamient/Mailtwine's views/layout.pug and settings sidebar patterns, scoped to TypeRelay's available features.

Beta corner ribbon and responsive pill adapt Mailtwine's views/includes/beta_notice.pug and public/css/mailtwine-tabler.css, copyright its contributors, AGPL-3.0. The upstream license is retained in Mailtwine-LICENSE; TypeRelay uses its own branding and beta copy.
