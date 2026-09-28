## Refresh an intentionally cached image

Use this operation when you want Typerelay to retrieve a cached image's recorded remote source again. It requires `content:write` and an existing asset with remote-source metadata. An ordinary upload without a source URL cannot be refreshed this way and returns a conflict indicating that no remote source is available.

The service uses the most recently recorded source URL and applies the same public-host, image-type and size checks as [cache remote asset](/api/operations/cache_remote_asset). A previously valid URL may now be unavailable, redirect elsewhere or return unsupported content, so treat refresh failure as a recoverable result rather than assuming the image changed successfully.

## Compare the returned identity

Asset IDs identify normalized bytes. If the remote image has changed, the returned asset ID can differ from the one you requested. Inspect the response and deliberately update any snippet references that should use the new image. Refreshing the cache does not itself rewrite every snippet that references the older asset.

Use [get asset metadata](/api/operations/get_asset_metadata) to inspect the stored image and its source information before refreshing. For a full library transfer with images, use [bundle export](/api/operations/export_library_bundle) instead of refetching each remote source. The [rich-text guide](/guide/snippets#rich-text) explains how cached images remain separate from the snippet's saved Markdown.
