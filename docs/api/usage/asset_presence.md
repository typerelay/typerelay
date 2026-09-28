## Check assets before transferring content

Use this operation to find which rich-text images are already available in the authenticated account. A snippet stores asset references separately from the binary image data. Checking presence helps an integration avoid uploading the same normalized image repeatedly when several snippets use it.

Send an `ids` array containing up to 1,000 asset hashes. Each ID is a 64-character lowercase hexadecimal value. The response separates available asset metadata in `assets` from unknown IDs in `missing`; repeated input IDs are deduplicated. Treat missing IDs as missing in this account, not as evidence that an image does not exist anywhere else.

## Use the result

Compare the returned IDs with the references needed by your rich snippets. Retrieve existing images with [download asset](/api/operations/download_asset), or upload image bytes through [upload asset](/api/operations/upload_asset). Keep the returned normalized ID when uploading, because the stored representation can differ from the original file.

Presence checking does not create an asset, attach an image to a snippet or modify content. Although this endpoint uses POST to accept the ID list, it is a read operation and requires `content:read`. See [rich-text snippets](/guide/snippets#rich-text) for the content model and [authentication](/api/authentication) for credential setup.
