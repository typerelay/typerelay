import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Runtime } from '../runtime.js';

globalThis.chrome = { runtime: { getURL: name => name } };
globalThis.fetch = async name => { assert.equal(name, 'template.wasm'); return new Response(await readFile(new URL('../../../target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm', import.meta.url)), { headers: { 'Content-Type': 'application/wasm' } }); };

test('shared Rust matcher confirms browser abbreviation and rejects partial text', async () => {
	assert.deepEqual(await Runtime.match('hello;brb', ';', ['brb']), { trigger: 'brb', erase: 4 });
	assert.equal(await Runtime.match('hello;br', ';', ['brb']), null);
	assert.equal(await Runtime.match('hello,brb', ';', ['brb']), null);
});

test('shared renderers expose prompts, dates, Enter actions and rich formatting', async () => {
	const template = await Runtime.template({ text: 'Hi {{name}} {{date}}{{key:enter}}', variables: {} }, { name: 'Ada' }, false);
	assert.match(template.text, /^Hi Ada /);
	assert.equal(template.enter_actions, 1);
	const rich = await Runtime.rich({ markdown: '**Hello**', variables: {} }, {}, false, {});
	assert.match(rich.html, /<strong>Hello<\/strong>/);
	const id = 'a'.repeat(64);
	const image = await Runtime.rich({ markdown: `![Icon](typerelay-asset:${id})`, variables: {} }, {}, false, { [id]: 'data:image/png;base64,AA==' });
	assert.match(image.html, /src="data:image\/png;base64,AA=="/);
});

test('the shared WASM exposes ordered Tab actions and omits them from copied text', async () => {
	const template = await Runtime.template({ text: '{{name}}{{key:tab}}Last{{key:enter}}' }, { name: '{{key:tab}}' }, false);
	assert.equal(template.tab_actions, 1);
	assert.equal(template.text, '{{key:tab}}Last');
	assert.deepEqual(template.steps.map(step => step.kind), ['text', 'tab', 'text', 'enter']);
	const rich = await Runtime.rich({ markdown: '**First**\n\n{{key:tab}}\n\nLast' }, {}, false, {});
	assert.equal(rich.tab_actions, 1);
	assert.deepEqual(rich.steps.map(step => step.kind), ['content', 'tab', 'content']);
	assert.doesNotMatch(rich.html, /key:tab/);
});

test('cursor metadata counts rendered UTF-16 and leaves answer tokens literal', async () => {
 const result = await Runtime.template({ text: '😀{{name}}{{cursor:here}}e\u0301\n👩‍💻', variables: {} }, { name: '{{cursor:here}}' }, false);
 assert.equal(result.text, '😀{{cursor:here}}e\u0301\n👩‍💻'); assert.equal(result.cursor.utf16, 17); assert.equal(result.cursor.backward_graphemes, 3);
 await assert.rejects(Runtime.template({ text: '{{cursor:here}}{{key:enter}}' }, {}, false), /cannot be combined/);
 await assert.rejects(Runtime.rich({ markdown: '{{cursor:here}}' }, {}, false, {}), /only in Text/);
});
