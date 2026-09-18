# Setup

Configure the exact Streamable HTTP resource URL and use OAuth sign-in or a personal access token. Hosted MCP access requires an active Pro trial, Pro or Team account. Self-hosted installations are unrestricted.

For development, the MCP endpoint and protected-resource metadata are:

```text
http://localhost:3041/mcp
http://localhost:3041/.well-known/oauth-protected-resource/mcp
```

Production requires HTTPS. The protected-resource document advertises the TypeRelay application origin as its authorization server. That origin exposes:

```text
https://app.example.com/.well-known/oauth-authorization-server
https://app.example.com/integrations/register
https://app.example.com/integrations/authorize
https://app.example.com/integrations/token
```

Use the exact MCP endpoint, including `/mcp`, as the OAuth `resource` value. Compatible clients can register dynamically. Owners and admins can also pre-register public or `client_secret_post` clients under **Settings → Apps Access → OAuth**. Every OAuth client uses Authorization Code with S256 PKCE. MCP OAuth connections need at least `content:read`; requested scopes determine the available tools.

For clients without OAuth, create a personal token under **Settings → Apps Access → Access Tokens** and supply it privately as `Authorization: Token <token>`. The permanent, full-scope secret is shown once. Account permissions still restrict every tool call.

Revoke a personal token or authorized app from **Settings → Apps Access**. Revocation stops new MCP calls immediately. Deleting a pre-registered client revokes all of its account grants. See [API authentication](../api/authentication) for scopes, token lifetimes and the API discovery endpoint.
