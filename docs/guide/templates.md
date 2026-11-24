---
title: "TypeRelay template variables"
description: "Build reusable TypeRelay snippets with fill-in fields, dates, cursor positioning, and Tab or Enter keypresses for desktop forms."
---

# Template variables

<div v-pre>

Variables are built into **Text** and **Rich text**. Open **Variables** in the editor, insert a field, and TypeRelay asks for its value when the snippet is used. **Code** remains literal, including braces in source code.

```text
Hi {{name}},

Following up on our conversation.
Sent: {{timestamp}}
```

Use **Insert variable** to add a date, time, timestamp, text field, Enter keypress, Tab keypress, or Cursor position. Typing a new `{{name}}` placeholder also creates a text field. Repeated names use one answer; names are case-sensitive and use letters, digits and underscores (the first character cannot be a digit).

## Date and time

`{{date}}` defaults to `YYYY-MM-DD`, `{{time}}` to `HH:mm`, and `{{timestamp}}` to ISO with a timezone offset. Choose local time or UTC per variable. Available formats are `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `HH:mm`, `HH:mm:ss`, `YYYY-MM-DD HH:mm` and `ISO`.

All date/time values use one timestamp captured for the confirmed insertion. The names date, time and timestamp are reserved for these built-ins.

## Text fields

Set a label, default answer, required/optional status and single-line/multiline mode. The fill form previews the result before insertion. Entered answers stay in memory; only template definitions and defaults synchronize.

Answers are literal. You can enter `{{key:enter}}` or `{{key:tab}}` as field text. There are no scripts, conditions, loops or nested evaluation.

Rich text answers preserve literal character references such as `&copy;`. Answers inside inline or fenced code keep their punctuation without added backslashes.

In a Rich text link, URL answers stay inside that link. Spaces and Markdown punctuation are encoded so an answer cannot add another link or image.

## Cursor position

In **Text**, choose **Cursor position** to insert `{{cursor:here}}` where you want to continue typing. TypeRelay inserts the complete rendered snippet, removes the marker, then moves the caret to that position. For example, `Hello {{cursor:here}}, thanks!` leaves the caret after “Hello ”. Dates, fields, emoji and newlines before or after the marker are counted after rendering.

Use one marker per snippet. This marker works in Text snippets by itself or with fill-in fields and dates. Keypress actions and Rich text are incompatible with it. Place it between complete characters, outside combining marks or emoji sequences. `{{cursor}}` remains an ordinary text field. Escaped markers and Code are literal; markers in answers/defaults are also literal.

An Enter used to trigger a marked abbreviation is consumed, so it does not submit or split the inserted text. Copy and **Fill and copy** remove the marker and report that cursor positioning was omitted. Clients from before this feature reject the new syntax; update them before using marked snippets.

Chrome text fields and Android use exact text offsets. Chrome leaves single-line fields unchanged for marked multiline snippets and rejects marked insertions that exceed a field’s maximum length; use a textarea or Copy. When Chrome cannot complete an expansion, it restores the typed trigger delimiter (a space, or a newline in multiline fields) so the keypress is not lost. On Linux, supported accessible text fields receive a direct caret jump after paste. Other desktop editors receive arrow-key movement; their handling of arrow keys, bidirectional text, emoji and multiline content can vary. iOS uses the host app’s text-position API. Desktop cursor movement requires active keyboard monitoring; on macOS, allow Input Monitoring and restart TypeRelay. Cursor positioning has no additional snippet-size limit. On macOS and Windows, arrow-key movement is limited to 512 graphemes after the cursor marker; beyond that, the text is inserted and the cursor stays at the end. Desktop editors that require arrow-key movement take longer for longer suffixes; keep the target focused until movement finishes. Focus changes or interrupted input cancel movement without repeating the insertion. Use Copy if an editor does not support the expected cursor movement.

## Tab and Enter keypresses

`{{key:tab}}` presses Tab in the original desktop application. For example, `Jane{{key:tab}}Doe{{key:tab}}` fills two consecutive fields and moves focus to the next control in a form that uses Tab navigation. `{{key:enter}}` presses Enter and can submit a form or run a terminal command. Actions run in the order they appear.

When you expand a snippet containing a Tab action with Enter, TypeRelay consumes the trigger key. Add an explicit `{{key:enter}}` wherever the target app should receive Enter. If focus leaves the original window, TypeRelay stops the remaining steps.

In **Rich text**, put each action on its own line between blocks. Separate Tab actions from other content with a blank line. Literal tabs and newlines are text. On web and desktop, **Copy** and **Fill and copy** omit keypresses and report the omission. Chrome and mobile keyboard expansion cannot perform these actions. Desktop sync for active Tab snippets requires TypeRelay 1.4.2 or later. Older clients receive an upgrade message and keep their local edits. Sync resumes after upgrading or after the last active Tab snippet or its library moves to Trash.

In the desktop panel, complete the fields and choose **Insert**. Ctrl+Enter also confirms; Escape cancels. On Omarchy, a prompted abbreviation stays in the original application while the form opens. Confirmation removes it before inserting; cancel leaves it unchanged. If the panel is unavailable, the abbreviation remains unchanged. Date/time-only templates expand without a form.

In the TUI, F9 cycles Text, Code and Rich text. F11 opens the variable picker/settings for Text or Rich text; Ctrl+S inserts the chosen variable and F4 saves settings for an existing variable without inserting another reference. F10 fills/copies with rich clipboard formats when applicable. Tab or F2 changes fields; Ctrl+T inserts a tab in a value; Ctrl+S copies the filled result.

## Literal braces and compatibility

Escape a placeholder opener as `\{{` to produce literal `{{`. Use `\\` for a literal backslash. Other backslashes remain unchanged. Templates permit up to 64 fields and 64 keypress actions; rendered text retains the existing 65,536-byte limit.

Variable-enabled text and rich text require matching desktop/server sync protocol **6**. Legacy `template` records remain compatible and appear as Text. YAML export/import preserves variables. Rich records use `{version: 2, type: "rich_text", markdown, text, assets, variables}`; `text` and `assets` are derived rather than trusted from callers.

</div>
