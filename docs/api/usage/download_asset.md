## Retrieve image bytes for rich content

This operation returns the normalized binary image associated with an asset ID. Use it when rendering or transferring a rich snippet whose content refers to an image stored in Typerelay. The response is image data, not a JSON metadata document or a public share link.

Authenticate with `content:read` in the account holding the asset. Knowing a hash is not a substitute for authentication. Keep credentials in your HTTP client rather than putting them into a URL that could be copied, logged or exposed through a page.

## Process the response correctly

Check the HTTP status before reading the body as an image. Use the response content type when saving or displaying the bytes; the normalized image may not retain the source file's format. For image dimensions, byte size or source information without downloading the image, call [get asset metadata](/api/operations/get_asset_metadata).

If you are preparing a group of images, [asset presence](/api/operations/asset_presence) identifies missing IDs in a single request. If you are moving an entire library, [export library bundle](/api/operations/export_library_bundle) packages the content and images together. This avoids treating individual image downloads as a complete library backup. See [import and export](/guide/imports) for format choices and the difference between a transfer file and synchronized content.
