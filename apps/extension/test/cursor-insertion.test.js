import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

async function insertion(markup, rendered, value, start, end = start) {
 const dom = new JSDOM(markup, { url: 'https://cursor.test', runScripts: 'outside-only', pretendToBeVisual: true });
 const document = dom.window.document; const editor = document.querySelector('input,textarea'); let listener; const commands = [];
 editor.value = value;
 dom.window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener(callback) { listener = callback; } }, sendMessage: async message => ({ ok: true, value: message.type === 'prepare' ? { rendered, item: { content: { type: 'template' } } } : { items: [] } }) } };
 document.execCommand = (command, _ui, text) => { commands.push(command); editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end'); return true; };
 dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
 editor.focus(); editor.setSelectionRange(start, end);
 const reply = await new Promise(resolve => listener({ type: 'insert', id: 'cursor' }, {}, resolve));
 return { dom, editor, commands, reply };
}

test('cursor insertion positions within rendered Unicode text and preserves surrounding value', async () => {
 const fixture = await insertion('<textarea></textarea>', { text: '😀e\u0301\nworld', fields: [], cursor: { utf16: 5, backward_utf16: 5, backward_graphemes: 5 } }, 'before after', 7);
 try { assert.equal(fixture.reply.ok, true); assert.equal(fixture.editor.value, 'before 😀e\u0301\nworldafter'); assert.equal(fixture.editor.selectionStart, 12); assert.equal(fixture.editor.selectionEnd, 12); assert.deepEqual(fixture.commands, ['insertText']); } finally { fixture.dom.window.close(); }
});

test('marked insertion rejects maxlength truncation and single-line multiline fields before mutation', async () => {
 for (const [markup, rendered, value, start, end, message] of [
  ['<input maxlength="4">', { text: 'abcd', fields: [], cursor: { utf16: 3 } }, 'XXYY', 0, 2, /too short/],
  ['<textarea maxlength="4"></textarea>', { text: 'abcd', fields: [], cursor: { utf16: 3 } }, 'XXYY', 0, 2, /too short/],
  ['<input>', { text: 'a\nbc', fields: [], cursor: { utf16: 2 } }, 'existing', 0, 0, /single-line/]
 ]) {
  const fixture = await insertion(markup, rendered, value, start, end);
  try { assert.equal(fixture.reply.ok, false); assert.match(fixture.reply.error, message); assert.equal(fixture.editor.value, value); assert.deepEqual(fixture.commands, []); } finally { fixture.dom.window.close(); }
 }
});


test('cursor insertion accepts long suffixes at start, middle and end', async () => {
 const text = 'a'.repeat(60000);
 for (const offset of [0, 30000, 60000]) {
  const fixture = await insertion('<textarea></textarea>', { text, fields: [], cursor: { utf16: offset, backward_utf16: text.length - offset, backward_graphemes: text.length - offset } }, 'before after', 7);
  try { assert.equal(fixture.reply.ok, true); assert.equal(fixture.editor.value, 'before ' + text + 'after'); assert.equal(fixture.editor.selectionStart, 7 + offset); assert.equal(fixture.editor.selectionEnd, 7 + offset); } finally { fixture.dom.window.close(); }
 }
});
