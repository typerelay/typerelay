import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import pug from 'pug';

const tick = () => new Promise(resolve => setImmediate(resolve));

function page(name) {
	const html = pug.renderFile(fileURLToPath(new URL('../' + name + '.pug', import.meta.url)));
	const dom = new JSDOM(html, { url: 'https://extension.test', pretendToBeVisual: true });
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	return dom;
}

test('popup stays empty until search and Enter inserts the arrow-selected snippet', async () => {
	const dom = page('popup');
	const inserted = [];
	const items = [...Array.from({ length: 101 }, (_, index) => ({ id: 'generic-' + index, title: 'Snippet ' + index, trigger: 'snip' + index, library: 'Mine' })), { id: 'alpha', title: 'Alpha', trigger: 'al', library: 'Mine' }, { id: 'alpine', title: 'Alpine', trigger: 'alp', library: 'Mine' }];
	let closed = 0;
	dom.window.close = () => { closed++; };
	globalThis.chrome = { runtime: { sendMessage: async message => ({ ok: true, value: message.type === 'status' ? { connected: true, bridgeVerified: true } : message.type === 'snapshot' ? { items } : (inserted.push(message.id), {}) }), openOptionsPage: async () => {} } };
	await import('../popup.js?ui=' + randomUUID());
	await tick();
	const search = document.querySelector('#search');
	const results = document.querySelector('#results');
	assert.equal(document.activeElement, search);
	assert.equal(results.children.length, 0);
	assert.equal(results.hidden, true);
	search.value = 'al';
	search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(results.children.length, 2);
	assert.equal(results.children[0].getAttribute('aria-selected'), 'true');
	search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	assert.equal(results.children[1].getAttribute('aria-selected'), 'true');
	assert.equal(search.getAttribute('aria-activedescendant'), 'result-alpine');
	search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
	assert.equal(results.children[0].getAttribute('aria-selected'), 'true');
	search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await tick();
	assert.deepEqual(inserted, ['alpine']);
	assert.equal(closed, 1);
});

test('signed-out popup opens the options page', async () => {
	const dom = page('popup');
	let opened = 0;
	let closed = 0;
	dom.window.close = () => { closed++; };
	globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, value: { connected: false } }), openOptionsPage: async () => { opened++; } } };
	await import('../popup.js?ui=' + randomUUID());
	await tick();
	assert.equal(opened, 1);
	assert.equal(closed, 1);
});

test('options page updates account, sync and prefix controls in place', async () => {
	page('options');
	let state = { connected: false, authPending: false, count: 0, prefix: ';', origin: 'https://tr.n.lan' };
	let changed;
	globalThis.chrome = { permissions: { request: async ({ origins }) => { assert.deepEqual(origins, ['https://custom.example.com/*']); return true; } }, storage: { onChanged: { addListener: listener => { changed = listener; } } }, runtime: { getManifest: () => ({ version: '1.1.1' }), sendMessage: async message => {
		if (message.type === 'prefix' && message.value === '.') return { ok: false, error: 'Save failed' };
		if (message.type === 'connect') state = { ...state, authPending: true, origin: message.origin };
		if (message.type === 'sync') state = { ...state, count: 4, lastSync: Date.now() };
		if (message.type === 'prefix') state = { ...state, prefix: message.value };
		if (message.type === 'disconnect') state = { ...state, connected: false, count: 0 };
		return { ok: true, value: message.type === 'status' ? state : {} };
	} } };
	await import('../options.js?ui=' + randomUUID());
	await tick();
	const accountSection = document.querySelector('section');
	const prefix = document.querySelector('#prefix');
	assert.equal(document.querySelector('#server-form').hidden, false);
	assert.equal(document.querySelector('#server').value, 'tr.n.lan');
	document.querySelector('#reset-server').click();
	assert.equal(document.querySelector('#server').value, 'app.typerelay.com');
	document.querySelector('#server').value = 'custom.example.com';
	assert.equal(document.querySelector('#sync').disabled, true);
	document.querySelector('#connect').click();
	await tick();
	assert.equal(document.querySelector('#restart-connect').hidden, false);
	assert.equal(state.origin, 'https://custom.example.com');
	assert.equal(document.querySelector('section'), accountSection);
	state = { ...state, connected: true, authPending: false, count: 3 };
	changed({ tokens: {} }, 'local');
	await tick();
	assert.equal(document.querySelector('section'), accountSection);
	assert.equal(document.querySelector('#sync').disabled, false);
	document.querySelector('#sync').click();
	await tick();
	assert.match(document.querySelector('#sync-summary').textContent, /4 snippets/);
	assert.equal(document.querySelector('#sync-status').textContent, 'Synced');
	prefix.value = ',';
	prefix.dispatchEvent(new window.Event('change', { bubbles: true }));
	await tick();
	assert.equal(document.querySelector('#prefix'), prefix);
	assert.equal(document.querySelector('#prefix-status').textContent, 'Saved');
	prefix.value = '.';
	prefix.dispatchEvent(new window.Event('change', { bubbles: true }));
	await tick();
	assert.equal(prefix.value, ',');
	assert.equal(document.querySelector('#prefix-status').textContent, 'Save failed');
	document.querySelector('#disconnect').click();
	await tick();
	assert.equal(document.querySelector('section'), accountSection);
	assert.equal(document.querySelector('#account-state').textContent, 'Signed out');
});
