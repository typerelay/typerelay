import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
	globalThis.chrome = { permissions: { request: async ({ origins }) => { assert.deepEqual(origins, ['https://custom.example.com/*']); return true; } }, storage: { onChanged: { addListener: listener => { changed = listener; } } }, runtime: { getManifest: () => ({ version: '1.2.0' }), sendMessage: async message => {
		if (message.type === 'prefix' && message.value === '.') return { ok: false, error: 'Save failed' };
		if (message.type === 'connect') state = { ...state, authPending: true, origin: message.origin };
		if (message.type === 'sync') state = { ...state, count: 4, lastSync: Date.now() };
		if (message.type === 'prefix') state = { ...state, prefix: message.value };
		if (message.type === 'disconnect') state = { ...state, connected: false, count: 0 };
		return { ok: true, value: message.type === 'status' ? state : {} };
	} } };
	await import('../options.js?ui=' + randomUUID());
	await tick();
	assert.equal(document.querySelector('#version').textContent, 'Typerelay Extension Version 1.2.0');
	assert.equal(document.querySelector('a[href="mailto:hi@typerelay.com"]').textContent, 'Email');
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

test('Detail previews toggle independently without inserting and ignore stale responses', async () => {
	const dom = page('popup');
	const inserted = [];
	const pending = [];
	const items = [{ id: 'one', title: 'One', library: 'Mine' }, { id: 'two', title: 'Two', library: 'Mine' }];
	dom.window.close = () => {};
	globalThis.chrome = { runtime: { sendMessage: async message => {
		if (message.type === 'status') return { ok: true, value: { connected: true, bridgeVerified: true, origin: 'https://custom.example.com' } };
		if (message.type === 'snapshot') return { ok: true, value: { items } };
		if (message.type === 'prepare') { assert.equal(message.preview, true); return new Promise(resolve => pending.push(resolve)); }
		if (message.type === 'insert') inserted.push(message.id);
		return { ok: true, value: {} };
	} } };
	await import('../popup.js?ui=' + randomUUID());
	await tick();
	const search = document.querySelector('#search');
	const results = document.querySelector('#results');
	search.value = 'Mine';
	search.dispatchEvent(new dom.window.Event('input'));
	const [one, two] = results.children;
	results.scrollTop = 15;
	one.querySelector('.detail').click();
	assert.equal(document.activeElement, search);
	assert.equal(one.querySelector('.preview-status').textContent, 'Loading…');
	pending.shift()({ ok: true, value: { item: { content: { type: 'rich_text' } }, rendered: { html: '<p><strong>Bold</strong><a href="https://example.com">Link</a><img src="data:image/png;base64,AQID"><img src="https://example.com/track"><script>alert(1)</script></p>' } } });
	await tick();
	const frame = one.querySelector('iframe');
	assert.equal(frame.hidden, false);
	assert.equal(frame.getAttribute('sandbox'), '');
	assert.match(frame.srcdoc, /default-src 'none'/);
	assert.match(frame.srcdoc, /<strong>Bold<\/strong>/);
	assert.match(frame.srcdoc, /data:image\/png/);
	assert.doesNotMatch(frame.srcdoc, /href=|https:\/\/example.com|<script/);
	one.querySelector('.preview').click();
	assert.deepEqual(inserted, []);
	two.querySelector('.detail').click();
	pending.shift()({ ok: true, value: { item: { content: { type: 'template' } }, rendered: { text: 'Hello\n[name]' } } });
	await tick();
	assert.equal(two.querySelector('pre').textContent, 'Hello\n[name]');
	assert.equal(one.querySelector('.preview').hidden, false);
	assert.equal(two.querySelector('.preview').hidden, false);
	assert.equal(results.children[0], one);
	assert.equal(results.scrollTop, 15);
	search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
	await tick();
	assert.deepEqual(inserted, ['two']);
	one.querySelector('.detail').click();
	assert.equal(one.querySelector('.preview').hidden, true);
	one.querySelector('.detail').click();
	pending.shift()({ ok: false, error: 'Preview failed' });
	await tick();
	assert.equal(one.querySelector('.preview-status').textContent, 'Preview failed');
	one.querySelector('.detail').click();
	one.querySelector('.detail').click();
	const stale = pending.shift();
	search.value = 'Two';
	search.dispatchEvent(new dom.window.Event('input'));
	stale({ ok: true, value: { item: { content: { type: 'plain_text' } }, rendered: { text: 'Stale preview' } } });
	await tick();
	assert.equal(results.children.length, 1);
	assert.equal(results.querySelector('.preview').hidden, true);
	assert.doesNotMatch(results.textContent, /Stale preview/);
	results.querySelector('.result-summary').click();
	await tick();
	assert.deepEqual(inserted, ['two', 'two']);
});

for (const url of ['https://docs.google.com/document/d/example/edit', 'about:blank']) test(`Google Docs guard covers ${url}`, () => {
	const dom = new JSDOM('<textarea></textarea>', { url, runScripts: 'outside-only' });
	try {
		let listener;
		const sent = [];
		Object.defineProperty(dom.window.location, 'ancestorOrigins', { value: url === 'about:blank' ? ['https://docs.google.com'] : [] });
		dom.window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener: value => { listener = value; } }, sendMessage: async message => { sent.push(message.type); return { ok: true, value: { items: [], prefix: ';' } }; } } };
		dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
		dom.window.document.querySelector('textarea').focus();
		let response;
		listener({ type: 'insert', id: 'snippet' }, {}, value => { response = value; });
		assert.equal(response.ok, false);
		assert.match(response.error, /Google Docs insertion is not supported yet/);
		assert.equal(sent.includes('prepare'), false);
		assert.equal(sent.includes('claim'), false);
	} finally { dom.window.close(); }
});
