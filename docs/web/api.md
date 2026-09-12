# TypeRelay API v2

Browser requests use the TypeRelay session cookie, `X-Account-Id`, and `X-CSRF-Token` for mutations.
Desktop requests use `Authorization: Bearer <access_token>`; account/user identity comes exclusively from that token.
Private libraries are creator-only. Shared libraries are visible to their creator, assigned members/groups, and account owners/admins. Editors cannot alter grants.

## Authentication

- `POST /auth/login {email}`: email a 15-minute single-use sign-in link; creates an account on first verified login.
- `GET /auth/callback?token=...`: consume link, regenerate session.
- `POST /auth/logout`: invalidate browser session.
- `GET /oauth/authorize`: display account approval. Parameters: `client_id=typerelay-desktop`, `redirect_uri=http://127.0.0.1:<port>/callback`, `code_challenge`, `code_challenge_method=S256`, `state`, optional `device_name`.
- `POST /oauth/authorize`: same fields plus chosen `account` and CSRF token; redirect with five-minute one-use code and state.
- `POST /oauth/token`: JSON/form `grant_type=authorization_code`, code, client_id, redirect_uri, code_verifier; or `grant_type=refresh_token`, refresh_token.
- Tokens: 15-minute access; rotating 90-day refresh. Hashes only on server. Revoked devices cannot refresh.

## Libraries and snippets

Mutations below require `operation_id` (16–128 alphanumeric, underscore or hyphen characters; UUID recommended). Persist it before sending. Identical retries return the committed result; different payloads with a reused ID return 409.

- `GET /api/v2/libraries`: accessible libraries.
- `POST /api/v2/import/preview {yaml}`: Rust validation and parsed matches; does not persist.
- `POST /api/v2/libraries {operation_id,name,yaml}`: new private library; filenames never identify existing libraries.
- `PATCH /api/v2/libraries/:id {operation_id,base_revision,name,shared,editable,members[],groups[]}`: rename/permissions. `deleted:true` explicitly deletes a library.
- `POST /api/v2/libraries/:id/snippets {operation_id,base_revision,changes[],yaml?}`: merge changes atomically. Each change: `{id,base_revision,base?,value}`; value is `{trigger,replace}` or null for deletion; new snippets have null base_revision. Web edits retain IDs; desktop trigger renames delete/create.
- Normal sync uploads structured content only. YAML is accepted for import and generated for export, with a managed-file header.
- Responses include `library` and optional conflict IDs. Browser responses additionally include Pug-rendered per-item fragments.
- `GET /api/v2/library-view/:id`, `/editor/:id`, `/forms/:kind`, `/fragments/:type/:id`: permission-checked browser representations.

Library metadata/grants and individual snippet documents are separate. Snippets use a versioned content envelope, ordering, revision and lifecycle state. Writes, conflicts, content-free receipts and change events commit transactionally.

## Sync and conflicts

`GET /api/v2/sync?cursor=N` returns:

```json
{"cursor":42,"accessible":["library-id"],"libraries":[],"conflicts":[]}
```

`accessible` is the complete current access manifest; remove previously managed IDs no longer present. `libraries` contains changed visible libraries, or all on cursor 0 / membership change. Commit the returned cursor locally only after activation succeeds. The client reads SQLite. Changes to exported YAML never alter database records.
Changes to separate snippet IDs merge. Divergent changes to one ID retain local/base/server values in a conflict record.

`POST /api/v2/conflicts/:id {operation_id,base_revision,choice,value?}`: choice `local`, `server`, or `merged`; merged value is a snippet or null. Current edit access and current library revision are required.

## Account/team/devices

- `GET /api/v2/team`: members and flat groups.
- `POST /api/v2/team/invitations {email}`: admin/owner; seven-day email-bound invite.
- `DELETE /api/v2/team/invitations/:id`: admin/owner revokes a pending invitation.
- `POST /api/v2/team/accept {operation_id,token}`: signed-in matching email.
- `PATCH /api/v2/team/members/:id {operation_id,role?}`: owner changes admin/member role; omitted role removes member. Owners cannot be removed; admins cannot alter other admins.
- `POST /api/v2/team/groups {operation_id,name,users[]}`, `PATCH /api/v2/team/groups/:id {operation_id,name,users[],deleted?}`: admin/owner.
- `PATCH /api/v2/profile {name}`, `PATCH /api/v2/account {name}` (admin/owner).
- `GET /api/v2/devices`: own connected devices in this account.
- `DELETE /api/v2/devices/:id`: revoke own device.
- `DELETE /api/v2/connection`: revoke currently authenticated desktop device.

