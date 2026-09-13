import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import pug from 'pug';

test('code editor preserves whitespace, captures Tab, changes indentation and supports read-only', async () => {
	const text = '\n\t  {{ λ }}  \n$|$\n\n';
	const html = pug.renderFile('./views/ajax/form.pug', { kind: 'snippet', snippet: { title: 'Code', trigger: null, replace: text, content: { type: 'code', language: 'RustLexer' } }, library: { _id: 'one', name: 'Code', permissions: { edit: true } }, destinations: [] });
	const dom = new JSDOM('<meta name="style-nonce" content="test-nonce">' + html, { pretendToBeVisual: true });
	for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement']) globalThis[key] = dom.window[key];
	const { CodeEditor } = await import('../browser/code-editor.js');
	const field = document.querySelector('#replace');
	assert.equal(field.value, text, 'HTML textarea must preserve leading blank lines');
	const editor = new CodeEditor(field, document.querySelector('#code-editor'));
	try {
		await editor.configure('RustLexer', false, 4);
		assert.equal(field.value, text);
		editor.view.focus();
		editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
		assert.equal(field.value, '\t' + text);
		editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, shiftKey: true, bubbles: true, cancelable: true }));
		assert.equal(field.value, text);
		editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
		await editor.configure('UnknownLexer', true, 2);
		editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
		assert.equal(field.value, '\t  ' + text);
		for (const prefix of ['\t', '    ', '\t  ', '']) {
			const value = prefix + 'example';
			editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: value }, selection: { anchor: value.length } });
			editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
			assert.equal(field.value, value + '\n' + prefix);
		}
		const before = field.value;
		editor.setReadonly(true);
		editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
		assert.equal(field.value, before);
		assert.ok(document.querySelector('style[nonce="test-nonce"]'));
	} finally { editor.destroy(); dom.window.close(); }
});
