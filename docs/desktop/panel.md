# Search panel

Press **Ctrl+Shift+,** or left-click the **T** tray/menu-bar icon. Search across your accessible local libraries by abbreviation or content. Use arrow keys to select a result, then **Enter** to insert into the previously active application. **Escape** or an outside click dismisses the panel. **Copy** is available when insertion cannot safely restore your target.

Right-click the T icon for **Sync now**, **Settings** and **Quit TypeRelay**. Settings controls the shortcut, launch at login and account connection. **Authenticate in browser** signs in and links your desktop; it does not simply open the web dashboard.

Closing the panel hides it. On Omarchy, quitting the panel leaves the separate expansion service running. Search works offline. Read-only snippets and entries without abbreviations remain searchable.

On macOS grant Accessibility permission when required. On Windows elevated/protected applications may reject insertion. Native macOS and Windows builds remain beta pending platform verification; continuous abbreviation expansion is currently Omarchy-only.

## Filling templates

A Template result with text fields opens a fill form. Repeated names share one answer. Enter confirms a single-line form; Ctrl+Enter confirms from multiline fields. Escape cancels. Dates use the confirmation time. Explicit Enter actions run in source order after text insertion; Copy filled text omits them.

A lost original target leaves the filled draft available for Copy and never redirects insertion into another application. Runtime answers are not synchronized or saved. Templates require client/server sync protocol 5.

For macOS/Windows pilot checks, test a date-only template, repeated and multiline fields, literal answers containing braces, text/Enter/text order, cancellation, a closed original target and clipboard ownership. Builds alone do not mark these platforms runtime-verified.

Manual **Sync now** from the tray or panel sends a desktop notification when syncing starts and when it finishes. Failed syncs and changes needing attention are reported separately. Automatic background sync does not send these notifications. The panel also retains the latest manual-sync message; desktop notifications follow your operating system’s notification settings.
