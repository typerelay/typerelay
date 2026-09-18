# Import and export

Choose **Import** below the web library list. Every import is previewed before it writes data. Select the entries to keep and correct or clear invalid abbreviations. The server reparses and validates the source when you save; a failed import does not leave partial libraries.

Imports always create private libraries and never replace a matching name. A numeric suffix is added when needed. Up to 1,000 entries, 256 libraries/folders, 20 folder levels and 8 MiB of serialized source may be imported in one operation.

## Formats

| Format | Status | Notes |
| --- | --- | --- |
| TypeRelay bundle | Supported | ZIP manifest plus deduplicated images; preserves rich Markdown, raw HTML, variables, asset hashes and remote-source metadata |
| TypeRelay YAML | Supported | Preserves Text, Rich text without images, Code, Template variables, titles, abbreviations and code language |
| SnippetsLab JSON library export | Supported | Folders become libraries; fragments become separate snippets; tags, smart groups, shortcuts, pinning and notes are omitted with warnings |
| TextExpander CSV | Beta | Requires `abbreviation` and `snippet` headers; optional `label`; native `.textexpander` files are unsupported |
| Text Blaze JSON | Beta | Recognized folder exports; supported HTML becomes Rich text and remote images are cached when committed |
| TypeIt4Me XML | Beta | Recognized XML/plist sets; embedded RTF formatting and PNG/JPEG pictures become Rich text; binary archives remain unsupported |

Beta vendor formats vary between application versions. Review the preview, especially folder names, line breaks and abbreviations.

## Dynamic content

TypeRelay does not execute imported scripts, formulas, macros or vendor commands. Suspected dynamic entries become literal Code snippets, receive **(Needs review)** in the title and import without an abbreviation. Review the literal text, translate it to a [TypeRelay Template](./templates) if appropriate, then assign an abbreviation manually.

## YAML import and export

The web **New library** form can also validate and import TypeRelay YAML. On a desktop, use:

```fish
typerelay import yaml ./snippets.yml --name "Imported"
typerelay export "Imported" ./imported-export.yml
typerelay export "Imported" ./imported.typerelay.zip
typerelay import bundle ./imported.typerelay.zip --name "Imported bundle"
```

Export refuses to overwrite an existing destination. Use YAML for snippets without binary assets and a `.typerelay.zip` bundle for complete rich libraries. Editing an export does not synchronize changes or alter the SQLite database. Import it as a new library if you want those changes in TypeRelay.
