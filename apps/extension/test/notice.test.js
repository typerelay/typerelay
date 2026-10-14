import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const css = readFileSync(new URL('../notice.css', import.meta.url), 'utf8');

async function fixture(message, { failFetch = false } = {}) {
	const dom = new JSDOM('<textarea></textarea>', { url: 'https://example.test', runScripts: 'outside-only' });
	const { window } = dom;
	const document = window.document;
	const handlers = {};
	const add = document.addEventListener.bind(document);
	document.addEventListener = (type, handler, ...args) => { handlers[type] = handler; add(type, handler, ...args); };
	document.hasFocus = () => true;
	let shadow;
	const attach = window.Element.prototype.attachShadow;
	window.Element.prototype.attachShadow = function (init) { shadow = attach.call(this, init); return shadow; };
	const timers = [];
	window.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
	window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { getURL: name => name, onMessage: { addListener() {} }, sendMessage: async request => {
		if (request.type === 'snapshot') return { ok: true, value: { items: [{ id: 'one', trigger: 'brb' }], prefix: ';' } };
		if (request.type === 'claim') return { ok: true, value: { verified: true } };
		if (request.type === 'match') return { ok: false, error: message };
		return { ok: true, value: {} };
	} } };
	window.fetch = async name => { if (failFetch) throw new Error('offline'); return { text: async () => (name === 'notice.css' ? css : '') }; };
	window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
	await tick();
	const editor = document.querySelector('textarea');
	editor.value = ';brb'; editor.focus(); editor.setSelectionRange(4, 4);
	await tick();
	return { window, document, editor, timers, shadow: () => shadow, trigger: async () => { handlers.keydown({ key: 'Enter', target: editor, isTrusted: true, preventDefault() {}, stopImmediatePropagation() {} }); await tick(); await tick(); await tick(); } };
}

test('HTML-looking messages render as literal text', async () => {
	const message = '<img src=x onerror=alert(1)>';
	const f = await fixture(message);
	try {
		await f.trigger();
		const span = f.shadow().querySelector('.notice span');
		assert.equal(span.textContent, message);
		assert.equal(span.children.length, 0);
		assert.equal(f.shadow().querySelector('img'), null);
	} finally { f.window.close(); }
});

test('notice keeps alert semantics and styling', async () => {
	const f = await fixture('Something went wrong');
	try {
		await f.trigger();
		const panel = f.shadow().querySelector('div.notice');
		assert.equal(panel.getAttribute('role'), 'alert');
		assert.equal(f.shadow().querySelector('style').textContent, css);
		assert.equal(f.document.documentElement.lastElementChild.shadowRoot, null);
		assert.ok(f.document.documentElement.contains(f.document.documentElement.lastElementChild));
	} finally { f.window.close(); }
});

test('notice is dismissed after five seconds', async () => {
	const f = await fixture('Bye soon');
	try {
		await f.trigger();
		const host = f.document.documentElement.lastElementChild;
		assert.equal(host.tagName, 'DIV');
		const timer = f.timers.find(entry => entry.delay === 5000);
		assert.ok(timer);
		timer.callback();
		assert.equal(host.isConnected, false);
	} finally { f.window.close(); }
});

test('notice does not move focus or change selection', async () => {
	const f = await fixture('Leave my field alone');
	try {
		await f.trigger();
		assert.ok(f.shadow().querySelector('.notice'));
		assert.equal(f.document.activeElement, f.editor);
		assert.equal(f.editor.selectionStart, 4);
		assert.equal(f.editor.selectionEnd, 4);
	} finally { f.window.close(); }
});

test('notice fails quietly when its stylesheet cannot load', async () => {
	const f = await fixture('Offline', { failFetch: true });
	try {
		const before = f.document.documentElement.children.length;
		await f.trigger();
		assert.equal(f.document.documentElement.children.length, before);
		assert.equal(f.document.activeElement, f.editor);
	} finally { f.window.close(); }
});
