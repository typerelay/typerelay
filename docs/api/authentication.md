# Authentication

Create a named token in **Settings → Access tokens**. Select scopes and an expiry of 1–365 days (default 90). Copy it once and send `Authorization: Token <token>`. No query-string credentials are accepted. OAuth clients register at `/integrations/register`, use Authorization Code with S256 PKCE and the exact `/api/v3` resource, and obtain rotating refresh tokens. Discovery is at `/.well-known/oauth-authorization-server`. Access lasts 15 minutes; grants last 90 days. Refresh-token reuse revokes the grant. Account selection is approved in the browser. Scopes never override library permissions.


Read-only access is selected by default. Scopes are `content:read`, `content:write`, `sharing:write`, `trash:purge`, `team:read`, `team:write`, `devices:read` and `devices:write`. MCP also requires `content:read` for connection discovery. Revoking a grant invalidates its access and delegated tokens immediately on the next request.

:::tabs
== Personal token
```fish
# TYPERELAY_TOKEN is supplied through your private environment.
curl --header "Authorization: Token $TYPERELAY_TOKEN" http://localhost:3040/api/v3/libraries
```
== OAuth
```fish
# TYPERELAY_ACCESS_TOKEN is obtained through browser-approved PKCE.
curl --header "Authorization: Bearer $TYPERELAY_ACCESS_TOKEN" http://localhost:3040/api/v3/libraries
```
:::
