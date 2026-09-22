---
title: "Configure AI agents for TypeRelay MCP"
description: "Configure AI agents to use TypeRelay MCP safely with OAuth or private tokens, correct scopes, revision checks, idempotency, and purge safeguards."
---

# Agent configuration

Connect your MCP client using the Streamable HTTP URL. Prefer OAuth when supported. For token clients supply an Authorization header from a private environment variable; never commit it in configuration. Read current revisions before editing and persist operation IDs for retries. Purge tools permanently delete only the explicitly selected eligible items.
