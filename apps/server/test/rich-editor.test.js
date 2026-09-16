import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import pug from 'pug';

test('TipTap rich editor round-trips GFM, raw HTML, asset images and source mode', async () => {
	const markdown = '# Heading\n\n| A | B |\n|---|---|\n| C | D |\n\n<div data-custom="kept"><u>Raw</u></div>\n\n![Dot](typerelay-asset:' + 'a'.repeat(64) + ')';
	const html = pug.renderFile('./views/ajax/form.pug', { kind: 'snippet', snippet: { title: 'Rich', trigger: 'rich', replace: markdown, content: { type: 'rich_text', markdown, variables: {} } }, library: { _id: 'one', name: 'Rich', permissions: { edit: true } }, destinations: [] });
	const dom = new JSDOM('<div id="workspace" data-account="account"></div>' + html, { pretendToBeVisual: true });
	assert.deepEqual([...dom.window.document.querySelectorAll('#snippet-type option')].map(option => option.textContent), ['Text', 'Code', 'Rich text']);
	assert.ok(dom.window.document.querySelector('#rich-options').compareDocumentPosition(dom.window.document.querySelector('#template-options')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.equal(dom.window.document.querySelector('#copy-code'), null);
	for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Event', 'navigator', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
	globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
	globalThis.cancelAnimationFrame = clearTimeout;
	const { RichEditor } = await import('../browser/rich-editor.js');
	const field = document.querySelector('#replace');
	const editor = new RichEditor(field, document.querySelector('#rich-editor'), document.querySelector('#rich-toolbar'), { readonly: false, onError: error => { throw error; } });
	try {
		const roundTrip = editor.content();
		assert.match(roundTrip, /# Heading/);
		assert.match(roundTrip, /\| A\s+\| B\s+\|/);
		assert.match(roundTrip, /data-custom="kept"/);
		assert.match(roundTrip, new RegExp('typerelay-asset:' + 'a'.repeat(64)));
		editor.toggleSource(); assert.equal(field.hidden, false); field.value += '\n\n**Source edit**'; editor.toggleSource(); assert.match(editor.content(), /\*\*Source edit\*\*/);
		editor.editor.chain().focus().setTextSelection({ from: 1, to: 8 }).toggleUnderline().setTextAlign('center').run(); const formatted = editor.content(); assert.match(formatted, /<u>|text-decoration|underline/); assert.match(formatted, /text-align|align=/);
		editor.setReadonly(true); assert.equal(editor.editor.isEditable, false);
	} finally { editor.destroy(); dom.window.close(); }
});
