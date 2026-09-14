import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TemplateRuntime } from '../public/template-runtime.js';

test('browser WebAssembly uses literal answers, ordered actions, shared dates and validation', async () => {
	const fetch = globalThis.fetch;
	globalThis.fetch = async url => { assert.equal(url, '/assets/generated/template.wasm'); return new Response(await readFile('/usr/local/share/typerelay/template.wasm'), { headers: { 'Content-Type': 'application/wasm' } }); };
	try {
		const template = { text: 'Hi {{name}} {{name}} {{date}} {{timestamp}}{{key:enter}}Done', variables: { date: { timezone: 'utc' }, timestamp: { timezone: 'utc' } } };
		const rendered = await TemplateRuntime.render(template, { name: '{{key:enter}}' }, false, new Date(0));
		assert.equal(rendered.text, 'Hi {{key:enter}} {{key:enter}} 1970-01-01 1970-01-01T00:00:00+00:00Done');
		assert.deepEqual(rendered.fields, ['name']); assert.equal(rendered.enter_actions, 1); assert.equal(rendered.steps[1].kind, 'enter');
		await assert.rejects(TemplateRuntime.render(template), /required/);
		await assert.rejects(TemplateRuntime.render({ text: '{{shell:ls}}', variables: {} }), /variable name/);
		const literal = await TemplateRuntime.render({ text: '\\{{name}}', variables: {} }); assert.equal(literal.text, '{{name}}');
		const multiline = await TemplateRuntime.render({ text: '{{body}}', variables: { body: { multiline: true } } }, { body: 'One\r\n\tTwo\n' }); assert.equal(multiline.text, 'One\n\tTwo\n');
	} finally { globalThis.fetch = fetch; }
});
