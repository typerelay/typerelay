import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

test('personal abbreviation updates only its row and ignores duplicate and out-of-order responses', async () => {
	const snippets = [{ id: 'one', title: 'One', trigger: 'tw', effective_trigger: 'tw', replace: 'Shared', revision: 1, personal: { revision: 0, trigger: null, conflicts: [] } }, { id: 'two', title: 'Two', trigger: 'other', replace: 'Other', revision: 1 }];
	const library = { _id: 'shared', name: 'Shared', shared: true, revision: 1, permissions: { edit: true, manage: true }, snippets };
	const dom = new JSDOM('<div id="libraries"></div>' + pug.renderFile('./views/ajax/editor.pug', { library }), { runScripts: 'outside-only', pretendToBeVisual: true });
	try {
		const source = (await readFile('./public/app.js', 'utf8')).replace(/^import .*;$/gm, '').replace('const client = new TypeRelay();', '').replace('export { client };', 'window.TypeRelay = TypeRelay;');
		dom.window.eval(source);
		const client = Object.create(dom.window.TypeRelay.prototype);
		Object.assign(client, { libraries: new Map([['shared', library]]), tombstones: new Set(), selected: 'shared', selectedSnippets: new Set(['one']) });
		client.request = () => { throw new Error('No page, section, or library reload allowed'); };
		const document = dom.window.document;
		const container = document.querySelector('#snippets'); const sibling = document.querySelector('[data-snippet="two"]');
		document.querySelector('[data-personal-snippet="one"]').focus();
		const updated = { ...snippets[0], effective_trigger: 'mine', personal: { revision: 1, trigger: 'mine', conflicts: [] } };
		const result = { personal_sequence: 5, personal_fragments: [{ library: 'shared', snippet: updated, html: pug.renderFile('./views/ajax/snippet.pug', { library, snippet: updated }) }] };
		await client.apply(result);
		const node = document.querySelector('[data-snippet="one"]');
		await client.apply(result);
		await client.apply({ personal_sequence: 4, personal_fragments: [{ ...result.personal_fragments[0], snippet: { ...updated, effective_trigger: 'stale' } }] });
		assert.equal(document.querySelector('[data-snippet="one"]'), node);
		assert.equal(document.querySelector('[data-snippet="two"]'), sibling);
		assert.equal(document.querySelector('#snippets'), container);
		assert.equal(document.activeElement.dataset.personalSnippet, 'one');
		assert.equal(document.querySelector('[data-select-snippet="one"]').checked, true);
		assert.equal(library.snippets[0].trigger, 'tw');
		assert.equal(library.snippets[0].effective_trigger, 'mine');
		assert.match(node.textContent, /mine/);
	} finally { dom.window.close(); }
});

test('snippet edits and creates reorder individual rows without reloading or losing focus and selection', async () => {
	const snippets = [{ id: 'old', trigger: 'old', replace: 'Old', revision: 1 }, { id: 'new', trigger: 'new', replace: 'New', revision: 1 }];
	const library = { _id: 'one', name: 'Library', revision: 1, permissions: { edit: true, manage: true }, snippets };
	const dom = new JSDOM('<div id="libraries"></div>' + pug.renderFile('./views/ajax/editor.pug', { library }), { runScripts: 'outside-only', pretendToBeVisual: true });
	try {
		const source = (await readFile('./public/app.js', 'utf8')).replace(/^import .*;$/gm, '').replace('const client = new TypeRelay();', '').replace('export { client };', 'window.TypeRelay = TypeRelay;');
		dom.window.eval(source);
		const client = Object.create(dom.window.TypeRelay.prototype);
		Object.assign(client, { libraries: new Map([['one', library]]), tombstones: new Set(), selected: 'one', selectedSnippets: new Set(['old']) });
		client.request = () => { throw new Error('Unexpected fetch or reload'); };
		const { document } = dom.window;
		const container = document.querySelector('#snippets');
		const editor = container.parentNode;
		const sibling = document.querySelector('[data-snippet="old"]');
		document.querySelector('[data-edit-snippet="new"]').focus();
		const updated = { ...library, revision: 2, snippets: [{ ...snippets[1], revision: 2, replace: 'Edited' }, snippets[0]] };
		const result = { library: updated, html: '<div data-id="one"></div>', fragments: updated.snippets.map(snippet => ({ id: snippet.id, revision: snippet.revision, html: pug.renderFile('./views/ajax/snippet.pug', { library, snippet }) })) };
		await client.apply(result);
		await client.apply(result);
		await client.apply({ ...result, library });
		assert.deepEqual([...container.children].map(node => node.dataset.snippet), ['new', 'old']);
		assert.equal(document.querySelector('[data-snippet="old"]'), sibling);
		assert.equal(document.querySelector('#snippets'), container);
		assert.equal(container.parentNode, editor);
		assert.equal(document.activeElement.dataset.editSnippet, 'new');
		assert.equal(document.querySelector('[data-select-snippet="old"]').checked, true);
		assert.equal(document.querySelector('[data-snippet="new"] pre').textContent, 'Edited');
		client.request = async (path, method, body) => {
			assert.equal(path, 'libraries/one/snippets');
			assert.equal(method, 'POST');
			assert.equal(Object.hasOwn(body.changes[0], 'touch'), false, 'Web Save must not force an unchanged snippet update');
			return result;
		};
		client.poll = async () => {};
		await client.snippet('new', { trigger: 'new', replace: 'Edited' });
		assert.equal(document.querySelector('#snippets'), container);

		const created = { id: 'created', trigger: 'created', replace: 'Created', revision: 1 };
		await client.apply({ library: { ...updated, revision: 3, snippets: [created, ...updated.snippets] }, html: result.html, fragments: [{ id: created.id, revision: 1, html: pug.renderFile('./views/ajax/snippet.pug', { library, snippet: created }) }, ...result.fragments] });
		assert.deepEqual([...container.children].map(node => node.dataset.snippet), ['created', 'new', 'old']);
	} finally { dom.window.close(); }
});

test('active snippets sort by update timestamp, retaining legacy order without timestamps', async () => {
	const { Libraries } = await import('../services/libraries.js');
	const { Snippet } = await import('../model/index.js');
	assert.equal(Snippet.schema.options.timestamps, true);
	const original = Snippet.find;
	const entries = [{ id: 'legacy', state: 'active' }, { id: 'older', state: 'active', updatedAt: new Date('2026-09-01') }, { id: 'latest', state: 'active', updatedAt: new Date('2026-09-16') }, { id: 'trash', state: 'trashed', updatedAt: new Date('2026-09-17') }, { id: 'legacy2', state: 'active' }];
	Snippet.find = () => ({ sort() { return this; }, session() { return this; }, lean: async () => entries });
	try {
		const result = await Libraries.hydrate({ _id: 'one' });
		assert.deepEqual(result.snippets.map(snippet => snippet.id), ['latest', 'older', 'legacy', 'legacy2']);
		assert.deepEqual(result.records.map(snippet => snippet.id), entries.map(snippet => snippet.id));
	} finally { Snippet.find = original; }
});
