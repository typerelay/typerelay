## Import a complete rich-content transfer

Use this endpoint for a Typerelay ZIP bundle that includes snippet content and image assets. Send the original binary archive with `Content-Type: application/zip`. Do not wrap the bytes in a JSON object or convert the archive into a text string.

Supply `X-Operation-Id` before sending the request. Persist that ID with the original archive so an uncertain result can be retried as the same operation. The header carries the retry identity because the request body is the ZIP file, not the JSON mutation envelope used by other operations.

## Review the imported collection

Imports create private libraries and do not replace an existing library simply because it has the same name. After success, use the returned library information to locate the imported content and inspect the snippets before sharing them. Preserve the bundle's image data so rich snippets have their referenced assets available.

Use [export library bundle](/api/operations/export_library_bundle) to create a compatible transfer from an existing library. For supported textual imports and vendor formats, see the separate preview-and-commit workflow in [API workflows](/api/workflows) and the [import guide](/guide/imports). Do not assume that a bundle upload accepts a vendor ZIP archive. If the request fails, inspect the returned error before choosing a new operation ID or resubmitting modified content.
