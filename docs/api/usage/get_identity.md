## Confirm the connected account

Call integration identity near the beginning of an API connection to check which user, account and scopes the credential represents. This is useful when someone has configured multiple accounts or is diagnosing why an integration cannot see an expected library.

The response contains `user`, `account` and `scopes`. Use these fields to understand the current authorization context. Do not infer access to every library from a successful identity response: individual operations still enforce account and library permissions.

## Validate a read-only workflow first

After checking identity, [list accessible libraries](/api/operations/list_libraries) and retrieve a known entry. This establishes that the integration is connected to the intended content before it performs edits, imports or sharing changes. If a library is absent, review the user's access rather than attempting IDs from another account.

Use the [authentication guide](/api/authentication) to select OAuth or a personal token and understand resource binding. This API endpoint is distinct from MCP discovery and is not exposed as a content tool in the [MCP tool list](/mcp/tools). For invalid or expired credentials, follow [errors and limits](/api/errors). Avoid logging authorization headers when diagnosing a connection; the returned account and scope information is usually a more appropriate starting point.
