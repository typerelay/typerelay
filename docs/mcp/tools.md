---
title: "TypeRelay MCP tools"
description: "Reference TypeRelay MCP tools for libraries, snippets, rich-text assets, imports, exports, search, teams, devices, conflicts, and account identity."
---

# Tools

Tools call the public API and preserve its permissions and revisions.

- [list_libraries](/api/operations/list_libraries) — List libraries (`content:read`).
- [get_library](/api/operations/get_library) — Get library (`content:read`).
- [create_library](/api/operations/create_library) — Create private library (`content:write`).
- [update_library](/api/operations/update_library) — Rename library or update sharing (`sharing:write`).
- [list_snippets](/api/operations/list_snippets) — List snippets (`content:read`).
- [get_snippet](/api/operations/get_snippet) — Get snippet (`content:read`).
- [create_snippet](/api/operations/create_snippet) — Create snippet (`content:write`).
- [update_snippet](/api/operations/update_snippet) — Edit snippet (`content:write`).
- [batch_snippets](/api/operations/batch_snippets) — Move or trash snippets atomically (`content:write`).
- [search_snippets](/api/operations/search_snippets) — Search accessible snippets (`content:read`).
- [get_asset_metadata](/api/operations/get_asset_metadata) — Get rich-text asset metadata (`content:read`).
- [export_library](/api/operations/export_library) — Export library as YAML (`content:read`).
- [preview_import](/api/operations/preview_import) — Preview import (`content:write`).
- [commit_import](/api/operations/commit_import) — Import into new private libraries (`content:write`).
- [list_trash](/api/operations/list_trash) — List accessible Trash (`content:read`).
- [change_trash](/api/operations/change_trash) — Trash or restore an item (`content:write`).
- [purge_item](/api/operations/purge_item) — Permanently purge a trashed item (`trash:purge`).
- [empty_trash](/api/operations/empty_trash) — Permanently purge an explicit Trash selection (`trash:purge`).
- [list_conflicts](/api/operations/list_conflicts) — List editable conflicts (`content:write`).
- [resolve_conflict](/api/operations/resolve_conflict) — Resolve conflict (`content:write`).
- [get_operation](/api/operations/get_operation) — Get operation receipt (`content:read`).
