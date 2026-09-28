## Upload an image for reusable rich content

Send supported PNG, JPEG, WebP or GIF image bytes to this endpoint with the matching image content type. The body is the image itself, not a JSON object or a base64 field inside a snippet. The operation requires `content:write` in the destination account.

Typerelay validates and normalizes image data before storing it. Input is limited to 5 MiB and the normalized asset to 2 MiB. Still images are resized within the supported dimensions and may change format during normalization. The response describes the stored representation, including its ID, MIME type, byte size and dimensions.

## Save the returned reference

Use the returned asset ID when saving rich content. Do not calculate a hash from the original upload and assume it will identify the normalized bytes. Uploading an image stores an asset; it does not create a snippet or insert an image into an existing snippet automatically.

Use [asset presence](/api/operations/asset_presence) to check known hashes before transferring repeated assets, or [cache remote asset](/api/operations/cache_remote_asset) when the source is a public image URL. For a library containing several rich snippets and images, consider a [Typerelay bundle](/guide/imports) so the content and assets travel together. Read [rich-text snippets](/guide/snippets#rich-text) before constructing the saved Markdown and references.
