import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import pug from 'pug';
import { BrowserSource } from './browser-source.js';

test('clicking a snippet selection label toggles once and leaves title and body clicks for the editor', async () => {
	const snippets = ['one', 'two', 'three', 'readonly'].map(id => ({ id, title: id, replace: 'First line\nSecond line', revision: 1 }));
	const library = { permissions: { edit: true }, snippets };
	const rows = snippets.map(snippet => pug.renderFile('views/ajax/snippet.pug', { snippet, library: { permissions: { edit: snippet.id !== 'readonly' } } })).join('');
	const dom = new JSDOM('<div data-editor="test">' + rows + '</div>', { runScripts: 'outside-only' });
	try {
		dom.window.eval((await BrowserSource.script()).replace('export { client };', 'window.testClient = client;'));
		const client = dom.window.testClient;
		client.libraries.set('test', library);
		const edits = [];
		client.editSnippet = async (_, id) => edits.push(id);
		const [one, two, three, readonly] = dom.window.document.querySelectorAll('label.snippet-selection');
		assert.equal(one.control.getAttribute('aria-label'), 'Select one');
		one.click();
		assert.equal(one.control.checked, true);
		assert.deepEqual([...client.selectedSnippets], ['one']);
		one.click();
		assert.equal(one.control.checked, false);
		assert.deepEqual([...client.selectedSnippets], []);
		one.control.click();
		three.control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
		assert.deepEqual([...client.selectedSnippets], ['one', 'two', 'three']);
		assert.equal(two.control.checked, true);
		assert.equal(readonly.control.disabled, true);
		readonly.click();
		assert.deepEqual([...client.selectedSnippets], ['one', 'two', 'three']);
		assert.deepEqual(edits, []);
		one.parentElement.querySelector('h3').click();
		two.parentElement.querySelector('pre').click();
		assert.deepEqual(edits, ['one', 'two']);
	} finally { dom.window.close(); }
});
