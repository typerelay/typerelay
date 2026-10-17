// Frontend checks are supplied for the user to run; they are not part of agent-run backend checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Items } from '../src/items.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const pug = require('pug');
const render = pug.compileFile(fileURLToPath(new URL('../views/ajax/row.pug', import.meta.url)));

class Fixture {
 constructor() {
  this.dom = new JSDOM('<main><input id="filter" value="greeting"><section id="panel"><div id="snippets"></div></section><textarea id="draft">Unsaved draft</textarea></main>');
  this.list = this.dom.window.document.getElementById('snippets');
  this.libraries = [{ _id: 'library', name: 'Team', editor_revision: 1, permissions: { read: true, edit: true }, records: ['one','two'].map(id => ({ id, title: id, trigger: id, revision: 1, content: { version: 1, type: 'plain_text', text: 'Original' } })) }];
 }
 update() { Items.update(this.list, this.libraries, render); }
}

test('save updates one item while keeping panel, other rows, filter and draft', () => {
 const fixture = new Fixture(); fixture.update();
 const panel = fixture.list.parentElement; const first = fixture.list.children[0]; const second = fixture.list.children[1]; fixture.list.scrollTop = 75;
 fixture.libraries[0].records[0].content.text = 'Edited immediately'; fixture.update();
 assert.equal(fixture.list.parentElement, panel); assert.equal(fixture.list.children[1], second); assert.notEqual(fixture.list.children[0], first);
 assert.match(fixture.list.children[0].textContent, /Edited immediately/); assert.equal(fixture.list.scrollTop, 75);
 assert.equal(fixture.dom.window.document.getElementById('filter').value, 'greeting'); assert.equal(fixture.dom.window.document.getElementById('draft').value, 'Unsaved draft'); fixture.dom.window.close();
});

test('duplicate snapshots do not duplicate rows; create/delete preserve the list', () => {
 const fixture = new Fixture(); fixture.update(); const first = fixture.list.firstElementChild;
 fixture.update(); assert.equal(fixture.list.firstElementChild, first); assert.equal(fixture.list.children.length, 2);
 fixture.libraries[0].records.push({ ...fixture.libraries[0].records[0], id: 'three' }); fixture.update(); assert.equal(fixture.list.children.length, 3);
 fixture.libraries[0].records.splice(1, 1); fixture.update(); assert.equal(fixture.list.children.length, 2); assert.equal(fixture.list.firstElementChild, first); fixture.dom.window.close();
});

test('updating a focused row preserves its initiating control', () => {
 const fixture = new Fixture(); fixture.update(); fixture.list.querySelector('[data-use]').focus();
 fixture.libraries[0].records[0].title = 'Renamed'; fixture.update();
 assert.equal(fixture.dom.window.document.activeElement.dataset.use, 'one'); fixture.dom.window.close();
});


