---
title: "Typerelay AI"
description: "Author snippets, find saved text with AI, choose providers and models, and disable AI across Typerelay apps."
---

# AI authoring and search

AI is enabled by default. Requests run when you explicitly choose an AI action. Ordinary typing, expansion, synchronization, and regular search do not invoke an AI provider.

## Write a snippet

For a new web snippet, describe what you want in the AI card and choose **Submit**.

When editing an existing web snippet, expand **Use AI** and select an action:

- **Refine text:** improve wording, tone, grammar, or length.
- **Translate text:** convert the snippet into the language you enter in **Translate into** (required).
- **Add reusable fields:** turn values such as “Hello Sarah” into “Hello {{name}}”.

Add **Custom instructions (optional)** to guide the result, then choose **Preview changes**. Selecting an action alone makes no AI request. Instructions and language remain when switching actions or collapsing the card.

The mobile editor retains **Write with AI**, with Generate, Improve, Translate, and Make a template.

Review and edit the proposal. **Discard** leaves your snippet unchanged; **Use draft** applies the proposal to the editor; **Save** uses the existing snippet save workflow.

The proposal preserves the selected content type, existing field definitions, dates, Enter actions, and image asset references. Code remains literal. Unsupported or incomplete output is rejected.

Desktop and extension authoring open the connected account's web editor. Desktop local-only snippets are edited in the TUI; authoring does not upload them.

## Find a snippet

Open **AI search** in web search, the desktop panel, mobile main app, or extension popup. Describe what you need or paste context, then choose **Find snippets**.

Typerelay expands the query into terms/synonyms, retrieves candidates, and ranks them with the selected model. Results refer to existing snippets. Normal preview, filling, copy, and insertion apply.

Desktop can include explicitly selected local-only libraries. Selected text is submitted transiently to the connected server and selected provider. It is not added to synchronized libraries or AI request records.

Search sends at most thirty candidate excerpts of 1,200 characters, plus your query. Choose a model with sufficient context. This release uses request-time ranking without a persistent embedding index.

## Disable AI

**Settings → AI** has a synced personal switch for the selected account across apps and an app/browser-local switch. The local switch stays off across account changes in that app/browser installation.

Owners/admins can disable team AI; installation admins can disable installation AI. Those policies also block private connections. Saved connections remain stored. Regular offline search and expansion continue working.

Mobile AI runs in the main app. Native keyboards use their existing snippet workflow.

## Choose providers and models

Manage credentials in web **Settings → AI**. Other apps open that page on the connected server.

1. In **AI for me**, add a named provider and API key under **AI provider**. Owners and admins can configure shared providers in **AI for my team**.
2. For compatible APIs, enter the full API base URL, including its path. Keyless endpoints can use **Endpoint requires no API key**.
3. Under **AI settings**, choose the Authoring provider. Models load automatically into a searchable selector. Choose a model or type a manual model ID, then **Verify**. Use **Refresh models** to retry discovery.
4. Select **Save AI settings**. Search inherits Authoring initially; choose a Search provider to use a different model. Its models also load automatically.

On eligible hosted accounts, **Use private Typerelay AI** selects the included AI for that scope without deleting your saved providers or models. A personal selection overrides team settings; a team selection applies when the user has no personal provider route. Turning the switch off restores normal provider inheritance. The switch is shown only in the hosted edition and explains when included AI is unavailable.

Private connections belong to your user in the selected account. Owners/admins configure shared team connections. Routing uses private, then team, then installation settings. A configured connection's failure produces an error and does not silently switch providers or credentials.

Blank replacement-key fields preserve a saved key. **Clear stored key** removes it. Responses show masked key status. Verification makes a small generation request and can incur the provider's normal API charge.

| Provider | Configuration |
|---|---|
| OpenAI | API key and text-generation model |
| Google/Gemini | Gemini API key and model ID |
| Anthropic | API key and Claude model ID |
| OpenRouter | API key and model ID |
| OpenCode Zen | Zen API key and model ID; API format selected by model family |
| OpenAI compatible | Base URL, model ID, and API key when required |

The API format defaults to **auto**. Override it if your gateway/model requires another supported format. For Cloudflare Workers AI, use the account-specific base URL, API token, and model. See [Cloudflare compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) and [OpenCode Zen endpoints](https://opencode.ai/docs/en/zen/).

For Cloudflare Gemma 4 26B A4B, enter `@cf/google/gemma-4-26b-a4b-it` as the model with the compatible Chat Completions API. Typerelay automatically disables this model's thinking mode so short authoring and search responses do not spend their output budget on reasoning. Cloudflare processes these requests; this is separate from on-device AI.

## Hosted and self-hosted defaults

Installation administrators configure providers and defaults at **Admin → Settings → AI**. **AI provider** manages credentials and private endpoint approvals. **AI settings** manages the installation switch, daily allowance, and Authoring/Search providers and models. Each form saves its own fields and preserves changes in the other forms.

Hosted Pro/Team, including eligible trials, receive fifty managed actions per user/day by default. The administrator can adjust the limit. Each authoring/search action counts once, including two-call searches. The allowance resets at UTC midnight. Requests rejected before inference do not consume allowance; failures after generation starts can consume it.

Private/team keys work on every plan without consuming managed allowance. Self-hosted installations use their own connections without hosted-plan restrictions.

Saving keys requires the existing **GIT_ENCRYPTION_KEY** deployment setting. No new environment variables are needed.

Hosted compatible endpoints require public HTTPS. Self-hosted admins can approve private HTTP(S) origins for local model servers in **AI provider → Private endpoints**, one origin per line. Save endpoint approvals before fetching models or verifying a private provider. The endpoint must be reachable from the Typerelay server.

## Data and recovery

Authoring submits your instructions and snippet text. Search submits your query and candidate excerpts from accessible synced snippets and selected local libraries. Image binaries, keystrokes, application content, and page content are not collected automatically.

Keys stay encrypted on the server and are not synchronized to clients. AI request records contain action IDs, workflow names, quota counters, and completion state; they do not contain prompts, local text, or AI outputs. Provider processing/retention depends on the service you choose.

Errors preserve your editor and existing results. Stale proposals cannot replace newer edits. Use **Refresh settings** to reload saved configuration after a conflict; this explicit action discards unsaved changes in that section.

In web **Settings → AI**, the **Enable AI** switch in the header controls AI for your account across connected apps. The web app uses that account preference; desktop, mobile, and extension apps retain their own local AI controls.
