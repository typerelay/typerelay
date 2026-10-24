import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

const snippet = { id: 'one', title: 'One', trigger: 'tw', effective_trigger: 'tw', replace: 'Shared', revision: 1, personal: { revision: 0, trigger: null, conflicts: [] } };

test('the My abbreviation button renders only for shared snippets the user may edit', () => {
	const editableShared = { _id: 'shared', name: 'Shared', shared: true, revision: 1, permissions: { edit: true, manage: true } };
	assert.ok(pug.renderFile('./views/ajax/snippet.pug', { library: editableShared, snippet }).includes('data-personal-snippet="one"'));
	const readOnly = { _id: 'shared', name: 'Shared', shared: true, revision: 1, permissions: { edit: false, manage: false } };
	assert.ok(!pug.renderFile('./views/ajax/snippet.pug', { library: readOnly, snippet }).includes('data-personal-snippet="one"'));
	const privateLibrary = { _id: 'mine', name: 'Mine', shared: false, revision: 1, permissions: { edit: true, manage: true } };
	assert.ok(!pug.renderFile('./views/ajax/snippet.pug', { library: privateLibrary, snippet }).includes('data-personal-snippet="one"'));
});

test('clicking My abbreviation opens the personal abbreviation form for the snippet', async () => {
	const library = { _id: 'shared', name: 'Shared', shared: true, revision: 1, permissions: { edit: true, manage: true }, snippets: [snippet] };
	const dom = new JSDOM('<div id="libraries"></div>' + pug.renderFile('./views/ajax/editor.pug', { library }), { runScripts: 'outside-only', pretendToBeVisual: true });
	try {
		const source = (await readFile('./public/app.js', 'utf8')).replace(/^import .*;$/gm, '').replace('const client = new TypeRelay();', '').replace('export { client };', 'window.TypeRelay = TypeRelay;');
		dom.window.eval(source);
		const client = Object.create(dom.window.TypeRelay.prototype);
		Object.assign(client, { libraries: new Map([['shared', library]]), tombstones: new Map(), selected: 'shared', selectedSnippets: new Set() });
		let opened = null;
		client.form = (kind, params) => { opened = { kind, params }; };
		const { document } = dom.window;
		const button = document.querySelector('[data-personal-snippet="one"]');
		assert.ok(button);
		await client.onClick({ target: button });
		assert.equal(opened.kind, 'personal');
		assert.equal(opened.params.library, 'shared');
		assert.equal(opened.params.snippet, 'one');
	} finally { dom.window.close(); }
});