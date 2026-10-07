import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pug from 'pug';
import { JSDOM } from 'jsdom';

test('cursor-only editor previews are visible on reopen and hide after removal or invalid source', async () => {
 const markup = pug.renderFile(fileURLToPath(new URL('../views/ajax/template-editor.pug', import.meta.url)), { snippet: { content: { variables: {} } } });
 const dom = new JSDOM('<select id="snippet-type"><option value="template">Text</option><option value="code">Code</option></select><textarea id="replace">Hi {{cursor:here}}there</textarea>' + markup, { runScripts: 'outside-only' });
 const document = dom.window.document; let result = { template: { variables: {} }, steps: [{ kind: 'text', text: 'Hi there' }], text: 'Hi there', cursor: { utf16: 3 } };
 dom.window.TemplateRuntime = { render: async () => { if (result instanceof Error) throw result; return result; }, preview: output => output.cursor ? 'Hi ▏ [Cursor position]there' : output.text };
 dom.window.eval(readFileSync(new URL('../public/template-editor.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace('export class TemplateEditor', 'window.TemplateEditor = class TemplateEditor').replace('export class TemplateFill', 'window.TemplateFill = class TemplateFill'));
 try {
  const editor = new dom.window.TemplateEditor({ codeReadonly: false }); editor.attach(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('#template-preview').hidden, false); assert.match(document.querySelector('#template-preview').textContent, /Cursor position/);
  result = { template: { variables: {} }, steps: [{ kind: 'text', text: 'Hi there' }], text: 'Hi there' }; await editor.preview(); assert.equal(document.querySelector('#template-preview').hidden, true);
  result = new Error('Only one marker'); await editor.preview(); assert.equal(document.querySelector('#template-preview').hidden, true); assert.equal(document.querySelector('#template-error').textContent, 'Only one marker');
  document.querySelector('#snippet-type').value = 'code'; editor.attach(); assert.equal(document.querySelector('#template-options').hidden, true);
 } finally { dom.window.close(); }
});
