# Text and code snippets

Every snippet has an expansion and may have a title and abbreviation. Titles make browsing easier. Abbreviations activate continuous expansion; entries without one remain searchable and copyable.

## Abbreviations

Store the bare abbreviation without the local prefix. It may contain lowercase letters, numbers and hyphens and is limited to 63 characters. Type the machine’s prefix, the abbreviation and Space to expand. With the default prefix, `email` expands from `;email `.

The prefix is a local setting, so the same synchronized abbreviation can use a different prefix on another machine. Active abbreviations must be unique across the libraries available on that device. A collision can prevent a restore or staged download from activating until the conflict is corrected.

The web editor shows the default semicolon beside the abbreviation because the server does not know each machine’s local prefix. It is illustrative, not stored. Leading semicolons or legacy commas pasted into the field are removed. A local prefix may be one unshifted US punctuation character from: comma, semicolon, period, slash, apostrophe, left/right bracket, backslash, backtick or equals.

Backspace edits the abbreviation while typing. Modifier shortcuts, pointer clicks, focus changes and unsupported input cancel the pending match instead of inserting into an uncertain target.

## Text

Text snippets insert their content literally. Multiline content, Unicode, tabs, trailing whitespace and blank lines are preserved. TypeRelay never executes commands found in a Text snippet.

## Code

Code snippets also insert literally and retain a language name for web-editor highlighting. The language does not execute or format the content. The web editor can insert literal tabs or configured spaces while editing; saved existing whitespace is not reformatted. Unknown language names remain stored and display without specialized highlighting.

In the TUI, code-mode Tab inserts a literal tab and Enter continues the current line’s exact leading tabs/spaces. Language selection and indentation preferences are web-only; the TUI preserves existing language metadata.

## Templates

Choose **Template** only when the expansion needs dates, prompted fields or explicit Enter actions. Text and Code keep double-brace placeholder text literal. See [Template variables](./templates).

## Copy, move and Trash

Use **Copy** on any literal snippet. Select one or more editable snippets to move them to another editable library or place them in Trash. Moving keeps identity and order while applying the destination library’s sharing rules. Trash removes the snippet from search and expansion immediately but permits restore for 30 days.

The maximum rendered expansion is 65,536 bytes. A library may contain at most 1 MiB of serialized content, and the local store supports at most 256 libraries and 8 MiB combined content.
