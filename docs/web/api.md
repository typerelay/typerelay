# TypeRelay API v1

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

- `GET /api/v1/libraries`: accessible libraries.
- `POST /api/v1/import/preview {yaml}`: Rust validation and parsed matches; does not persist.
- `POST /api/v1/libraries {operation_id,name,yaml}`: new private library; filenames never identify existing libraries.
- `PATCH /api/v1/libraries/:id {operation_id,base_revision,name,shared,editable,members[],groups[]}`: rename/permissions. `deleted:true` explicitly deletes a library.
- `POST /api/v1/libraries/:id/snippets {operation_id,base_revision,changes[],yaml?}`: merge changes atomically. Each change: `{id,base_revision,base?,value}`; value is `{trigger,replace}` or null for deletion; new snippets have null base_revision. Web edits retain IDs; desktop trigger renames delete/create.
- Optional complete YAML is accepted only when it matches submitted snippets and the library base is current. Otherwise canonical comments/formatting remain server-owned and desktop preserves divergent local text.
- Responses include `library` and optional conflict IDs. Browser responses additionally include Pug-rendered per-item fragments.
- `GET /api/v1/library-view/:id`, `/editor/:id`, `/forms/:kind`, `/fragments/:type/:id`: permission-checked browser representations.

Each library stores canonical YAML, ordered snippet IDs/revisions, grants and a library revision in one record. All library writes, conflict records, idempotency receipts and account change events commit in one MongoDB transaction.

## Sync and conflicts

`GET /api/v1/sync?cursor=N` returns:

```json
{"cursor":42,"accessible":["library-id"],"libraries":[],"conflicts":[]}
```

`accessible` is the complete current access manifest; remove previously managed IDs no longer present. `libraries` contains changed visible libraries, or all on cursor 0 / membership change. Commit the returned cursor locally only after activation succeeds. Missing local files are restored; they never imply library deletion.
Changes to separate snippet IDs merge. Divergent changes to one ID retain local/base/server values in a conflict record.

`POST /api/v1/conflicts/:id {operation_id,base_revision,choice,value?}`: choice `local`, `server`, or `merged`; merged value is a snippet or null. Current edit access and current library revision are required.

## Account/team/devices

- `GET /api/v1/team`: members and flat groups.
- `POST /api/v1/team/invitations {email}`: admin/owner; seven-day email-bound invite.
- `DELETE /api/v1/team/invitations/:id`: admin/owner revokes a pending invitation.
- `POST /api/v1/team/accept {operation_id,token}`: signed-in matching email.
- `PATCH /api/v1/team/members/:id {operation_id,role?}`: owner changes admin/member role; omitted role removes member. Owners cannot be removed; admins cannot alter other admins.
- `POST /api/v1/team/groups {operation_id,name,users[]}`, `PATCH /api/v1/team/groups/:id {operation_id,name,users[],deleted?}`: admin/owner.
- `PATCH /api/v1/profile {name}`, `PATCH /api/v1/account {name}` (admin/owner).
- `GET /api/v1/devices`: own connected devices in this account.
- `DELETE /api/v1/devices/:id`: revoke own device.
- `DELETE /api/v1/connection`: revoke currently authenticated desktop device.

Errors use `{error:string}`: 400 invalid input; 401 expired/revoked authentication; 403 permission/CSRF; 404 inaccessible resource; 409 stale base or reused operation; 422 invalid YAML.