Errors use `{error:string}`: 400 invalid input; 401 expired/revoked authentication; 403 permission/CSRF; 404 inaccessible resource; 409 stale base or reused operation; 422 invalid YAML.

## Account login and security

Login follows Streamient/Mailtwine: password, Magic Link, Passkey, forgot-password and verified signup. Existing email-only accounts remain valid.

- `GET /login`, `GET /signup`, `POST /auth/signup {name,email}`: verification link creates the named account.
- `POST /auth/password {email,password}`: bcrypt password check; returns redirect or `requires2FA`.
- `GET/POST /auth/two-factor {code}`: complete a five-minute pending login; enabled TOTP applies to password and magic-link sign-in. Codes cannot be replayed in the same time step.
- `GET /forgot-password`, `POST /auth/forgot-password {email}`: neutral response; email a hashed, single-use 15-minute reset link.
- `GET /auth/reset-password?token=...`, `POST /auth/reset-password {token}`: explicit confirmation generates a random password to copy. Only bcrypt hashes are retained. Password changes invalidate older browser sessions.
- `POST /auth/passkey/options`, `POST /auth/passkey/verify {response}`: discoverable WebAuthn sign-in with required user verification. Challenges expire after five minutes and are consumed atomically.
- `PATCH /api/v2/profile {name,email}`: update name immediately; send verification to a changed email. Returns avatar and member-row Pug fragments. Email remains unchanged until logged-in `POST /auth/email {token}` confirms the link; existing addresses cannot be claimed.
- `GET /api/v2/security`: own 2FA status and passkey names.
- `POST /api/v2/security/password`: generate/display a new password, matching Streamient's reset workflow.
- `POST /api/v2/security/totp/setup`, `/confirm {code}`, `/disable {code}`: authenticator setup/verification/removal. QR code and manual secret appear only during setup.
- `POST /api/v2/security/passkeys/options`, `/verify {name,response}`: register a passkey.
- `GET/DELETE /api/v2/security/passkeys/:id`: render/remove an owned passkey.

Security mutations and email-change requests require a browser sign-in within the last 15 minutes. Desktop tokens cannot authorize these mutations. Existing sessions without a recent authentication timestamp must sign out and back in.
WebAuthn binds credentials to the configured `ORIGIN` and its hostname; remote sites require HTTPS. The local browser preview uses `http://localhost:3040`.

The top-right initials avatar opens Settings, Help and Sign out. Profile saves preserve the settings panel, update only the avatar and current member row, and retain input focus.

## Settings navigation and search

Settings follows Streamient/Mailtwine's left navigation and right content layout: Profile, Security, My team and Connected devices. Switching sections retains the existing forms and unsaved field values.

The navbar search trigger opens a modal with `/`, Ctrl+K or Cmd+K. Slash is ignored in editable fields; shortcuts do not interrupt another open modal. Arrow keys navigate results, Enter opens them and Escape closes search. Results match library names, abbreviations and expansion text.

`GET /api/v2/search?q=...` returns permission-filtered Pug search results (up to 60). Stale responses cannot replace a newer query. Selecting a snippet search result opens its edit modal directly; read-only snippets open locked. Library-name results open the library. Library cards also open from any card area or Enter/Space, not only the title.

## Trash and protocol transition

/api/v1 returns 426 with protocol:2. Sync replies contain protocol:2, changed library metadata/records, accessible IDs, content-free tombstones, conflicts and Trash metadata.
Web presentation replace fields alias content.text; only the content envelope is stored.

- GET /api/v2/trash: permitted, unexpired items and Pug fragments with can_restore/can_purge.
- POST /api/v2/trash/action: operation_id, target {type,id,library,revision}, action trash/restore/purge.
- POST /api/v2/trash/empty: operation_id and the exact eligible target snapshot. Permissions/revisions are rechecked.
- GET /api/v2/libraries/:id/export: generated YAML.
- GET /api/v2/operations/:id: account/user-scoped receipt lookup for interrupted legacy migration.

Ordinary deletion means Move to Trash. Restoring a library preserves independent child Trash state.
Purge is creator/admin-only for shared libraries; private Trash remains creator-only.
Restores validate active uniqueness/limits. Expired records cannot restore; cleanup runs hourly and on startup.

Web abbreviation forms display a static comma prefix. Leading commas typed or pasted into the abbreviation are stripped by shared client/server normalization; stored abbreviations remain bare.
