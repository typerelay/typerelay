---
title: "First-party AI API"
description: "AI configuration, model verification, draft proposals, search references, and allowance enforcement."
---

# First-party AI API

These endpoints use a signed-in web session or first-party desktop/mobile/browser device token. They are separate from public REST/MCP integration scopes.

The authenticated OpenAPI specification is **GET /api/v2/ai/openapi.json**. Web requests require **X-Account-Id**; web mutations also require **X-CSRF-Token**. Device requests require bearer authentication and **X-TypeRelay-Sync-Protocol: 6**.

| Method | Endpoint under /api/v2/ai | Purpose |
|---|---|---|
| GET | /settings | Effective policies, models, allowance |
| GET | /settings?scope=personal | Private settings and Pug fragment |
| GET | /settings?scope=team | Owner/admin team settings and fragment |
| PATCH | /settings | Save policy and workflow routes |
| POST | /connections | Create/update encrypted connection |
| DELETE | /connections/{id} | Remove scoped connection |
| POST | /models | Discover models with saved credentials |
| POST | /verify | Verify selected model |
| POST | /author | Return validated, unsaved proposal |
| POST | /search | Return existing snippet references |

Settings/connection mutations accept a **revision**; stale revisions return 409. Missing update IDs return 404 instead of recreating removed connections. Responses contain masked key status.

Settings PATCH requests preserve omitted fields. Installation endpoint approvals can be saved independently from policy, allowance, and workflow defaults; provide **private_endpoints** as a newline-separated string to update them, or an empty string to clear them.

Authoring accepts **request_id**, **action**, **prompt**, snippet **entry**, and optional editable **library**. Apply the proposal to the editor, then save through normal snippet mutations.

Search accepts **request_id**, **query**, optional synced **libraries**, and explicitly selected **local** records. A local record has **id**, **library**, **revision**, and **text**, with optional title, trigger, and library name. Limit local input to 8 MiB and 20,000 records.

Results have **source**, **id**, **library**, **revision**, title, library name, abbreviation, and preview. Revalidate local revisions before use. The server checks current permissions and revisions before returning synced references.

Action metadata is retained for three days. Replayed action IDs return 409 without another generation. Managed reservations are atomic per account/user/UTC day. Discovery/verification do not consume workflow allowance. Generation, discovery, and verification are limited to twenty requests per minute per account/user.

Policy revisions in status responses let clients discard older HTTP responses. Keep local opt-out separate from synced policy. Abort or discard pending results after query, editor, identity, or policy changes.

Equivalent installation configuration endpoints use **/admin/api/ai** under the existing system-admin session/CSRF checks. Installation settings additionally contain **daily_limit** and the newline-separated self-hosted **private_endpoints** allowlist.

See [AI workflows and setup](../guide/ai).
