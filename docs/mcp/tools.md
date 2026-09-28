---
title: "TypeRelay MCP tools"
description: "Reference TypeRelay MCP tools for libraries, snippets, rich-text assets, imports, exports, search, teams, devices, conflicts, and account identity."
---

# Tools

Tools call the public API and preserve its permissions and revisions.

## Choose a tool for the task

Start with library discovery and snippet search when an assistant needs approved wording. `list_libraries` identifies the collections available to the connected user, while `search_snippets` finds matching content. Retrieve the selected snippet before using its saved value, especially when the result could be confused with another similarly titled entry.

For edits, use the current library and snippet revisions required by the operation. Save an operation ID with the exact intended mutation before sending it. A timeout does not prove that the edit failed; an identical retry must reuse the original ID. Read [API workflows](../api/workflows) for the sequence and conflict handling.

## Understand scope and permission checks

Each entry below identifies its required scope. Read access does not grant edit access, and content editing does not grant permanent-purge permission. The connected user's library permissions remain in force even when the credential has a broad set of scopes. Consult [MCP setup](./setup) to choose OAuth or a personal token and review [agent configuration](./agents) before enabling changes.

The list is generated from the API operation catalog and contains the operations exposed as MCP content tools. The REST API includes additional endpoints, so an API reference page does not by itself mean a matching MCP tool is available.

## Available content tools

<!--@include: ./tools-list.md-->

## Use recovery tools carefully

Trash and restore are distinct from permanent deletion. Review the selected records and their current revisions before acting, and use the dedicated purge scope only for deliberate permanent removal. The [Trash guide](../guide/trash) explains recovery behavior. For examples of organizing the content an assistant can retrieve, read [shared snippet libraries for teams](https://typerelay.com/blog/shared-snippet-library-for-teams-one-source-always-current/).
