# Authentication

Hosted API access requires an active Pro trial, Pro or Team account. Self-hosted installations are unrestricted. TypeRelay accepts personal access tokens and OAuth 2.0 access tokens in the `Authorization` header; query-string credentials are not accepted.

## Personal access tokens

Create a named token under **Settings → Apps Access → Access Tokens**. Every personal token is permanent and receives the complete current API scope set. Account roles and library permissions still apply.

The `tr_pat_…` secret is shown only in the creation confirmation. Copy it before dismissing that message; TypeRelay stores only its hash and cannot display it again. Delete the token and create another if the secret is lost or exposed. Deletion stops authentication immediately. See [Settings](../guide/settings#access-tokens-and-oauth) and [MCP setup](../mcp/setup) for the same credential in other clients.

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

## OAuth clients

OAuth clients use Authorization Code with S256 PKCE. Dynamic clients register at `/integrations/register`. Account owners and admins can instead create account-bound clients under **Settings → Apps Access → OAuth**. Pre-registered clients can be public (`none`) or confidential (`client_secret_post`); a confidential client secret is displayed once and stored only as a hash.

Redirect URIs must use HTTPS or an IP loopback address. The authorization request and token exchange must use the exact protected resource URL, including `/api/v3`:

```text
http://localhost:3040/api/v3
```

OAuth clients request scopes explicitly. Available scopes are `content:read`, `content:write`, `sharing:write`, `trash:purge`, `team:read`, `team:write`, `devices:read` and `devices:write`. Access tokens last 15 minutes; the authorization grant and rotating refresh token last 90 days. Refresh-token reuse revokes the complete grant.

Users can revoke their grants under **Authorized Apps**. Owners and admins can also delete a pre-registered client, which revokes every grant issued to that client in the account. Either action invalidates refresh and delegated access immediately.

## Discovery endpoints

Replace `http://localhost:3040` with the public TypeRelay application origin:

- Authorization server metadata: `http://localhost:3040/.well-known/oauth-authorization-server`
- API protected-resource metadata: `http://localhost:3040/.well-known/oauth-protected-resource/api/v3`
- Dynamic client registration: `http://localhost:3040/integrations/register`
- Authorization endpoint: `http://localhost:3040/integrations/authorize`
- Token endpoint: `http://localhost:3040/integrations/token`

The authorization server metadata publishes supported scopes, S256 PKCE, grant types and token endpoint authentication methods. A 401 API response also advertises the API protected-resource metadata URL in `WWW-Authenticate`.
