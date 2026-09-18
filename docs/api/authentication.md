# Authentication

Create a named token in **Settings → Apps Access → Access Tokens**. Hosted API access requires an active Pro trial, Pro, or Team account; self-hosted installations are unrestricted. Personal tokens do not expire and receive every API scope, while account and library permissions still apply. Copy the secret once and send `Authorization: Token <token>`. No query-string credentials are accepted. OAuth clients register dynamically at `/integrations/register`, or account owners and admins can pre-register public or `client_secret_post` clients in Settings. Every client uses Authorization Code with S256 PKCE and the exact `/api/v3` resource. Discovery is at `/.well-known/oauth-authorization-server`. OAuth access lasts 15 minutes; grants last 90 days. Refresh-token reuse revokes the grant.


OAuth clients request scopes explicitly. Available scopes are `content:read`, `content:write`, `sharing:write`, `trash:purge`, `team:read`, `team:write`, `devices:read` and `devices:write`. MCP also requires `content:read` for connection discovery. Revoking a token, authorized app or registered client invalidates its access and delegated tokens immediately.

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
