## Inspect an image without downloading it

Use asset metadata when an integration needs to identify or describe an image referenced by rich content. The response contains the asset ID, MIME type, stored byte size, dimensions, animation flag and any recorded source URLs. It does not contain the image bytes.

Metadata describes the stored, normalized image. Do not assume it has the same dimensions or format as the original upload. Typerelay keeps image data separate from the snippet's Markdown so repeated references can reuse an asset instead of embedding duplicate base64 content.

## Choose the next operation

Use the size and dimensions to prepare an image preview, then call [download asset](/api/operations/download_asset) if the actual bytes are needed. To check a collection of hashes together, use [asset presence](/api/operations/asset_presence). Both operations remain scoped to the authenticated account.

A source URL records where a cached image came from; it does not guarantee that the remote resource is still reachable or unchanged. Use [refresh remote asset](/api/operations/refresh_remote_asset) for an intentional refresh and inspect the returned identity before updating content. An image uploaded without a remote source cannot be refreshed from a URL it never had. Read the [rich-text guide](/guide/snippets#rich-text) for how normalized assets relate to snippet content and exports.
