import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function abbreviation(markup, initial, key, prepare) {
	const dom = new JSDOM(markup, { url: 'https://failed.test', runScripts: 'outside-only', pretendToBeVisual: true });
	const document = dom.window.document;
	const handlers = {};
	const add = document.addEventListener.bind(document);
	document.addEventListener = (type, handler, ...args) => { handlers[type] = handler; add(type, handler, ...args); };
	document.hasFocus = () => true;
	const commands = [];
	dom.window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { getURL: name => name, onMessage: { addListener() {} }, sendMessage: async message => {
		if (message.type === 'snapshot') return { ok: true, value: { items: [{ id: 'one', trigger: 'brb' }], prefix: ';' } };
		if (message.type === 'claim') return { ok: true, value: { verified: true } };
		if (message.type === 'match') return { ok: true, value: { trigger: 'brb', erase: 4 } };
		if (message.type === 'prepare') return prepare();
		return { ok: true, value: {} };
	} } };
	dom.window.fetch = async () => ({ text: async () => '' });
	document.execCommand = (command, _ui, text) => { commands.push(command); const editor = document.querySelector('input,textarea'); editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end'); return true; };
	dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
	await tick();
	const editor = document.querySelector('input,textarea');
	editor.value = initial; editor.focus(); editor.setSelectionRange(4, 4); await tick();
	const event = { key, target: editor, isTrusted: true, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
	handlers.keydown(event); await tick(); await tick(); await tick();
	return { dom, editor, commands, event };
}

const tooShort = () => ({ ok: true, value: { item: { content: { type: 'plain_text' } }, rendered: { text: 'x'.repeat(9000), fields: [] } } });
const unavailable = () => ({ ok: false, error: 'Snippet no longer available' });

test('a space swallowed for a snippet that no longer fits is re-inserted', async () => {
	const fixture = await abbreviation('<textarea maxlength="10"></textarea>', ';brbXXXX', ' ', tooShort);
	try { assert.equal(fixture.event.prevented, true); assert.equal(fixture.editor.value, ';brb XXXX'); assert.deepEqual(fixture.commands, ['insertText']); } finally { fixture.dom.window.close(); }
});

test('an Enter swallowed for an unavailable snippet is re-inserted as a newline in a textarea', async () => {
	const fixture = await abbreviation('<textarea></textarea>', ';brbXXXX', 'Enter', unavailable);
	try { assert.equal(fixture.event.prevented, true); assert.equal(fixture.editor.value, ';brb\nXXXX'); assert.deepEqual(fixture.commands, ['insertText']); } finally { fixture.dom.window.close(); }
});

test('a space swallowed for an unavailable snippet is re-inserted in an input', async () => {
	const fixture = await abbreviation('<input>', ';brbXXXX', ' ', unavailable);
	try { assert.equal(fixture.event.prevented, true); assert.equal(fixture.editor.value, ';brb XXXX'); } finally { fixture.dom.window.close(); }
});

test('an Enter swallowed for an unavailable snippet leaves a single-line input unchanged', async () => {
	const fixture = await abbreviation('<input>', ';brbXXXX', 'Enter', unavailable);
	try { assert.equal(fixture.event.prevented, true); assert.equal(fixture.editor.value, ';brbXXXX'); assert.deepEqual(fixture.commands, []); } finally { fixture.dom.window.close(); }
});

test('a successful expansion never re-inserts the delimiter', async () => {
	const fixture = await abbreviation('<textarea></textarea>', ';brbXXXX', ' ', () => ({ ok: true, value: { item: { content: { type: 'plain_text' } }, rendered: { text: 'Hello!', fields: [] } } }));
	try { assert.equal(fixture.event.prevented, true); assert.equal(fixture.editor.value, 'Hello!XXXX'); assert.deepEqual(fixture.commands, ['insertText']); } finally { fixture.dom.window.close(); }
});