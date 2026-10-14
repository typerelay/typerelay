import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

for (const accepted of [true, false]) test(`rich insertion ${accepted ? 'preserves code spacing without a false Chrome failure' : 'reports an editor rejection and preserves its selection'}`, async () => {
	const dom = new JSDOM('<div contenteditable="true" tabindex="0">Before </div>', { url: 'https://rich.test', runScripts: 'outside-only', pretendToBeVisual: true });
	try {
		const document = dom.window.document;
		const editor = document.querySelector('[contenteditable]');
		Object.defineProperty(editor, 'isContentEditable', { value: true });
		const html = '<pre><code>  first\n  second\n</code></pre>\n';
		let listener;
		const commands = [];
		dom.window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener(callback) { listener = callback; } }, sendMessage: async message => ({ ok: true, value: message.type === 'prepare' ? { rendered: { html, text: '  first\n  second\n', fields: [] }, item: { content: { type: 'rich_text' } } } : { items: [] } }) } };
		document.execCommand = (command, _ui, value) => {
			commands.push(command);
			if (!accepted) return false;
			editor.insertAdjacentHTML('beforeend', value);
			// Reproduce Chrome inserting a fragment but returning false for a trailing newline.
			return !value.endsWith('\n');
		};
		dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
		editor.focus();
		const selection = document.getSelection();
		selection.selectAllChildren(editor);
		selection.collapseToEnd();
		const reply = await new Promise(resolve => listener({ type: 'insert', id: 'rich' }, {}, resolve));
		assert.deepEqual(commands, ['insertHTML']);
		assert.equal(reply.ok, accepted);
		assert.equal(document.activeElement, editor);
		if (accepted) assert.equal(editor.innerHTML, 'Before <pre><code>  first\n  second\n</code></pre>');
		else { assert.match(reply.error, /rejected formatted insertion/); assert.equal(editor.textContent, 'Before '); assert.equal(selection.anchorNode, editor); assert.equal(selection.anchorOffset, 1); }
	} finally { dom.window.close(); }
});
