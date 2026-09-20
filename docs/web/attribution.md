TypeRelay's server adapts account membership, invitations, hashed one-time authentication tokens, and OAuth authorization code / S256 PKCE design patterns from Streamient (https://github.com/streamient/streamient), copyright its contributors, licensed AGPL-3.0. The upstream license is retained in Streamient-LICENSE. TypeRelay has separate storage and credentials; it does not connect to Streamient data.

Restored login/signup/recovery forms, random-password reset, TOTP setup and passkeys adapt Streamient's views/auth, views/includes/settings_profile_content.pug, routes/auth.js and services/passkey_service.js. WebAuthn uses the same SimpleWebAuthn server library; TypeRelay requires user verification and stores one-use challenges separately.

Settings sidebar navigation and the navbar search palette follow Streamient/Mailtwine's views/layout.pug and settings sidebar patterns, scoped to TypeRelay's available features.

Beta corner ribbon and responsive pill adapt Mailtwine's views/includes/beta_notice.pug and public/css/mailtwine-tabler.css, copyright its contributors, AGPL-3.0. The upstream license is retained in Mailtwine-LICENSE; TypeRelay uses its own branding and beta copy.

The top-nav mobile-app entry, lazy modal, public-beta wording, QR-card layout, and related tests adapt Mailtwine's views/layout.pug, views/ajax/mobile_apps_modal.pug, routes/mobile_apps.js, public/js/app.js, and public/css/app.css, copyright its contributors, AGPL-3.0. The upstream license is retained in Mailtwine-LICENSE; TypeRelay uses its own public-testing links and branding.

The split authentication shell, responsive form presentation, and bundled authentication background images are adapted from Mailtwine's current authentication UI, copyright its contributors, AGPL-3.0. The Inter variable font is copyright the Inter Project Authors and retained under the SIL Open Font License in `apps/server/public/licenses/inter.txt`.

Public integration OAuth and the separate Streamable HTTP MCP adapter follow Mailtwine/Streamient patterns. VitePress navigation, OpenAPI operation pages, sidebar generation, theme initialization, and API CSS adapt Mailtwine docs, copyright its contributors, AGPL-3.0. The retained Mailtwine-LICENSE applies to these adaptations. TypeRelay uses independent credentials and data.
