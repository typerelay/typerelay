---
title: "TypeRelay API workflows"
description: "Build reliable TypeRelay API workflows with cursor pagination, revision checks, idempotent operation IDs, imports, Trash, and conflict handling."
---

# Workflows

List libraries, then list snippets by library ID. Lists return `items` and `next_cursor`; send that cursor with the next request and a limit from 1 to 100. Snippets include position for display ordering. Search matches abbreviation, title and content.

Persist `operation_id` before a mutation. Retry the identical operation with the same ID; changing its payload returns 409. Read current revisions before writing. Snippet changes require the library base revision and, for edits, the snippet revision. Concurrent edits can return conflict IDs without replacing either version. Moves require edit access to both libraries and preserve snippet identity.

Imports use preview followed by commit with selected entry keys and optional corrected triggers. Ordinary removal uses Trash. Purge is explicit and requires its own scope. All accepted changes enter the existing desktop change log.

## Example: show an approved reply

Begin with [list libraries](/api/operations/list_libraries) and let the user choose a library they can access. Request its snippets and display their titles and abbreviations. When a user selects a reply, [get the snippet](/api/operations/get_snippet) by its library and snippet IDs. Preserve its content type so a code example is not treated as an executable command or a rich reply reduced to an unrelated preview field.

Follow each returned cursor until `next_cursor` is null. A short first page is not a substitute for checking the cursor, and a single page is not a complete inventory when another cursor is present. Keep display ordering separate from record identity.

## Example: edit content safely

Read the selected library and snippet immediately before preparing an edit. Save the intended request and its operation ID together. Submit the revisions required by the endpoint, then use the server response as the result of the change. If the connection drops, repeat the identical request rather than constructing a second edit from memory.

When another client has changed the record, review the latest state or returned conflicts. This matters for [shared libraries](../guide/libraries), where several authorized people may be maintaining the same replies.

## Example: transfer a library

Choose [YAML export](/api/operations/export_library) for supported text content without binary images. Choose a [library bundle](/api/operations/export_library_bundle) when images must travel with rich snippets. Importing creates private libraries; it is not an update to the source library or a replacement for synchronization. Review the [import and export guide](../guide/imports) before selecting a format, and handle failures using [errors and limits](./errors).
