import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import pug from 'pug';

test('TipTap rich editor round-trips GFM, raw HTML, asset images and source mode', async () => {
	const markdown = '# Heading\n\n| A | B |\n|---|---|\n| C | D |\n\n<div data-custom="kept"><u>Raw</u></div>\n\n![Dot](typerelay-asset:' + 'a'.repeat(64) + ')';
	const html = pug.renderFile('./views/ajax/form.pug', { kind: 'snippet', snippet: { title: 'Rich', trigger: 'rich', replace: markdown, content: { type: 'rich_text', markdown, variables: {} } }, library: { _id: 'one', name: 'Rich', permissions: { edit: true } }, destinations: [] });
	const dom = new JSDOM('<div id="workspace" data-account="account"></div>' + html, { pretendToBeVisual: true });
	assert.deepEqual([...dom.window.document.querySelectorAll('#snippet-type option')].map(option => option.textContent), ['Text', 'Code', 'Rich text']);
	assert.deepEqual([...dom.window.document.querySelectorAll('.row.align-items-center.g-0 > div > .snippet-label')].map(label => label.textContent), ['Abbreviation', 'Title (optional)', 'Type']);
	assert.equal(dom.window.document.querySelectorAll('.snippet-label').length, 4);
	assert.equal(dom.window.document.querySelector('#template-options > .input-group') !== null, true);
	const variableDefinition = dom.window.document.querySelector('#variable-definition').content;
	assert.equal(variableDefinition.querySelector('[data-input-options].variable-checks') !== null, true);
	assert.equal(variableDefinition.querySelectorAll('.form-check.variable-check').length, 2);
	assert.ok(dom.window.document.querySelector('#template-options').compareDocumentPosition(dom.window.document.querySelector('#replace')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.ok(dom.window.document.querySelector('#template-options').compareDocumentPosition(dom.window.document.querySelector('#rich-options')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.equal(dom.window.document.querySelector('#copy-code'), null);
	for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Event', 'navigator', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
	globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
	globalThis.cancelAnimationFrame = clearTimeout;
	const { RichEditor } = await import('../browser/rich-editor.js');
	const field = document.querySelector('#replace');
	const originalParent = field.parentNode;
	const editor = new RichEditor(field, document.querySelector('#rich-editor'), document.querySelector('#rich-toolbar'), { readonly: false, onError: error => { throw error; } });
	try {
		assert.equal(field.parentElement.id, 'rich-options');
		assert.equal(field.previousElementSibling.id, 'rich-toolbar');
		assert.match(document.querySelector('#rich-editor img').getAttribute('src'), /^\/snippet-assets\/account\//);
		assert.equal(document.querySelectorAll('[data-rich-command="link"] svg, [data-rich-command="image"] svg').length, 2);
		assert.equal(document.querySelector('[data-rich-command="source"]').classList.contains('ms-2'), true);
		const pasted = new dom.window.File(['image'], 'paste.png', { type: 'image/png' });
		assert.deepEqual(editor.clipboardFiles({ files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }, { kind: 'string', type: 'text/plain', getAsFile: () => null }] }), [pasted]);
		let handledFiles; editor.files = async files => { handledFiles = files; }; const pasteEvent = new dom.window.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(pasteEvent, 'clipboardData', { value: { files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }] } }); document.querySelector('#rich-editor').dispatchEvent(pasteEvent); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(pasteEvent.defaultPrevented, true); assert.deepEqual(handledFiles, [pasted]);
		const roundTrip = editor.content();
		assert.match(roundTrip, /# Heading/);
		assert.match(roundTrip, /\| A\s+\| B\s+\|/);
		assert.match(roundTrip, /data-custom="kept"/);
		assert.match(roundTrip, new RegExp('typerelay-asset:' + 'a'.repeat(64)));
		editor.toggleSource(); assert.equal(field.hidden, false); assert.equal(field.previousElementSibling.id, 'rich-toolbar'); field.value += '\n\n**Source edit**'; editor.toggleSource(); assert.match(editor.content(), /\*\*Source edit\*\*/);
		editor.editor.chain().focus().setTextSelection({ from: 1, to: 8 }).toggleUnderline().setTextAlign('center').run(); const formatted = editor.content(); assert.match(formatted, /<u>|text-decoration|underline/); assert.match(formatted, /text-align|align=/);
		editor.setReadonly(true); assert.equal(editor.editor.isEditable, false);
	} finally { editor.destroy(); assert.equal(field.parentNode, originalParent); dom.window.close(); }
});
