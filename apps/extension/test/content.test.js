import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture() {
	const dom = new JSDOM('<textarea></textarea><input>', { url: 'https://example.test', runScripts: 'outside-only' });
	const document = dom.window.document;
	const handlers = {};
	const add = document.addEventListener.bind(document);
	document.addEventListener = (type, handler, ...args) => { handlers[type] = handler; add(type, handler, ...args); };
	document.hasFocus = () => true;
	const messages = [];
	let delayed;
	dom.window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { getURL: name => name, onMessage: { addListener() {} }, sendMessage: async message => {
		messages.push(message.type);
		if (message.type === 'snapshot') return { ok: true, value: { items: [{ id: 'one', trigger: 'brb' }], prefix: ';' } };
		if (message.type === 'claim') return { ok: true, value: { verified: true } };
		if (message.type === 'match') return { ok: true, value: { trigger: 'brb', erase: 4 } };
		if (message.type === 'prepare') { if (delayed) await delayed; return { ok: true, value: { item: { content: { type: 'plain_text' } }, rendered: { text: 'Hello' } } }; }
		return { ok: true, value: {} };
	} } };
	dom.window.fetch = async () => ({ text: async () => '<span data-message></span>' });
	document.execCommand = (_command, _ui, text) => { const editor = document.activeElement; editor.value = editor.value.slice(0, editor.selectionStart) + text + editor.value.slice(editor.selectionEnd); return true; };
	dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
	await tick();
	const editor = document.querySelector('textarea'); editor.value = ';brb'; editor.focus(); editor.setSelectionRange(4, 4); await tick();
	const event = (key, options = {}) => ({ key, target: editor, isTrusted: true, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options });
	return { dom, editor, handlers, messages, event, delay: promise => { delayed = promise; } };
}

for (const key of [' ', 'Enter']) test(`${key === ' ' ? 'Space' : 'Enter'} consumes match and held repeats, inserts once`, async () => {
	const f = await fixture();
	try {
		const first = f.event(key); f.handlers.keydown(first); assert.equal(first.prevented, true);
		const repeat = f.event(key, { repeat: true }); f.handlers.keydown(repeat); assert.equal(repeat.prevented, true);
		const up = f.event(key); f.handlers.keyup(up); assert.equal(up.stopped, true);
		const tap = f.event(key); f.handlers.keydown(tap); assert.equal(tap.prevented, true);
		await tick(); await tick();
		assert.equal(f.editor.value, 'Hello'); assert.equal(f.messages.filter(type => type === 'match').length, 1);
	} finally { f.dom.window.close(); }
});

test('unmatched, modified, repeated and composing Enter pass normally', async () => {
	const f = await fixture();
	try {
		for (const options of [{ shiftKey: true }, { ctrlKey: true }, { repeat: true }, { isComposing: true }]) { const event = f.event('Enter', options); f.handlers.keydown(event); assert.equal(event.prevented, undefined); }
		f.editor.value = ';missing'; f.editor.setSelectionRange(8, 8);
		const event = f.event('Enter'); f.handlers.keydown(event); assert.equal(event.prevented, undefined);
	} finally { f.dom.window.close(); }
});

test('late preparation cannot steal focus or submit', async () => {
	const f = await fixture();
	try {
		let finish; f.delay(new Promise(resolve => { finish = resolve; }));
		const event = f.event('Enter'); f.handlers.keydown(event); await tick();
		const other = f.dom.window.document.querySelector('input'); other.focus(); finish(); await tick(); await tick();
		assert.equal(f.editor.value, ';brb'); assert.equal(f.dom.window.document.activeElement, other); assert.equal(event.prevented, true);
	} finally { f.dom.window.close(); }
});

test('pending guards survive another editor finishing and distinguish keypad release', async () => {
	const f = await fixture();
	try {
		let finish; f.delay(new Promise(resolve => { finish = resolve; }));
		f.handlers.keydown(f.event('Enter', { code: 'Enter' }));
		const keypadUp = f.event('Enter', { code: 'NumpadEnter' }); f.handlers.keyup(keypadUp); assert.equal(keypadUp.stopped, undefined);
		const held = f.event('Enter', { code: 'Enter', repeat: true }); f.handlers.keydown(held); assert.equal(held.prevented, true);
		f.handlers.keyup(f.event('Enter', { code: 'Enter' }));
		const other = f.dom.window.document.querySelector('input'); other.value = ';brb'; other.focus(); other.setSelectionRange(4, 4);
		f.handlers.keydown(f.event('Enter', { target: other, code: 'Enter' })); f.handlers.keyup(f.event('Enter', { target: other, code: 'Enter' })); await tick();
		const second = f.event('Enter', { target: other, code: 'Enter' }); f.handlers.keydown(second); assert.equal(second.prevented, true);
		assert.equal(f.messages.filter(type => type === 'match').length, 2);
		finish(); await tick(); await tick(); assert.equal(f.editor.value, ';brb'); assert.equal(other.value, 'Hello');
	} finally { f.dom.window.close(); }
});
