# TypeRelay

![TypeRelay logo](apps/server/public/typerelay-logo.svg)

> Open-source text expansion for individuals and teams.

TypeRelay turns short abbreviations into reusable text, code and fillable templates. Keep private libraries on your device, share selected libraries with a team and continue editing while offline.

[Guide](docs/guide/index.md) · [Desktop](docs/desktop/index.md) · [TUI](docs/cli/tui.md) · [Self-hosting](docs/selfhosted/index.md) · [MCP](docs/mcp/index.md) · [API](docs/api/index.md)


## Why TypeRelay?

- **Fast expansion** — type a local prefix, an abbreviation and Space to insert a snippet. The default prefix is a semicolon.
- **Local-first editing** — snippets live in SQLite, remain searchable offline and queue changes for later synchronization.
- **Private or shared libraries** — keep personal content private or explicitly enroll libraries for team sync.
- **Text, code and templates** — preserve whitespace and Unicode, or add dates, prompted fields and explicit Enter actions.
- **Multiple interfaces** — use the desktop search panel, terminal editor, web app, public API or MCP server.
- **Portable data** — import and export TypeRelay YAML; assisted imports also support SnippetsLab and beta formats from TextExpander, Text Blaze and TypeIt4Me.

TypeRelay does not log keystrokes. Exported YAML is a portable copy, not live storage.

## What’s included

| Component | Purpose |
| --- | --- |
| Expansion engine | Rust client for continuous prefix + abbreviation expansion |
| Desktop panel | Tauri search, fill and insertion panel with tray/menu-bar controls |
| TypeRelay TUI | Offline library, snippet, settings and Trash management |
| Web app | Accounts, teams, sharing, imports, conflicts and security settings |
| Sync service | Explicit library enrollment, automatic assigned-library downloads and offline recovery |
| MCP server and API | Scoped access for agents and external integrations without direct database access |

## Platform support

| Platform | Current support |
| --- | --- |
| Omarchy / Hyprland, US layout | Continuous expansion, desktop panel and TUI; primary verified target |
| Windows x64 | Continuous expansion, layout-aware desktop panel and TUI |
| macOS Apple Silicon | Continuous expansion, desktop search and insertion panel |
| Other Linux desktops, layouts and architectures | Continuous expansion and safe insertion are unsupported |

See the [desktop overview](docs/desktop/index.md) and [troubleshooting guide](docs/desktop/troubleshooting.md) for current limitations.

## Quick start on Linux

Choose a Linux x86_64 package:

1. [AppImage](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.AppImage)
2. [deb](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.deb)
3. [rpm](https://transfer.typerelay.com/apps/typerelay-desktop-latest-linux-x64.rpm)

All three include the expansion engine, TUI, desktop search panel, tray menu, sync and update checking. For AppImage, make the downloaded file executable and launch it. Install deb/rpm with your distribution's package manager, then launch TypeRelay.

On first launch, TypeRelay offers to configure the user expansion service and scoped keyboard permissions. Expansion currently requires Hyprland on x86_64 and a US keyboard layout; Omarchy uses the same AppImage. No separate installer download is needed. See the [installation guide](docs/desktop/installation.md) for requirements, updates and removal.

Create a library and snippets with:

```fish
typerelay-tui
```

Then type the configured prefix, an abbreviation and Space in another application. For example, the default prefix and an abbreviation named `email` expand from `;email `.

## Team sync and self-hosting

The web app stores synchronized libraries in MongoDB. Devices authenticate in the browser, users explicitly enroll local libraries and assigned shared libraries download automatically. Conflicts retain both versions for resolution in the web app.

For an open-source production deployment, export the public URLs and private values, then start the production stack.

**fish:**

```fish
set -x APP_URL https://typerelay.example.com
set -x MCP_BASE_URL https://mcp.typerelay.example.com
set -x SESSION_SECRET (openssl rand -hex 64)
set -x JWT_SECRET (openssl rand -hex 64)
set -x SMTP_FROM noreply@example.com
set -x SMTP_SERVERS '[{"name":"primary","host":"smtp.example.com","port":587,"secure":false,"user":"user","pass":"password","from":"noreply@example.com"}]'
docker compose -f compose.prod.yml up -d
```

**bash / zsh:**

```sh
export APP_URL=https://typerelay.example.com
export MCP_BASE_URL=https://mcp.typerelay.example.com
export SESSION_SECRET="$(openssl rand -hex 64)"
export JWT_SECRET="$(openssl rand -hex 64)"
export SMTP_FROM=noreply@example.com
export SMTP_SERVERS='[{"name":"primary","host":"smtp.example.com","port":587,"secure":false,"user":"user","pass":"password","from":"noreply@example.com"}]'
docker compose -f compose.prod.yml up -d
```

The production stack includes the app, MCP adapter, scheduler and a persistent MongoDB replica set. Put ports `3000` and `3002` behind your HTTPS proxy. See [self-hosted configuration](docs/selfhosted/configuration.md).

## MCP and API

TypeRelay exposes permitted snippet workflows through a public HTTP API and a stateless Streamable HTTP MCP adapter. OAuth, personal access tokens, account permissions and scopes apply to every request; the MCP service never receives direct MongoDB access.

See the [MCP setup](docs/mcp/setup.md), [tool catalog](docs/mcp/tools.md) and [API overview](docs/api/index.md).

## Development

Requirements: Docker Compose, Rust 1.88+, Node.js 24+ and pnpm 12.

These commands work in fish, bash and zsh:

```sh
git clone https://github.com/typerelay/typerelay.git
cd typerelay
git switch develop
docker compose up -d --build
```

Repository layout:

- `crates/core` — shared snippet and template rules
- `crates/client` — expansion engine, synchronization, local database and TUI
- `apps/desktop` — cross-platform Tauri panel
- `apps/server` — Express web app and API
- `apps/mcp` — MCP-to-API adapter
- `docs` — VitePress user, integration and development documentation

Run the checks relevant to your change and the repository policy check before pushing:

```fish
docker compose run --rm app npm test
docker compose run --rm --no-deps mcp-tools
docker compose run --rm --no-deps rust-tools
python3 scripts/check-repository.py
```

Remove the development volumes when you no longer need their data:

```fish
docker compose down -v
```

## Contributing

Contributions and [bug reports](https://github.com/typerelay/typerelay/issues) are welcome. Maintainer and Codex work stays on `develop`: pull before starting, commit focused changes and push `develop` directly. Do not create a topic branch or pull request unless the task explicitly requests one. External pull requests target `develop` without a required branch-name convention. Include focused tests and describe manual verification where desktop input behavior changes.

Read the [development workflow](docs/development/workflow.md) before contributing. Please do not include real snippets, credentials, signing material or local SQLite databases in issues, fixtures or commits.

## Security and attribution

Please report security vulnerabilities through GitHub’s private vulnerability reporting when available, not a public issue. TypeRelay records third-party adaptations and retained upstream licenses in [web attribution](docs/web/attribution.md).
