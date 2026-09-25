---
title: "Test the Type Relay Chrome extension"
description: "Build, load, sign in to, and test the Type Relay Chrome extension against a matching development server."
---

# TypeRelay Chrome extension

The Chrome extension expands synced snippets in editable web fields. It keeps a local snapshot for offline use. The toolbar searches snippets on demand; account, sync, prefix, and web app links are in extension settings. Internal browser pages, the address bar, and native apps are outside its reach.

## Build and load

For development testing on NadaMini, run `dbh-run urls` first and build for its reported app origin, for example `pnpm --filter @typerelay/extension exec node build.mjs --origin=https://tr.n.lan`. Open `chrome://extensions`, enable Developer mode, and load `apps/extension/dist` unpacked. After changing the build origin, reload the extension there and accept the new site permission if Chrome asks. The default `pnpm --filter @typerelay/extension build` targets `https://app.typerelay.com` and requires the browser OAuth server changes to be deployed there.

A fresh install opens the options page for sign-in. The toolbar opens settings when signed out, and its Settings button opens them after sign-in. Settings has Sync now and the trigger prefix. Before signing in, enter a server hostname beside `https://` and submit Sign in; approve Chrome’s server permission if prompted. The selected server is saved for login, sync, and app links. The small reset control restores `app.typerelay.com` in the field; submit Sign in to use it. Sign out before switching servers. The popup starts with an empty focused search field, shows up to 20 matches only after typing, and supports Up/Down and Enter to insert the selected snippet.

Sign in in the Chrome tab opened by the extension, then select an account and click **Connect device**. Magic Link sign-in can open another tab in the same browser profile; continue there. The extension recognizes its own callback on the Type Relay app origin, exchanges the code, and closes that callback tab. Account sign-in alone does not connect the extension.

The extension uses the first-party device OAuth flow with PKCE and an exact callback path on the selected app origin. Browser connections appear in device management and do not count against Free's machine limit. Snippets and short-lived and refresh tokens stay in Chrome's extension storage. Images are cached in Cache Storage for offline insertion. The extension sends only OAuth and sync requests to the selected Type Relay app origin. It does not send field contents to Type Relay. The native host receives only a short-lived ownership signal; it never receives snippets or field text.

## Desktop coexistence

On macOS, Windows, and Linux, expansion waits for the native messaging bridge. The updated desktop app registers the current development extension ID automatically. If Chrome reports a different ID at `chrome://extensions`, register it manually:

```fish
typerelay-panel --register-chrome-extension EXTENSION_ID
```

On macOS, use the executable inside `TypeRelay.app/Contents/MacOS` if it is not on `PATH`. Restart Chrome after registration. The app remembers the ID and refreshes the native host manifest after a desktop update. ChromeOS does not need the native host. The desktop app yields while a supported web field is focused and the extension's claim is live. Claims expire in under one second.

The Chrome Web Store assigns the final extension ID when the package is uploaded. Register that ID with the desktop native messaging host before public rollout. The current unpacked ID is for development only.

## Release gate

Google Docs is intentionally excluded from automatic insertion until its editor adapter is verified for typing, toolbar search insertion, formatting, and images without debugger permission. A content script cannot assume the hidden Google Docs input represents document contents. Do not submit the Chrome Web Store listing until the Google Docs tests pass. If they fail, report the specific editor behavior and keep the listing staged.

The Web Store listing must disclose broad site access, local snippet and image caching, sign-in tokens, and native messaging. Package only the `dist` directory. Keep all executable code in the package.

## Chrome Store package

Run `pnpm extension:package` from the repository root. Requires pnpm workspace dependencies, Node 24+, Cargo, and the `wasm32-unknown-unknown` Rust target used by the extension build.

The command cleans the generated extension `dist`, builds for `https://app.typerelay.com`, and writes `apps/extension/releases/typerelay-extension-<manifest-version>.zip`. Custom build origins are rejected in packaging mode; users can still select their own server in Options. The archive contains only runtime files with `manifest.json` at its root. Artwork is uploaded separately. Generated ZIPs are ignored by Git.

Run `pnpm --filter @typerelay/extension test:package` to verify archive contents, stale-file exclusion, and production-origin enforcement. Packaging does not upload or publish, and does not clear the Google Docs release gate above.
