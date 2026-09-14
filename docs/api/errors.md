# Errors and limits

Errors return `{ "error": "message" }` and may include stable `code` and `details` fields. `plan_required` is a 403 with the unavailable capability and upgrade URL. `plan_limit` is a 409 with resource, limit, usage, and upgrade URL. Other statuses: 400 invalid request; 401 invalid/expired authentication; 403 scope or permission; 404 unavailable resource; 409 revision or retry mismatch; 410 permanently removed/expired Trash; 422 validation; 429 rate limit.

The API permits 300 requests per credential per minute; inspect rate-limit headers and honor Retry-After. Imports retain the existing 8 MiB source and 1,000-entry limits. A 409 requires reviewing authoritative state, not choosing a new operation ID to blindly repeat a stale edit.