test('template answers refresh only the current drawer preview and ignore stale renders', async () => {
 const dom = new JSDOM('<div id="detail-modal"><div id="detail-content"></div></div>', { runScripts: 'outside-only' });
 try {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf(' static async use('), source.indexOf(' static async showReview('));
  const fill = pug.compileFile(fileURLToPath(new URL('../views/ajax/fill.pug', import.meta.url)));
  dom.window.fill = fill;
  dom.window.Modal = { getOrCreateInstance: node => ({ show: () => node.classList.add('show') }) };
  const renders = [];
  dom.window.Native = { call: async (action, request) => { assert.equal(action, 'keyboard_render'); if (!request.values) return { fields: ['name'], text: 'Hello [name]', variables: {} }; return new Promise((resolve, reject) => renders.push({ request, resolve, reject })); } };
  dom.window.eval(stripTypeScriptTypes('window.MobileApp = class MobileApp { static state = { generation: "one" }; static $(id) { return document.getElementById(id); } static fragment(html) { const template = document.createElement("template"); template.innerHTML = html; return template.content.firstElementChild; } static error(error) { throw error; } ' + method + '}'));
  const library = { _id: 'library', permissions: { edit: false } }; const snippet = { id: 'snippet', title: 'Greeting', trigger: 'hello' };
  await dom.window.MobileApp.use(library, snippet);
  const form = dom.window.document.querySelector('#fill-form'); const field = form.querySelector('textarea'); const preview = form.querySelector('#insert-preview');
  field.focus(); field.value = 'First'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.value = 'Latest'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(renders[1].request.values.name, 'Latest'); assert.equal(renders[1].request.preview, true);
  renders[1].resolve({ text: 'Hello Latest' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(preview.textContent, 'Hello Latest'); assert.equal(dom.window.document.activeElement, field);
  renders[0].resolve({ text: 'Hello First' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(preview.textContent, 'Hello Latest');
  field.value = 'Closed'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#detail-modal').classList.remove('show'); renders[2].resolve({ text: 'Closed drawer' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(preview.textContent, 'Hello Latest');
  dom.window.document.querySelector('#detail-modal').classList.add('show'); field.value = 'Replaced'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await dom.window.MobileApp.use(library, snippet); renders[3].resolve({ text: 'Old drawer' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.window.document.querySelector('#insert-preview').textContent, 'Hello [name]');
 } finally { dom.window.close(); }
});


test('a resumed stale draft saves as new without overwriting the original or duplicating a retry', async () => {
 const dom = new JSDOM('<div id="form-modal"><button id="save"></button><button id="save-as-new"></button><button id="delete-editor-item"></button></div>', { runScripts: 'outside-only' });
 try {
  for (const [id, value] of Object.entries({ title: 'Local draft', trigger: 'shared', 'snippet-type': 'plain_text', language: 'plain_text', replace: 'Hello {{name}}', 'edit-library': 'library' })) { const field = dom.window.document.createElement('input'); field.id = id; field.value = value; dom.window.document.body.append(field); }
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const methods = source.slice(source.indexOf(' static async persistDraft('), source.indexOf(' static async use('));
  const remote = { id: 'original', revision: 2, text: 'Remote version' }; const saves = []; let draft; let failCopy = true; const copies = new Map();
  dom.window.Native = { call: async (action, request) => {
   if (action === 'draft') { draft = structuredClone(request.draft); return {}; }
   assert.equal(action, 'save'); saves.push(structuredClone(request));
   if (request.id) throw new Error('This snippet changed');
   assert.equal(draft.editing.operation_id, request.operation_id); assert.equal(draft.editing.id, undefined);
   if (failCopy) { assert.equal(dom.window.document.querySelector('#save').disabled, true); failCopy = false; throw new Error('Connection unavailable'); }
   if (!copies.has(request.operation_id)) copies.set(request.operation_id, { id: 'new-snippet', ...request.entry });
   return { id: 'new-snippet' };
  } };
  dom.window.Modal = { getInstance: () => ({ hide() {} }) };
  dom.window.eval(stripTypeScriptTypes('window.MobileApp = class MobileApp { static draftJob = Promise.resolve(); static editorDirty = true; static template = { variables: { name: { required: true } }, content: async () => ({ variables: { name: { required: true } } }) }; static $(id) { return document.getElementById(id); } static input(id) { return this.$(id); } static async load() {} static switchScreen() {} static toast() {} static async sync() {} ' + methods + '}'));
  const app = dom.window.MobileApp; app.editing = { library: 'library', id: 'original', record_revision: 1, revision: 1, operation_id: 'old-operation' };
  const saveButton = dom.window.document.querySelector('#save'); saveButton.disabled = true; await app.saveAsNew(); assert.equal(app.editing.id, 'original'); assert.equal(saves.length, 0); saveButton.disabled = false;
  await assert.rejects(app.save(), /This snippet changed/); assert.equal(saves[0].id, 'original'); assert.equal(saves[0].record_revision, 1);
  const copy = app.saveAsNew(); await app.saveAsNew(); await assert.rejects(copy, /Connection unavailable/);
  assert.equal(dom.window.document.querySelector('#save').disabled, false); assert.equal(saves.length, 2); const pending = saves[1]; assert.equal(pending.id, undefined); assert.equal(pending.record_revision, undefined); assert.notEqual(pending.operation_id, 'old-operation');
  assert.equal(pending.entry.trigger, ''); assert.equal(pending.entry.replace, 'Hello {{name}}'); assert.equal(pending.entry.variables.name.required, true);
  assert.equal(draft.fields.replace, 'Hello {{name}}'); assert.equal(draft.fields.trigger, '');
  await app.save(); assert.equal(saves[2].operation_id, pending.operation_id); assert.equal(copies.size, 1); assert.equal(draft, null);
  assert.deepEqual(remote, { id: 'original', revision: 2, text: 'Remote version' });
 } finally { dom.window.close(); }
});
