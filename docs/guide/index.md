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

## Decide what belongs in a snippet

A useful first collection contains wording you repeat and want to keep accurate. Examples include contact details, a support response, a meeting confirmation or a frequently used code block. Save the reusable part and leave recipient-specific details for [template variables](./templates). Give each entry a title that will make sense when you search for it later.

Choose the content type deliberately. Text inserts literal wording, Code preserves code as text, and Rich text supports formatting, links and images. The [snippet guide](./snippets) explains abbreviations, size limits and the behavior of each type. For more examples, read [typing shortcuts for reusable replies](https://typerelay.com/blog/typing-shortcuts-for-reusable-replies-signatures-and-phrases/).

## Separate personal and shared content

Keep personal shortcuts in a private library. Put approved team wording in a shared library and choose who may edit it. Sharing a library is a permission decision, so check its audience before moving content into it. The [teams guide](./teams) explains account roles, while [libraries and sharing](./libraries) covers content access.

Our article on [shared snippet libraries](https://typerelay.com/blog/shared-snippet-library-for-teams-one-source-always-current/) describes an ownership workflow for maintaining recurring replies. Start with a small collection that someone is responsible for reviewing.

## Bring existing content with you

Use [import and export](./imports) to choose a supported transfer format and review imported abbreviations. Use [Trash](./trash) for recoverable removal. When you add another device, follow [sync and offline use](./sync) so you understand which content stays local and which libraries travel with your account.
