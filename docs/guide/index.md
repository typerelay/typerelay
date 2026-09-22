---
title: "TypeRelay guide"
description: "Learn how TypeRelay organizes reusable text and code in private or shared libraries across the web, Desktop, CLI, TUI, API, and MCP."
---

# Introduction

TypeRelay stores text and code snippets in libraries. Use the web app, terminal editor or desktop search panel. Share selected libraries with your team; private libraries remain visible only to their creator.

## Where to begin

1. [Create or sign in to an account](./accounts).
2. [Install the desktop app](../desktop/installation) and connect it to the same account.
3. Create a local library in the TUI or a server library in the web app.
4. [Enroll local libraries](./sync) that should synchronize. Server libraries you can access download automatically.
5. Add an abbreviation, then type the local prefix, the abbreviation and Space in another application. The default prefix is `;`, so an abbreviation named `email` expands from `;email `.

Read [Getting started](./getting-started) for the complete first-use path.

## Interfaces

| Interface | Best for | Network required |
| --- | --- | --- |
| Desktop panel | Searching, filling and inserting snippets | No, after data is local |
| Continuous expansion | Prefix + abbreviation + Space expansion | No |
| TypeRelay TUI | Editing local libraries, snippets, templates and Trash | No |
| Web app | Accounts, teams, sharing, imports, conflicts and security | Yes |
| API and MCP | Approved integrations and agents | Yes |

All desktop content is stored in SQLite. YAML is import/export only; editing an exported file does not change TypeRelay.
