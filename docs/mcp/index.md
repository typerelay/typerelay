---
title: "TypeRelay MCP server"
description: "Connect AI clients to the TypeRelay MCP server for authenticated snippet and library workflows over stateless Streamable HTTP."
---

# Overview

TypeRelay MCP is an adapter over the public API. Content workflows never access the database directly; MongoDB is used only for distributed concurrency leases. It uses stateless Streamable HTTP; no WebSocket or SSE server is needed.

Connect to the exact `/mcp` resource with OAuth or a permanent personal token. OAuth clients discover the authorization server through the MCP protected-resource metadata endpoint; TypeRelay keeps MCP and API access tokens bound to their respective resources. See [Setup](./setup) for current endpoints and [Tools](./tools) for the scope required by each operation.

Defaults per minute are 300 requests per IP, 30 requests without credentials, 120 authenticated requests and 30 heavy tool calls. Each credential may run three ordinary tools concurrently or one import, export, batch or Trash tool. Rate-limited requests return HTTP 429; tool-level limits return an MCP error result.

## Give assistants access to reusable content

MCP lets a compatible assistant discover Typerelay tools for browsing libraries, searching snippets and working with saved content. For example, an assistant can find an approved reply in a shared library before helping draft a response. The content remains subject to the connected user's permissions; connecting a client does not make private libraries available to everyone.

Begin with a read-only use case and grant the scopes it needs. Searching and retrieving content is a useful first check before enabling edits or imports. The [tool reference](./tools) links each supported tool to its API operation, including its required scope and request fields.

## Connect and check the workflow

Follow [MCP setup](./setup) for OAuth discovery or personal-token configuration. Use the MCP resource URL exactly as configured, including `/mcp`. API and MCP tokens have different resource bindings, so credentials intended for one interface should not be assumed to work on the other.

Once connected, ask the client to list accessible libraries and retrieve a known snippet. Confirm that it is using the intended account and content before allowing changes. Use the [agent configuration guide](./agents) to establish how the assistant handles revisions, retries and destructive actions.

## Keep people in control of shared wording

An assistant may help prepare an edit, but your team still needs an owner for approved text. Review changes to customer-facing replies before distributing them through a shared library. The [shared snippet library article](https://typerelay.com/blog/shared-snippet-library-for-teams-one-source-always-current/) explains that editorial workflow; the [API workflows](../api/workflows) explain the technical safeguards that preserve revisions when clients edit concurrently.
