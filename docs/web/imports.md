# Importers

The web Import dropdown is below the library list. It contains TypeRelay YAML, SnippetsLab, TextExpander (Beta), Text Blaze (Beta) and TypeIt4Me (Beta). Imports create private libraries and never replace existing names. The existing YAML option in New Library remains available.

## API and shared behavior

`POST /api/v2/import/:format/preview` accepts `{source, filename?}` and returns `{entries,warnings,html}`. Format keys: `yaml`, `snippetslab`, `textexpander`, `textblaze`, `typeit4me`. Source is file text; JSON formats also accept parsed objects for compatibility.

`POST /api/v2/import/:format` accepts `{operation_id,source,filename?,selected:[{key,trigger?}]}`. The server reparses and validates all selected entries. A single existing MongoDB mutation transaction creates libraries, snippets, change events and the idempotency receipt. Failed validation rolls back the batch. Names receive numeric suffixes on collision. Existing SnippetsLab URLs and service methods continue to work; `/api/v2/import/preview` remains the existing YAML validation endpoint.

The shared preview shows original/proposed abbreviations and source warnings. Comma prefixes are removed; invalid abbreviations must be corrected or cleared. Unselected rows do not block form validation. Commands detected in imported source become literal Code, with no abbreviation, and `(Needs review)` appended to the title. Import requests cannot activate those review entries by supplying an abbreviation. Users may review and assign an abbreviation later. Nothing is executed or translated into TypeRelay variables.

Review detection is conservative, covering TextExpander percent macros, Text Blaze command/form/formula delimiters, TypeIt4Me dynamic delimiters, TypeRelay-style template markers, and explicit script/macro record types. It is not a complete interpreter or compatibility guarantee. All source commands must be reviewed in beta.

Import limits remain 8 MiB of serialized source, 1000 entries, 256 libraries/folders and 20 folder levels, plus existing snippet/engine limits. HTML conversion uses a parser without a browser, resource loading or execution; scripts/styles/images are omitted. Readable text and line breaks are retained. TypeIt4Me rejects arbitrary DTD/entity declarations; the standard Apple plist public declaration is removed without resolving its URL.

## Supported layouts and confidence

### TextExpander — CSV

Documented headers: `abbreviation`, `snippet`, optional `label`. Filename names the library. RFC-style quoted multiline values, escaped quotes and UTF-8 BOM are supported; malformed/duplicate headers fail. Native `.textexpander` files are not supported.

Source: https://textexpander.com/learn/using/importing-and-exporting-snippet-groups

### Text Blaze — JSON (Beta)

The vendor documents JSON folder exports and a per-snippet `html` property for styled content, but no complete versioned schema was established. The following parser layouts are explicit beta assumptions, tested with synthetic fixtures:

- A root `folders` array, a root array of folder objects, or a single object with `snippets`.
- Folder `name`/`title`, `snippets` array, optional nested `children` folders.
- Snippet `shortcut`/`abbreviation`/`trigger`, `name`/`title`/`label`, and string `body`/`text`/`snippet`/`content`.
- Available `html` is converted to plain text with an omission warning. A readable text field is used if HTML contains no readable text.

Sources:
- https://community.blaze.today/t/textblaze-snippet-export-import-not-importing-correctly/38535/6
- https://community.blaze.today/t/how-to-export-back-up-text-snippets-including-all-formatting-bold-italic-colors-graphics/8995

### TypeIt4Me — XML sets (Beta)

The vendor documents `.typeit4me` set files, but not their complete serialization. These are supported parser assumptions, not a claim of compatibility with every TypeIt4Me version:

- XML plist dictionary with `snippets` or `clippings` array; a `sets` array; or a root array of recognized snippet records.
- Plain XML root `TypeIt4Me`, `snippets` or `clippings`, with `snippet`/`clipping` child records containing text fields.
- Record abbreviation keys: `trigger`, `shortcut`, `abbreviation`, `abbr`; text keys: `text`, `body`, `snippet`, `replace`, `plainText`, `content`, `clip`; label keys: `title`, `name`, `label`.
- Optional set `name`/`title`; filename otherwise.
- Binary plist/opaque archives, RTF payloads, unknown XML layouts and unreadable/image-only content are unsupported and reported. Binary data is not decoded or executed.

Source: https://ettoresoftware.store/mac-apps/typeit4me6/frequently-asked-questions/backups/

### Existing formats

TypeRelay YAML and SnippetsLab retain their existing content/language semantics, limits and parser behavior. SnippetsLab fragments remain separate entries. No schema or sync-protocol migration is introduced.

## Verification

Synthetic fixture tests cover quoted multiline CSV/BOM, mixed whitespace, nested JSON folders, HTML conversion, review-only commands, XML/plist decoding, entity rejection and unknown formats. Transaction tests cover abbreviation corrections/clearing, private access, retry idempotency, duplicate rollback and name suffixes. The DOM integration test verifies dropdown placement, preview edits, unselected invalid rows and item-level library insertion without replacing the editor. Existing YAML/SnippetsLab and two-desktop sync tests are rerun.

No customer exports were available. Customer compatibility testing remains part of beta. No analytics or automatic upload of customer files has been added.
