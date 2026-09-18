# Overview

TypeRelay MCP is an adapter over the public API. Content workflows never access the database directly; MongoDB is used only for distributed concurrency leases. It uses stateless Streamable HTTP; no WebSocket or SSE server is needed.

Connect to the exact `/mcp` resource with OAuth or a permanent personal token. OAuth clients discover the authorization server through the MCP protected-resource metadata endpoint; TypeRelay keeps MCP and API access tokens bound to their respective resources. See [Setup](./setup) for current endpoints and [Tools](./tools) for the scope required by each operation.

Defaults per minute are 300 requests per IP, 30 requests without credentials, 120 authenticated requests and 30 heavy tool calls. Each credential may run three ordinary tools concurrently or one import, export, batch or Trash tool. Rate-limited requests return HTTP 429; tool-level limits return an MCP error result.
