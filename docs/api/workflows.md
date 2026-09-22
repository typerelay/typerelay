---
title: "TypeRelay API workflows"
description: "Build reliable TypeRelay API workflows with cursor pagination, revision checks, idempotent operation IDs, imports, Trash, and conflict handling."
---

# Workflows

List libraries, then list snippets by library ID. Lists return `items` and `next_cursor`; send that cursor with the next request and a limit from 1 to 100. Snippets include position for display ordering. Search matches abbreviation, title and content.

Persist `operation_id` before a mutation. Retry the identical operation with the same ID; changing its payload returns 409. Read current revisions before writing. Snippet changes require the library base revision and, for edits, the snippet revision. Concurrent edits can return conflict IDs without replacing either version. Moves require edit access to both libraries and preserve snippet identity.

Imports use preview followed by commit with selected entry keys and optional corrected triggers. Ordinary removal uses Trash. Purge is explicit and requires its own scope. All accepted changes enter the existing desktop change log.
