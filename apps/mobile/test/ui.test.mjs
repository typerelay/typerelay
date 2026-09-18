// Frontend checks are supplied for the user to run; they are not part of agent-run backend checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
