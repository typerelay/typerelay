# Backend administration

Open `/admin` on the origin configured by `APP_URL`. System administrators use a separate, eight-hour session. Account owners, desktop credentials, API tokens, and MCP grants cannot authorize admin endpoints. Custom domains cannot serve the admin panel.

Development Compose, including dbh, uses `SYSADMIN_EMAIL=sysadmin@localhost` and `SYSADMIN_PASSWORD=sysadminpassword`. Production requires both variables through the deployment's environment/secret manager and has no default credentials. Rotating either invalidates existing admin sessions. Login is limited to ten attempts per fifteen minutes per IP. All admin mutations require the session's CSRF token, including requests with an Authorization header.

## Accounts

Use the left sidebar to switch account statuses. Email Templates and Settings also use left-side navigation; switching their panels preserves unsaved edits. Email templates edit directly in the right-hand pane. Audit Logs keeps its filter/table layout.

Search by name, account ID, or owner email. Filter by billing plan or active, suspended, deleting, and failed state. Results contain 50 accounts per page. User counts represent memberships; active snippet counts exclude snippets inside trashed libraries. Details include trash, groups, invitations, credentials, assets, storage bytes, members, and custom-domain state.

Create accounts with an owner name/email. Existing users are reused without changing their credentials or name. Billing initialization and the owner sign-in email run after database provisioning; delivery/setup failures appear as warnings. Editing a shared owner's identity affects every account they belong to. Email changes invalidate existing browser authentication and pending verification links.

Suspension blocks account access from web, desktop, API, and MCP without canceling subscriptions. Reactivation restores access.

Complimentary plan and resource-limit overrides are separate from Stripe subscription fields. Blank inherits the normal entitlement; zero means unlimited. Overrides survive Stripe webhooks. Clearing overrides restores the ordinary billing/self-hosted entitlements. Changes do not charge, refund, or alter a Stripe subscription. Existing content remains when limits decrease; further increases are checked against the new limits.

The user export contains one row per membership and escapes CSV formula prefixes.

## Email templates and settings

Edit the subject and plain-text body for sign-in, signup verification, email changes, password resets, and invitations. `{{url}}` is required in each body. Preview uses an inert example URL; test-send uses the saved template. Reset restores built-in defaults. Token generation and expiration remain unchanged.

The Managani integration uses `@managani/node`, with base URL, public site key, enable/disable, and a masked server secret. Set `GIT_ENCRYPTION_KEY` to 32 bytes or 64 hexadecimal characters before saving a secret. Secrets use AES-256-GCM; back up the key alongside deployment secrets. A blank replacement keeps the current secret; clearing is explicit. Managani failures do not fail application requests.

Custom JavaScript and CSS execute only on the signed-in application page. Enter source without script/style tags. External origins must be listed explicitly, one HTTP(S) origin per line; production requires HTTPS. The application adds nonces and those origins to its CSP. Admin, login, signup, and OAuth pages never include this code or the Managani widget.

Audit Logs combines API audit records and admin actions. Filter by account, actor, action, result, and date. Passwords, credentials, verification URLs, and custom-code bodies are excluded. API logs retain their existing 90-day expiration. Account purge removes account-scoped audit records.

## Permanent account deletion

Deletion requires typing the exact account ID. It immediately closes account access and queues durable cleanup. The scheduler checks queued deletions every minute. The app and scheduler must share the same `WHITE_LABEL_ASSETS_DIR` filesystem; the supplied Compose files share `/data`.

Cleanup drains active requests/jobs, cancels subscriptions and schedules, expires open Checkout sessions, removes the Cloudflare hostname and branding directory, and hard-deletes account-owned records. This includes trash/tombstones, snippet assets, credentials and indirect OAuth tokens, sync receipts, conflicts, tickets, audit records, and historical migration payloads. Users with no remaining account membership are removed with their passkeys, security tickets, and sessions. Shared users, other accounts, global OAuth registrations, and migration completion markers remain.

Cleanup uses a renewable database lease. Crashed request/worker leases expire after five minutes; a restarted scheduler resumes unfinished work. Failures stay inaccessible and appear in Accounts with a Retry purge action. The account record is removed only after database/file verification. Repeated cleanup tolerates already-missing external resources.

Historical Helpmonks/Managani data, Stripe financial records, infrastructure backups, and offline desktop copies are outside this purge. Desktop access is revoked; no remote erasure of offline copies is promised. No production deployment or destructive cleanup of existing accounts is performed during installation.

## Private HTTP interface

These endpoints use the admin session cookie, not public API authentication. Mutations send `X-CSRF-Token`. JSON errors contain `error`; unavailable authentication returns 401, forbidden origin/CSRF returns 403, missing resources return 404, and stale account revisions return 409.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/admin/login`, `/admin/logout` | Establish/end admin session |
| GET | `/admin/api/accounts` | `q`, `plan`, `status`, `page`; paginated accounts and counts |
| POST | `/admin/api/accounts` | `name`, `owner_name`, `owner_email`; create account |
| GET / PUT | `/admin/api/accounts/:id` | Detail/update; PUT accepts `revision`, names/email, `is_active`, `override` |
| DELETE | `/admin/api/accounts/:id` | `{ confirmation: accountId }`; queue purge, HTTP 202 |
| GET | `/admin/api/accounts/:id/deletion` | Current row/progress or `{ deleted: accountId }` |
| POST | `/admin/api/accounts/:id/deletion/retry` | Requeue failed cleanup, HTTP 202 |
| GET | `/admin/api/users.csv` | User membership export |
| GET | `/admin/api/accounts/new/form`, `/admin/api/accounts/:id/form` | Pug form fragments |
| GET | `/admin/api/email-templates/:key/form` | Template form fragment |
| PUT | `/admin/api/email-templates/:key` | Save `subject` and `text` |
| POST | `/admin/api/email-templates/:key/preview` | Render supplied subject/text with example variables |
| POST | `/admin/api/email-templates/:key/test` | Send saved template to `email` |
| POST | `/admin/api/email-templates/:key/reset` | Restore default |
| GET | `/admin/api/settings` | Masked integration settings, custom code, configuration status |
| PUT | `/admin/api/settings/managani` | `enabled`, `base_url`, `site_key`, optional `site_secret` / `clear_site_secret` |
| PUT | `/admin/api/settings/custom-code` | `js`, `css`, `origins` |
| GET | `/admin/api/audit-logs` | `account`, `actor`, `action`, `result`, `from`, `to`, `page` |

Account mutation responses include `id`, `revision`, `account`, and a server-rendered row `html`. The UI applies only that row and ignores stale/deleted-record responses. Account overrides use `{ plan: null | "free" | "pro" | "team", limits: { people, snippets, libraries, machines } }`, where each limit is null or a non-negative integer.
