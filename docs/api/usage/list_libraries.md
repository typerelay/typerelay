## Discover the content you can access

List libraries to build a library picker or begin a snippet-reading workflow. The response includes accessible library records for the authenticated context. Private content belonging to someone else should not be assumed to appear simply because your integration has a valid token.

Use each library's ID for subsequent requests and its name for display. Permission fields help distinguish reading, editing and managing access. Shared libraries may be readable without allowing content edits, so base available actions on the returned permissions rather than a single shared flag.

## Read every page when needed

The endpoint returns `items` and `next_cursor`. Send the returned cursor to request another page, using a limit between 1 and 100. Continue until `next_cursor` is null when your workflow needs the complete collection. Keep the cursor opaque rather than trying to manufacture one from an ID or list position.

After selection, call [get library](/api/operations/get_library) for current details or list that library's snippets. Before writing, refresh the relevant revisions rather than treating an earlier inventory as current forever. The [API workflow guide](/api/workflows) explains reading and editing sequences, and [libraries and sharing](/guide/libraries) explains the organization users see in Typerelay. For team-wide content planning, keep approved shared replies separate from personal shortcuts.
