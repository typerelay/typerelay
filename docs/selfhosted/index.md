---
title: "Self-host TypeRelay"
description: "Run TypeRelay locally for development or deploy the open-source production stack with the app, scheduler, MCP adapter, MongoDB, HTTPS, and SMTP."
---

# Development and deployment

`compose.yml` is development-only and includes source mounts, test tools and the dbh overlay. Development uses MongoDB and SMTP from dbh through terminal environment variables. `compose.prod.yml` is the open-source production stack with the app, MCP adapter, scheduler and persistent MongoDB. Production uses your own domains, HTTPS proxy and SMTP service.

## Choose who operates your snippet service

Self-hosting lets you run Typerelay on infrastructure you control. You provide the application domain, storage, database, email delivery and operational maintenance. Self-hosted installations do not apply Typerelay hosted plan restrictions. The [open-source overview](https://typerelay.com/open-source/) explains the AGPLv3 project and compares the responsibilities of hosted and self-hosted use.

This section is for people operating the service. If you want to start using snippets without maintaining a server, review [Typerelay Cloud](../cloud/) and the [hosted plans](https://typerelay.com/pricing/). Desktop installation alone does not deploy the web service, database or MCP endpoint.

## Prepare the deployment

Read [configuration](./configuration) before starting the production stack. Choose public HTTPS origins for the application and MCP service, configure strong secrets, and supply a working SMTP service. Email is part of account creation, sign-in recovery and invitations; verify delivery before inviting a team.

Keep development and production configuration separate. The development stack mounts source code and includes tooling for local work. The production stack is intended for operating the service with persistent data. Select the documented Compose file for the environment you are preparing.

## Operate and maintain the installation

Plan backups for persistent data and verify that restoration works before relying on the service for shared content. Protect credentials, review access, and apply updates through your deployment process. Use [backend administration](./admin) for administrative workflows rather than editing database records directly.

After deployment, create an account, verify email delivery, and connect a desktop using the [getting started guide](../guide/getting-started). If you need an assistant integration, configure [MCP](../mcp/setup) against your own public resource URL. Test a small private library before introducing shared team libraries.
