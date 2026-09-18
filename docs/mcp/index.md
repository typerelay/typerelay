# Overview

TypeRelay MCP is an adapter over the public API. Content workflows never access the database directly; MongoDB is used only for distributed concurrency leases. It uses stateless Streamable HTTP; no WebSocket or SSE server is needed.

Defaults per minute are 300 requests per IP, 30 requests without credentials, 120 authenticated requests and 30 heavy tool calls. Each credential may run three ordinary tools concurrently or one import, export, batch or Trash tool. Rate-limited requests return HTTP 429; tool-level limits return an MCP error result.
