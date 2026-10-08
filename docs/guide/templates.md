---
title: "TypeRelay template variables"
description: "Add date, time, text-field, cursor-position, and Enter variables to TypeRelay snippets, fill reusable templates, and preserve literal braces when needed."
---

# Template variables

<div v-pre>

Variables are built into **Text** and **Rich text**. Open **Variables** in the editor, insert a field, and TypeRelay asks for its value when the snippet is used. **Code** remains literal, including braces in source code.

```text
Hi {{name}},

Following up on our conversation.
Sent: {{timestamp}}
```

Use **Insert variable** to add a date, time, timestamp, text field, Enter keypress or Cursor position. Typing a new `{{name}}` placeholder also creates a text field. Repeated names use one answer; names are case-sensitive and use letters, digits and underscores (the first character cannot be a digit).

## Date and time

`{{date}}` defaults to `YYYY-MM-DD`, `{{time}}` to `HH:mm`, and `{{timestamp}}` to ISO with a timezone offset. Choose local time or UTC per variable. Available formats are `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `HH:mm`, `HH:mm:ss`, `YYYY-MM-DD HH:mm` and `ISO`.

All date/time values use one timestamp captured for the confirmed insertion. The names date, time and timestamp are reserved for these built-ins.

## Text fields

Set a label, default answer, required/optional status and single-line/multiline mode. The fill form previews the result before insertion. Entered answers stay in memory; only template definitions and defaults synchronize.

Answers are literal: entering `{{key:enter}}` as an answer cannot create a keypress. There are no scripts, conditions, loops or nested evaluation.

## Cursor position

In **Text**, choose **Cursor position** to insert `{{cursor:here}}` where you want to continue typing. TypeRelay inserts the complete rendered snippet, removes the marker, then moves the caret to that position. For example, `Hello {{cursor:here}}, thanks!` leaves the caret after “Hello ”. Dates, fields, emoji and newlines before or after the marker are counted after rendering.

Use one marker per snippet. It cannot be combined with `{{key:enter}}` or used in Rich text. Place it between complete characters, outside combining marks or emoji sequences. `{{cursor}}` remains an ordinary text field. Escaped markers and Code are literal; markers in answers/defaults are also literal.

An Enter used to trigger a marked abbreviation is consumed, so it does not submit or split the inserted text. Copy and **Fill and copy** remove the marker and report that cursor positioning was omitted. Clients from before this feature reject the new syntax; update them before using marked snippets.

Chrome text fields and Android use exact text offsets. Chrome leaves single-line fields unchanged for marked multiline snippets and rejects marked insertions that exceed a field’s maximum length; use a textarea or Copy. On Linux, supported accessible text fields receive a direct caret jump after paste. Other desktop editors receive arrow-key movement; their handling of arrow keys, bidirectional text, emoji and multiline content can vary. iOS uses the host app’s text-position API. Desktop cursor movement requires active keyboard monitoring; on macOS, allow Input Monitoring and restart TypeRelay. Cursor positioning has no additional snippet-size or cursor-distance limit. Desktop editors that require arrow-key movement take longer for longer suffixes; keep the target focused until movement finishes. Focus changes or interrupted input cancel movement without repeating the insertion. Use Copy if an editor does not support the expected cursor movement.

## Enter actions and copying

`{{key:enter}}` presses Enter in the original application, in order with surrounding content. In rich text it must occupy its own line between top-level blocks so each surrounding HTML/RTF fragment remains valid. It can submit a form or run a terminal command. Ordinary newlines and tabs remain editor content, not keypress actions. Copy and **Fill and copy** report omitted Enter actions.

In the desktop panel, complete the fields and choose **Insert**. Ctrl+Enter also confirms; Escape cancels. On Omarchy, a prompted abbreviation stays in the original application while the form opens. Confirmation removes it before inserting; cancel leaves it unchanged. If the panel is unavailable, the abbreviation remains unchanged. Date/time-only templates expand without a form.

In the TUI, F9 cycles Text, Code and Rich text. F11 opens the variable picker/settings for Text or Rich text; Ctrl+S inserts the chosen variable and F4 saves settings for an existing variable without inserting another reference. F10 fills/copies with rich clipboard formats when applicable. Tab or F2 changes fields; Ctrl+T inserts a tab in a value; Ctrl+S copies the filled result.

## Literal braces and compatibility

Escape a placeholder opener as `\{{` to produce literal `{{`. Use `\\` for a literal backslash. Other backslashes remain unchanged. Templates permit up to 64 fields and 64 Enter actions; rendered text retains the existing 65,536-byte limit.

Variable-enabled text and rich text require matching desktop/server sync protocol **6**. Legacy `template` records remain compatible and appear as Text. YAML export/import preserves variables. Rich records use `{version: 2, type: "rich_text", markdown, text, assets, variables}`; `text` and `assets` are derived rather than trusted from callers.

</div>
