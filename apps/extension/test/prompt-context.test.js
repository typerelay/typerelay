import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import pug from 'pug';
import { promptFields } from '../prompt.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
for (const dialog of [false, true]) for (const action of ['submit', 'cancel', 'Escape']) test(`template ${action} retains focus ${dialog ? 'inside a Bootstrap modal' : 'on an ordinary page'}`, async () => {
 const markup = dialog ? '<div id="dialog" class="modal" role="dialog" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><textarea></textarea></div></div></div>' : '<textarea></textarea>';
 const dom = new JSDOM(markup, { url: 'https://example.test', runScripts: 'outside-only' });
 try {
  const { window } = dom; const document = window.document; document.hasFocus = () => true;
  if (dialog) { window.eval(readFileSync(new URL('../../server/node_modules/bootstrap/dist/js/bootstrap.bundle.js', import.meta.url), 'utf8')); window.bootstrap.Modal.getOrCreateInstance(document.querySelector('#dialog'), { backdrop: 'static' }).show(); }
  let shadow; const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  window.realPromptFields = promptFields;
  window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { getURL: name => name, onMessage: { addListener() {} }, sendMessage: async message => {
   if (message.type === 'prepare') return { ok: true, value: { item: { id: 'one', library_id: 'library', content: { type: 'template' } }, rendered: { fields: message.preview ? ['name'] : [], variables: {}, text: message.preview ? 'Hello [name]' : 'Hello ' + message.values.name } } };
   return { ok: true, value: { items: [], verified: true } };
  } } };
  const html = pug.renderFile(new URL('../prompt.pug', import.meta.url).pathname);
  window.fetch = async name => ({ text: async () => name === 'prompt.html' ? html : '' });
  document.execCommand = (_command, _ui, text) => { const editor = document.activeElement; editor.value = editor.value.slice(0, editor.selectionStart) + text + editor.value.slice(editor.selectionEnd); editor.setSelectionRange(text.length, text.length); return true; };
  const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8').replace("await import(chrome.runtime.getURL('prompt.js'))", '({ promptFields: window.realPromptFields })').replace('})();', 'window.testExpand = expand; })();');
  window.eval(source);
  const editor = document.querySelector('textarea'); editor.value = ';brb'; editor.focus(); editor.setSelectionRange(4, 4);
  const expansion = window.testExpand(editor, { start: 4, end: 4 }, 'one', ';brb', 4);
  await tick(); await tick();
  const host = shadow.host; const field = shadow.querySelector('input');
  assert.equal(host.shadowRoot, null); assert.equal(host.parentElement, dialog ? document.querySelector('#dialog') : document.documentElement);
  assert.equal(shadow.activeElement, field); assert.equal(document.activeElement, host);
  if (action === 'submit') { field.value = 'Ada'; shadow.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  else if (action === 'cancel') shadow.querySelector('[data-cancel]').click();
  else field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await expansion;
  assert.equal(host.isConnected, false); assert.equal(document.activeElement, editor); assert.equal(editor.value, action === 'submit' ? 'Hello Ada' : ';brb');
  if (action !== 'submit') { assert.equal(editor.selectionStart, 4); assert.equal(editor.selectionEnd, 4); }
 } finally { dom.window.close(); }
});
