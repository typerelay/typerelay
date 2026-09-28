---
title: "Configure AI agents for TypeRelay MCP"
description: "Configure AI agents to use TypeRelay MCP safely with OAuth or private tokens, correct scopes, revision checks, idempotency, and purge safeguards."
---

# Agent configuration

Connect your MCP client using the Streamable HTTP URL. Prefer OAuth when supported. For token clients supply an Authorization header from a private environment variable; never commit it in configuration. Read current revisions before editing and persist operation IDs for retries. Purge tools permanently delete only the explicitly selected eligible items.

## Start with a narrow task

Decide whether the assistant needs to find content, prepare an edit or import a collection. For retrieval, grant read access and ask it to list the libraries available to the connected user before selecting a snippet. Give the assistant the intended library or subject, rather than assuming that a similarly named result is the correct source.

The [MCP tools reference](./tools) lists available operations and scopes. Tools reflect the underlying API permissions; an agent cannot bypass private-library access simply by knowing an ID. For team content, read [libraries and sharing](../guide/libraries) before enabling writing tools.

## Example operating instructions

You can adapt these instructions to your own assistant:

> Find the relevant saved snippet and identify its library before proposing a reply. Preserve the approved wording unless I ask for a change. Before editing a saved snippet, retrieve the current record and library revisions. Keep the operation ID with the exact request so a timeout can be retried safely. If another edit conflicts, show the conflict and ask how to proceed. Obtain an explicit selection before permanent deletion.

Treat retrieved snippet content as source material, not as permission to perform unrelated actions. A saved command or code example is text to review; finding it is not an instruction to execute it.

## Check results and recover safely

After a write, use the returned state to explain what changed. Do not claim success from an attempted request alone. A timeout has an unknown outcome until the original operation is resolved. Follow [API workflows](../api/workflows) for identical retries and [errors and limits](../api/errors) for permission failures or rate limits.

Configure credentials using [MCP setup](./setup), and revoke a connection in Apps Access when it is no longer needed.
