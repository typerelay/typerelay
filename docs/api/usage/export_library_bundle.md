## Package a rich library with its images

Choose a Typerelay bundle when reusable content includes binary images that need to travel with the snippets. The bundle is a ZIP file containing a manifest and deduplicated image assets. It preserves supported rich Markdown, raw HTML, variables, asset hashes and remote-source metadata.

Request the bundle for an accessible library ID with `content:read`. The successful response is `application/zip`, so handle it as binary data rather than parsing it as JSON. Keep the downloaded bytes intact and use a recognizable `.typerelay.zip` filename when offering the file to a user.

## Plan the destination workflow

A bundle is a transfer snapshot, not a live connection to the original library. Content changes made after export are not automatically added to the file. Use [synchronization](/guide/sync) when the goal is to keep devices current, and an export when the goal is a portable copy.

To bring a bundle into an account, follow [import library bundle](/api/operations/import_library_bundle). Imported content creates private libraries rather than overwriting a matching name. Review the destination collection before sharing it with a team. If there are no binary images to transfer, [YAML export](/api/operations/export_library) may be a simpler readable option. The [import and export guide](/guide/imports) compares the formats.
