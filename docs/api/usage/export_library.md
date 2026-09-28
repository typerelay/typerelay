## Export text for review or transfer

Use YAML export when you need a readable representation of a library's supported textual content. The response is JSON with a `yaml` field; save that field's text as the export file rather than writing the entire JSON response into a YAML file.

Select a library the connected user can read. If your integration starts from a library picker, use [list libraries](/api/operations/list_libraries) to discover accessible IDs. Names are display labels and should not replace the library ID in the request.

## Choose YAML or a bundle

YAML is suitable for Text, Code, templates and rich content without binary images. A rich library with images needs a [Typerelay bundle](/api/operations/export_library_bundle) to carry the image data with the snippets. Review [import and export](/guide/imports) before choosing a format, especially when transferring content between different tools.

An exported file is a separate copy. Editing it does not update the server, enroll a local library for sync or change another user's collection. To bring supported changes back through the ordinary import workflow, preview the source and commit the selected entries into new private libraries. For a deliberate edit to an existing record, use its edit operation with current revisions instead. The [workflow guide](/api/workflows) explains these separate paths.
