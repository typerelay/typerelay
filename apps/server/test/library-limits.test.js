import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Libraries } from '../services/libraries.js';
import { Yaml } from '../services/support.js';

// Use the real native helper: its serialized Match format defines the engine limits.
test('library limits count canonical content, not duplicated display text or stored metadata', async t => {
	const snippets = Array.from({ length: 16 }, (_, i) => Libraries.entry({ id: `s${i}`, trigger: `s${i}`, title: '', state: 'active', content: { version: 1, type: 'plain_text', text: 'x'.repeat(64000) }, personal: { revision: 1 }, rich_html: 'irrelevant display data' }));
	t.mock.method(Libraries, 'list', async () => [{ snippets }]);
	assert.ok(Buffer.byteLength(JSON.stringify(snippets)) > 1048576);
	await Libraries.validateVisible({}, null);
	await Libraries.validateVisible({}, null, ['s0']);
	const canonical = await Libraries.validate(snippets);
	assert.ok(Buffer.byteLength(JSON.stringify(canonical)) < 1048576);
	snippets.push(Libraries.entry({ trigger: 'last', content: { version: 1, type: 'plain_text', text: 'x' } }));
	const remaining = 1048576 - Buffer.byteLength(JSON.stringify(await Libraries.validate(snippets)));
	snippets.at(-1).content.text = 'x'.repeat(remaining + 1);
	await Libraries.validateVisible({}, null);
	snippets.at(-1).content.text += 'x';
	await assert.rejects(Libraries.validateVisible({}, null), /Library exceeds the engine limit/);
});

test('canonical sizing retains markdown, code language and template variable defaults', async () => {
	const entries = [{ trigger: 'rich', content: { version: 2, type: 'rich_text', markdown: '**bold**', variables: {} } }, { trigger: 'code', content: { version: 1, type: 'code', text: 'const café = "☕";', language: 'javascript' } }, { trigger: 'template', content: { version: 1, type: 'template', text: '{{name}}', variables: { name: { label: 'Name' } } } }];
	const matches = await Libraries.validate(entries);
	assert.equal(matches[0].type, 'rich_text');
	assert.equal(matches[0].replace, '**bold**');
	assert.equal(matches[1].language, 'javascript');
	assert.equal(matches[2].variables.name.timezone, 'local');
	assert.deepEqual(matches, (await Yaml.run((await Yaml.export(matches)).yaml)).matches);
});

test('total size counts each library array and still enforces the 8 MiB limit', async t => {
	const libraries = Array.from({ length: 9 }, (_, library) => ({ snippets: Array.from({ length: 16 }, (_, i) => ({ trigger: `s${library}-${i}`, replace: 'x'.repeat(64000) })) }));
	t.mock.method(Libraries, 'list', async () => libraries.slice(0, 8));
	await Libraries.validateVisible({}, null);
	t.mock.method(Libraries, 'list', async () => libraries);
	await assert.rejects(Libraries.validateVisible({}, null), /Active snippets exceed the engine limit/);
});
