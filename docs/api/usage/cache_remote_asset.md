## Bring a public image into a rich snippet

Use this operation when an image is available at a public URL and you want Typerelay to cache a private, normalized copy for the account. Send a JSON object with a `url` property pointing to the image itself. A web page containing an image is not the same as a direct image URL.

The service accepts public HTTP and HTTPS sources, checks the resolved network addresses and rejects private hosts or credentials embedded in the URL. Redirects are checked too. The source must be a supported PNG, JPEG, WebP or GIF image within the upload limits. Do not use this endpoint to fetch an internal service or a resource requiring a private authentication header.

## Keep the returned asset identity

The response contains normalized metadata, including the asset ID and source URL information. Use the returned asset ID in the rich content you subsequently save; caching an image alone does not edit a snippet. Normalization can change its format, dimensions and bytes.

Use [asset metadata](/api/operations/get_asset_metadata) to inspect the stored image and [refresh remote asset](/api/operations/refresh_remote_asset) when you intentionally want to retrieve its remote source again. If you already have image bytes locally, use [upload asset](/api/operations/upload_asset). The [rich-text guide](/guide/snippets#rich-text) explains how images travel with reusable content.
