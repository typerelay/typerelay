---
title: "TypeRelay Desktop search panel"
description: "Search, filter, copy, edit, and expand TypeRelay snippets from the keyboard-first Desktop panel, including prompts for template variables."
---

# Search panel

Press **Ctrl+Shift+;** or left-click the **T** tray/menu-bar icon. Search across accessible local libraries by abbreviation, title or content. Exact abbreviations rank first, followed by abbreviation prefixes, abbreviation substrings and content matches. Results identify their library and show a literal preview.

Click a result once, or use arrow keys and **Enter**, to insert into the previously active application. TypeRelay rechecks the snippet revision and access immediately before insertion. **Escape** or an outside click dismisses the panel. **Copy** is available when insertion cannot safely restore the original target.

Right-click the T icon for **Sync now**, **Check for updates…**, **Settings** and **Quit TypeRelay**. Settings controls the shortcut, launch at login and account connection. **Authenticate** signs in through the browser and links this desktop to the selected account; it does not merely open the web dashboard.

Closing the panel hides it. On Omarchy, quitting the panel leaves the separate expansion service running. Search works offline. Read-only snippets and entries without abbreviations remain searchable.

The default shortcut can be changed to Ctrl, Shift, Alt or Super plus another key. If registration fails because the operating system or another application already owns it, choose a different shortcut. **Start at login** manages the platform’s user startup entry.

The resident app also performs prefix + abbreviation + Space expansion on macOS and Windows. Omarchy uses the separate expansion service. See [Operating system notes](./platforms) for permissions, remote-session and clipboard behavior.

## Filling templates

A Template result with text fields opens a fill form. Repeated names share one answer. Enter confirms a single-line form; Ctrl+Enter confirms from multiline fields. Escape cancels. Dates use the confirmation time. Explicit Enter actions run in source order after text insertion; Copy filled text omits them.

A lost original target leaves the filled draft available for Copy and never redirects insertion into another application. Runtime answers are not synchronized or saved. Rich text and templates require client/server sync protocol 6.

For macOS/Windows pilot checks, test a date-only template, repeated and multiline fields, literal answers containing braces, text/Enter/text order, cancellation, a closed original target and clipboard ownership. Builds alone do not mark these platforms runtime-verified.

Manual **Sync now** from the tray or panel sends a desktop notification when syncing starts and when it finishes. Failed syncs and changes needing attention are reported separately. Automatic background sync does not send these notifications. The panel also retains the latest manual-sync message; desktop notifications follow your operating system’s notification settings.
