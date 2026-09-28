# TypeRelay documentation

Start with the repository [README](../README.md) for the project overview, installation, development and contribution workflow.

User and integration documentation is organized under:

- [Guide](guide/index.md) — first use, accounts, teams, sharing, snippets, sync, imports and Trash
- [Desktop](desktop/index.md)
- [CLI and TUI](cli/index.md)
- [Self-hosting](selfhosted/index.md)
- [MCP](mcp/index.md)
- [API](api/index.md)

Maintainer implementation and release notes live under `development/`, `web/` and excluded delivery pages. They are not the user guide and may describe historical migrations; current behavior is defined by the public sections above.

## Editing generated references

API usage guides live in `api/usage/<operationId>.md` and are included below the generated endpoint reference. These fragments are excluded as standalone pages. Edit `mcp/tools.md` for MCP guidance; its tool list is generated separately as `mcp/tools-list.md` from the API catalog during the documentation build.
