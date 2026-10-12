---
title: "Typerelay OpenAI submission"
description: "Package, reviewer cases, recording script and deployment checks for the Typerelay OpenAI plugin."
---

# OpenAI submission

The portable package lives in `plugins/typerelay`. ZIP the contents of that directory with `plugin.json`, `mcp.json` and `assets/` at the ZIP root. Do not ZIP the repository, add credentials or include local environment files. The package uses the dedicated production endpoint `https://mcp.typerelay.com/mcp/app` and OAuth issuer `https://app.typerelay.com`. Deployments are performed by the operator.

The current portal draft is [Typerelay](https://platform.openai.com/plugins/manage/plugin_asdk_app_6acc260fc5e88191bd0b74752b6d8cd1). Upload a new version after changing package metadata; inspect the saved authentication settings before connecting. DCR uses the existing discovery and registration endpoint. The manifest requests the four scopes needed by the content tools and contains no client secrets. The user enters reviewer credentials privately in the portal. An existing eligible account is required; no subscription checkout is available through the plugin.

## Operator deployment and domain verification

Deploy the reviewed server/MCP release through the existing production process. Keep `/mcp` unchanged. In the existing `mcp.typerelay.com` Caddy site block, add this response before `import upstream_typerelay_mcp`:

```text
respond /.well-known/openai-apps-challenge "EnkJMf8o0lCqV5WF3PWW1VHe-5I8jUwAB3zvto0JDsI" 200
```

This is a public domain challenge, not a credential. Validate and reload Caddy using the existing operator procedure. Verify that `https://mcp.typerelay.com/.well-known/openai-apps-challenge` returns that exact token, then select **Verify** in the portal. If the portal rotates the challenge, use its current value instead. Verify `/health`, OAuth protected-resource discovery at `/.well-known/oauth-protected-resource/mcp/app`, authorization-server discovery, and an authenticated connection and tool scan. Unauthenticated POST `/mcp/app` should return HTTP 401 with a resource metadata challenge; GET `/mcp/app` returns HTTP 405 by design.

The user confirmed that the app and MCP release is deployed and the connection works in production. This is operator-confirmed status; local tests alone do not establish production verification.

The `/mcp/app` surface accepts OAuth tokens issued for that exact resource. Existing `/mcp` OAuth grants cannot connect to it; reconnect both the portal scan account and reviewer connection after uploading the new package. `/mcp` retains its catalog and personal-token support; `/mcp/app` is OAuth-only. The app surface replaces action selectors with `move_snippets`, `trash_snippets`, `trash_item`, `restore_item` and `permanently_delete_trash_items`. Each tool fixes its action internally; callers cannot override it. Permanent deletion requires an explicit list of Trash items and revisions. Existing API permissions, scopes, operation IDs and revision conflicts still apply. Verify legacy `/mcp` discovery and health as well.

## Recording script and reviewer setup

Use a dedicated reviewer account with content read/write, sharing write and Trash purge scopes, and access to its own disposable review library. Enter the actual reviewer credentials and any sign-in instructions only in the portal's secure form. Use the portal-supported username/password option or magic link/email code with the OpenAI-provided reviewer email; ensure reviewers can complete sign-in without inaccessible MFA. Do not display passwords, tokens or personal account content in the recording.

Record a continuous screen capture of ChatGPT with the connected Typerelay plugin. Show the OAuth consent screen, approve the requested scopes, and return to the chat. Open the tool details so the reviewer can see real calls and returned results. Use the prompts from the package verbatim, in this sequence:

1. **Discover libraries:** “List my Typerelay libraries.” Show accessible names and revisions. Start with no active `OpenAI Review` library or `review-greeting` abbreviation; if a previous run exists, remove its disposable data through the normal app controls before recording.
2. **Create content:** “Create a private Typerelay library named OpenAI Review and a plain text snippet titled Review greeting, abbreviation review-greeting, with text Hello from Typerelay.” Show the created library and snippet; additive writes follow the client's approval policy.
3. **Read content:** “Find my Typerelay snippet with the abbreviation review-greeting and show its text.” Show the search result and saved snippet text.
4. **Edit:** “In OpenAI Review, change Review greeting to Hello from my saved snippet.” Approve any client confirmation, show the current revisions and successful result, and confirm the saved text in the Typerelay app.
5. **Trash and restore:** “Move Review greeting in OpenAI Review to Trash, then restore it.” Show the explicit item selection, `trash_item`, the Trash entry, `restore_item`, client confirmations and restored active snippet. Do not purge it.
6. **Unsupported action:** “Use Typerelay to transfer $100 to another account.” Show the explanation that payment is unsupported and no mutation calls.
7. **Permission boundary:** “Show snippets from a Typerelay account or library I cannot access.” Show the refusal or permission explanation; no inaccessible content should appear.
8. **Read-only intent:** “Find Review greeting. Do not change, trash or permanently delete anything.” Show search/read calls only and the unchanged active snippet.

The package contains exactly five positive and three negative cases. The creation case prepares the content needed by the read, edit and Trash cases. Before an independent reviewer run, restore the baseline or repeat the creation setup with a clean disposable account. Verify the final active snippet in the app. Upload the recording to a reviewer-accessible URL, set `extensions.com.openai.review.demo_recording_url` in `plugins/typerelay/plugin.json` to that real URL, ZIP the package contents again, and select **Upload new version** in the portal. The current portal has no separate dashboard recording field. The supplied walkthrough is [Typerelay walkthrough](https://youtu.be/6Uz5RRvFXgQ), and the package now contains that URL. YouTube was still processing it when supplied; verify that reviewers can play it before submission.

## OAuth compatibility

The existing OAuth flow uses authorization code with S256 PKCE, exact resource binding, rotating refresh tokens, scope checks and immediate revocation checks. The MCP adapter advertises per-tool OAuth schemes and emits an authentication challenge when a tool token expires. REST API response shapes remain unchanged.

The package explicitly disables OIDC because the current server does not expose OIDC discovery or UserInfo. OpenAI documents OIDC, `openid`/`email` scopes and verified UserInfo email as necessary for Enterprise workspace domain restrictions. Those protections are not implemented by this release; do not claim them. If the portal makes that support a submission blocker, address verified-email semantics and consent in a separately reviewed authentication change. Do not mark an unverified address `email_verified: true` merely to satisfy a scan.

## Proposed public privacy disclosure

Review this factual text for the public privacy policy before submitting; this document does not publish or amend that policy:

> When you connect Typerelay to ChatGPT or another MCP client, the client can request the snippet content, library metadata, permissions, revisions, import previews and operation results needed for the actions you authorize. Access remains limited by your account permissions and granted scopes. The client receives this data to answer your request, and its provider's privacy policy also applies. You can revoke connected apps in Settings → Apps Access. MCP responses omit internal account and creator identifiers, audit timestamps, rendered HTML and image source URLs. Typerelay records account-scoped API audit entries with the operation and response status for 90 days. Items moved to Trash are retained for up to 30 days unless permanently purged sooner.

Confirm that the live policy covers the actual recipients, purposes, retention and user controls. Account holders should use approved reusable wording and avoid restricted sensitive data or credentials in snippet content submitted through the plugin.

## Release checks and remaining materials

Run the MCP SDK/regression suite and package checks, independent review, and named development URL login/consent smoke testing before integration. Refresh the integrated development stack using the repository's deployment instructions. A green automated suite is not a completed portal scan, recording or production deployment.

The recording URL is supplied and production deployment and the working connection are user-confirmed. Remaining submission checks are reviewer playback after YouTube processing, the updated package upload, privately entered reviewer credentials, domain verification for the current draft, and the portal’s final review status. Publication countries and final release approval are chosen in the portal; no geographic availability is fabricated by this package.

Sources checked for this release: [Package your plugin](https://developers.openai.com/plugins/build/plugins), [Submit your plugin](https://developers.openai.com/plugins/deploy/submission), [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines), and [Authenticate users](https://developers.openai.com/plugins/build/auth). The old `/plugins/deploy/plugin-guidelines` URL is unavailable; the current guidelines URL is linked above.
