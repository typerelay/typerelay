## Read current library details

Retrieve a library when you need its current name, sharing configuration, revision and permissions. This endpoint describes the library itself; use the separate snippet-list operation when you need its contents. Keeping those concerns separate is useful for a library settings screen or an integration that lets users choose a collection before loading snippets.

Start from an ID returned by [list libraries](/api/operations/list_libraries). The response's permission fields describe whether the current user can read, edit or manage the library. Do not assume that every readable shared library is editable, or that a previous permission check remains valid after a team administrator changes access.

## Prepare an edit or transfer

Read the current revision before changing library settings or preparing a snippet write that requires a library base revision. If another client changes the library first, handle the conflict using [API workflows](/api/workflows) rather than reusing an old revision indefinitely.

For a portable copy, choose [YAML export](/api/operations/export_library) or [bundle export](/api/operations/export_library_bundle) according to whether the library includes binary images. Neither export changes sharing. The [libraries and sharing guide](/guide/libraries) explains private and shared collections and helps you present access choices accurately to users of your integration.
