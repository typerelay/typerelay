# Template variables

<div v-pre>

Variables are built into **Text** and **Rich text**. Open **Variables** in the editor, insert a field, and TypeRelay asks for its value when the snippet is used. **Code** remains literal, including braces in source code.

```text
Hi {{name}},

Following up on our conversation.
Sent: {{timestamp}}
```

Use **Insert variable** to add a date, time, timestamp, text field or Enter keypress. Typing a new `{{name}}` placeholder also creates a text field. Repeated names use one answer; names are case-sensitive and use letters, digits and underscores (the first character cannot be a digit).

## Date and time

`{{date}}` defaults to `YYYY-MM-DD`, `{{time}}` to `HH:mm`, and `{{timestamp}}` to ISO with a timezone offset. Choose local time or UTC per variable. Available formats are `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `HH:mm`, `HH:mm:ss`, `YYYY-MM-DD HH:mm` and `ISO`.

All date/time values use one timestamp captured for the confirmed insertion. The names date, time and timestamp are reserved for these built-ins.

## Text fields

Set a label, default answer, required/optional status and single-line/multiline mode. The fill form previews the result before insertion. Entered answers stay in memory; only template definitions and defaults synchronize.

Answers are literal: entering `{{key:enter}}` as an answer cannot create a keypress. There are no scripts, conditions, loops or nested evaluation.

## Enter actions and copying

`{{key:enter}}` presses Enter in the original application, in order with surrounding content. In rich text it must occupy its own line between top-level blocks so each surrounding HTML/RTF fragment remains valid. It can submit a form or run a terminal command. Ordinary newlines and tabs remain editor content, not keypress actions. Copy and **Fill and copy** report omitted Enter actions.

In the desktop panel, complete the fields and choose **Insert**. Ctrl+Enter also confirms; Escape cancels. On Omarchy, a prompted abbreviation is removed before the form opens. Cancel inserts nothing and does not restore it. If the panel is unavailable, the abbreviation remains unchanged. Date/time-only templates expand without a form.

In the TUI, F9 cycles Text, Code and Rich text. F11 opens the variable picker/settings for Text or Rich text; Ctrl+S inserts the chosen variable and F4 saves settings for an existing variable without inserting another reference. F10 fills/copies with rich clipboard formats when applicable. Tab or F2 changes fields; Ctrl+T inserts a tab in a value; Ctrl+S copies the filled result.

## Literal braces and compatibility

Escape a placeholder opener as `\{{` to produce literal `{{`. Use `\\` for a literal backslash. Other backslashes remain unchanged. Templates permit up to 64 fields and 64 Enter actions; rendered text retains the existing 65,536-byte limit.

Variable-enabled text and rich text require matching desktop/server sync protocol **6**. Legacy `template` records remain compatible and appear as Text. YAML export/import preserves variables. Rich records use `{version: 2, type: "rich_text", markdown, text, assets, variables}`; `text` and `assets` are derived rather than trusted from callers.

</div>
