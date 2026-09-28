---
title: "TypeRelay API errors and limits"
description: "Handle TypeRelay API validation, authentication, authorization, plan, revision, rate-limit, import, and permanent-removal errors safely."
---

# Errors and limits

Errors return `{ "error": "message" }` and may include stable `code` and `details` fields. `plan_required` is a 403 with the unavailable capability and upgrade URL. `plan_limit` is a 409 with resource, limit, usage, and upgrade URL. Other statuses: 400 invalid request; 401 invalid/expired authentication; 403 scope or permission; 404 unavailable resource; 409 revision or retry mismatch; 410 permanently removed/expired Trash; 422 validation; 429 rate limit.

The default API window is one minute: 120 requests per credential, with additional limits of 60 expensive export/batch/Trash requests and 20 import or bulk-library uploads. Inspect rate-limit headers and honor `Retry-After`. Imports retain the existing 8 MiB source and 1,000-entry limits. A 409 requires reviewing authoritative state, not choosing a new operation ID to blindly repeat a stale edit.

## Diagnose the response before retrying

Keep the HTTP status, error message and any returned code together in your application logs. Do not log authorization headers or private snippet bodies. A useful error report identifies the operation and the resource involved without exposing the content the user was trying to retrieve.

For a 401, check the token, its expiry and the intended API resource using the [authentication guide](./authentication). For a 403, review both the credential's scopes and the user's current library permissions. A valid token can still lack permission to perform a particular action. Hosted plan errors should lead the user to the returned upgrade information rather than an automatic retry loop.

## Recover from concurrent edits

A revision mismatch means your client may be working from an old copy. Fetch the library or snippet again, compare the intended change with the current value, and decide whether the edit still makes sense. If the response supplies conflict IDs, use the conflict workflow instead of silently overwriting another edit.

Persist the original operation ID and payload until the outcome is known. After a timeout, retry that same request with the same ID. Do not change an operation ID simply to bypass a 409. See [API workflows](./workflows) for the read, edit and retry sequence.

## Report unavailable content clearly

A missing or permanently removed item should not remain selectable as though it were active. Explain that it is unavailable and refresh the affected record in your integration. For user-facing recovery choices, follow the [Trash guide](../guide/trash); permanent removal is different from a reversible move to Trash.
