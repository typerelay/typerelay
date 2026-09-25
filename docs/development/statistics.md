# Usage statistics implementation

Internal authenticated client endpoints under `/api/v2`:

- `POST /statistics/events`: `{ identity?, events }`, batches up to 100. Optional identity binds account/user; authentication is authoritative. Events carry `event_id`, `library`, `snippet`, `action` (`copy`/`insert`), `client`, `occurred_at`, `characters`, and `shared`. Returns `accepted` and `discarded` event IDs. Clients acknowledge only these IDs.
- `GET /statistics`: `scope=personal|team`, `range=7|30|90|all|custom`, `timezone`, and inclusive `start`/`end` dates for custom ranges. Returns settings, totals, daily/snippet/library/member groups, and Pug row fragments.
- `GET /statistics/export`: same filters, CSV response.
- `PATCH /statistics/preferences`: `scope`, `wpm`, `hourly_rate`, `currency` (ISO 4217). Defaults: 50, 30, USD.

MongoDB usage IDs are unique within account/user. Native SQLite adds an independent `usage_events` outbox, keyed by server/account/user. Sync protocol remains 6; upgraded sync responses add `statistics_identity`, without tokens. Older servers/clients remain compatible. Browser extension storage keeps one key per event; web storage namespaces events by user/account on the server origin. Mobile keyboards write atomic content-free event files in shared storage; the containing app imports them idempotently before synchronization.

Data ingestion uses the account deletion fence and existing library permissions. Account deletion includes both new collections. Team reports exclude current private libraries even if their events were originally shared. Raw events remain for historical reports; no pre-update backfill.

## Verification

Backend: `node --test test/statistics.test.js test/admin.test.js` in the server environment. On NadaMini use `dbh-run compose -- exec -T app node --test test/statistics.test.js test/admin.test.js`.

Native: `cargo test --workspace`. Extension queue: `node --test apps/extension/test/usage.test.js`.

Frontend regression test provided for user execution: from `apps/server`, `node --test test/statistics-ui.test.js`. It asserts item-level updates preserve surrounding DOM and unchanged rows, and remove stale records without reloads.

Manual checks: single/multiple-team toolbar; create library and rename team; copied versus inserted usage on every client; offline/restart/reconnect; account switching; private/team permission boundaries; default and saved rates; timezone dates; CSV; narrow layouts and keyboard navigation. No production deployment is part of this change.
