import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function insertion(markup, rendered, value, start, end = start) {
	const dom = new JSDOM(markup, { url: 'https://maxlength.test', runScripts: 'outside-only', pretendToBeVisual: true });
	const document = dom.window.document; const editor = document.querySelector('input,textarea'); let listener; const commands = [];
	editor.value = value;
	dom.window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener(callback) { listener = callback; } }, sendMessage: async message => ({ ok: true, value: message.type === 'prepare' ? { rendered, item: { content: { type: 'template' } } } : { items: [] } }) } };
	document.execCommand = (command, _ui, text) => { commands.push(command); editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end'); return true; };
	dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
	editor.focus(); editor.setSelectionRange(start, end);
	const reply = await new Promise(resolve => listener({ type: 'insert', id: 'snippet' }, {}, resolve));
	return { dom, editor, commands, reply };
}

async function abbreviation(markup, snippet, initial) {
	const dom = new JSDOM(markup, { url: 'https://maxlength.test', runScripts: 'outside-only', pretendToBeVisual: true });
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
		if (message.type === 'prepare') return { ok: true, value: { item: { content: { type: 'plain_text' } }, rendered: { text: snippet, fields: [] } } };
		return { ok: true, value: {} };
	} } };
	dom.window.fetch = async () => ({ text: async () => '' });
	document.execCommand = (command, _ui, text) => { commands.push(command); editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end'); return true; };
	dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
	await tick();
	const editor = document.querySelector('input,textarea');
	editor.value = initial; editor.focus(); editor.setSelectionRange(4, 4); await tick();
	const event = { key: ' ', target: editor, isTrusted: true, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
	handlers.keydown(event); await tick(); await tick(); await tick();
	return { dom, editor, commands, event };
}

test('oversized snippet in a maxlength input throws and leaves the field unchanged', async () => {
	const fixture = await insertion('<input maxlength="20">', { text: 'a'.repeat(26), fields: [] }, '', 0, 0);
	try { assert.equal(fixture.reply.ok, false); assert.match(fixture.reply.error, /too short/); assert.equal(fixture.editor.value, ''); assert.deepEqual(fixture.commands, []); } finally { fixture.dom.window.close(); }
});

test('snippet that fits exactly inserts', async () => {
	const fixture = await insertion('<input maxlength="26">', { text: 'a'.repeat(26), fields: [] }, '', 0, 0);
	try { assert.equal(fixture.reply.ok, true); assert.equal(fixture.editor.value, 'a'.repeat(26)); assert.deepEqual(fixture.commands, ['insertText']); } finally { fixture.dom.window.close(); }
});

test('field without maxlength accepts a long snippet', async () => {
	const fixture = await insertion('<input>', { text: 'a'.repeat(26), fields: [] }, '', 0, 0);
	try { assert.equal(fixture.reply.ok, true); assert.equal(fixture.editor.value, 'a'.repeat(26)); } finally { fixture.dom.window.close(); }
});

test('cursor snippet that fits still inserts and positions the cursor', async () => {
	const fixture = await insertion('<textarea maxlength="20"></textarea>', { text: 'Hi', fields: [], cursor: { utf16: 1 } }, 'before', 6, 6);
	try { assert.equal(fixture.reply.ok, true); assert.equal(fixture.editor.value, 'beforeHi'); assert.equal(fixture.editor.selectionStart, 7); assert.equal(fixture.editor.selectionEnd, 7); } finally { fixture.dom.window.close(); }
});

test('replacing an abbreviation that frees room inserts the complete snippet', async () => {
	const fixture = await abbreviation('<textarea maxlength="10"></textarea>', 'Hello!', ';brbXXXX');
	try { assert.equal(fixture.event.prevented, true); assert.equal(fixture.editor.value, 'Hello!XXXX'); assert.deepEqual(fixture.commands, ['insertText']); } finally { fixture.dom.window.close(); }
});