## Retrieve the selected snippet

Use this operation after choosing a snippet from a library listing or search result. Supply both its library ID and snippet ID. The returned record includes the saved value together with identity, position, revision and state information needed by an integration.

Treat the title as a display label and the trigger as the abbreviation. A snippet can remain useful without a trigger because users can find and copy it through search. Preserve the content type when displaying or transferring the value: Text and Code are literal text, while rich content uses Markdown and separate asset references.

## Work with the full content model

Do not execute saved code merely because an integration retrieved it. For variable-powered content, read [template variables](/guide/templates) before implementing any fill behavior. For rich images, use [asset metadata](/api/operations/get_asset_metadata) and the asset download operation as needed; image bytes are not embedded directly into the snippet record.

Before editing, obtain current library and snippet revisions and include the fields required by the edit endpoint. A retrieved record is a snapshot, so another authorized client may change it before your write arrives. Follow [API workflows](/api/workflows) for conflict and retry handling. The [snippet guide](/guide/snippets) explains the user-facing differences between Text, Code and Rich text.
