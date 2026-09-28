---
title: "TypeRelay API"
description: "Use the TypeRelay REST API to manage libraries, snippets, rich-text assets, imports, teams, devices, conflicts, search, and account identity."
---

# Overview

The public API uses `/api/v3`. Existing web routes and desktop sync protocol 6 remain separate. See [Authentication](./authentication), [Workflows](./workflows), and generated OpenAPI operations in the sidebar. Download the [OpenAPI definition](../openapi.json).

## What you can build

Use the REST API to make reusable content available inside your own tools. An integration can browse accessible libraries, retrieve a saved reply, search snippets, or import an existing collection. Library permissions still apply: a credential does not give its holder access to another person's private content. Read [libraries and sharing](../guide/libraries) before designing a team integration.

Start with a read-only workflow. Authenticate against your deployment, call [integration identity](/api/operations/get_identity) to check the account and granted scopes, then [list libraries](/api/operations/list_libraries). Use the selected library ID to retrieve its snippets. Titles are useful for display; IDs identify the records your integration acts on.

## Move from reading to writing

Writes need the appropriate scope and current permissions. Fetch current revisions before editing, and save an operation ID before sending a mutation. An identical retry reuses that ID; a changed request needs a deliberate new operation. The [workflow guide](./workflows) explains pagination, concurrent edits and import sequencing.

Handle failures according to their meaning. An expired credential needs authentication, a permission failure needs access review, and a revision conflict needs fresh state. Repeating every failed request can make a recoverable problem harder to understand. See [errors and limits](./errors) for response codes and retry guidance.

## Choose an integration interface

The API reference provides request bodies, response schemas and endpoint-specific guidance. Use the [MCP server](../mcp/) when a compatible AI client should discover tools instead of issuing HTTP requests itself. Both interfaces respect the same content permissions. For examples of the content these integrations can reuse, see the [Typerelay feature overview](https://typerelay.com/features/).
