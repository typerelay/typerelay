import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { Bundles } from '../services/bundles.js';
import { Yaml } from '../services/support.js';
import { Libraries } from '../services/libraries.js';
import { Assets } from '../services/assets.js';
import sharp from 'sharp';

test('a library exported with 65 distinct images imports with every image intact', async t => {
	const assets = new Map();
	for (let index = 0; index < 65; index++) {
		const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: index, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
		const asset = await Assets.normalize(data); assets.set(asset.id, asset);
	}
	const snippets = [...assets.keys()].map(id => ({ trigger: null, title: '', content: { type: 'rich_text', markdown: `![](typerelay-asset:${id})`, assets: [id] } }));
	t.mock.method(Libraries, 'get', async () => ({ name: 'Images', snippets }));
	t.mock.method(Assets, 'get', async (ctx, id) => assets.get(id));
	// Exercise the real ZIP and image paths without requiring the separate YAML executable.
	t.mock.method(Yaml, 'export', async matches => ({ yaml: JSON.stringify(matches) }));
	t.mock.method(Yaml, 'run', async yaml => ({ matches: JSON.parse(yaml) }));
	const saved = new Map();
	t.mock.method(Assets, 'save', async (ctx, asset) => { saved.set(asset.id, asset); return asset; });
	const exported = await Bundles.export({}, 'library');
	const imported = await Bundles.import({}, exported.bytes);
	assert.equal(imported.name, 'Images');
	assert.deepEqual(imported.snippets, snippets.map(Bundles.entry));
	assert.equal(saved.size, 65);
	for (const [id, asset] of assets) assert.deepEqual(saved.get(id).data, asset.data);
});

test('export refuses archives exceeding the import entry or expanded-byte limits', async t => {
	t.mock.method(Yaml, 'export', async () => ({ yaml: 'matches: []' }));
	t.mock.method(Libraries, 'get', async () => ({ name: 'Large', snippets: [{ content: { type: 'rich_text', markdown: '', assets: Array.from({ length: 999 }, (_, index) => String(index)) } }] }));
	await assert.rejects(Bundles.export({}, 'library'), error => error.status === 413);
	t.mock.method(Libraries, 'get', async () => ({ name: 'Large', snippets: [] }));
	t.mock.method(Yaml, 'export', async () => ({ yaml: ' '.repeat(24 * 1048576) }));
	await assert.rejects(Bundles.export({}, 'library'), error => error.status === 413);
});

test('bundle preflight rejects a small ZIP with excessive expanded data and excessive entries', async () => {
	const bomb = Buffer.from(zipSync({ large: new Uint8Array(25 * 1048576) }));
	assert.ok(bomb.length < 30000);
	await assert.rejects(Bundles.import({}, bomb), error => error.status === 413);
	const entries = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [String(index), new Uint8Array()]));
	await assert.rejects(Bundles.import({}, Buffer.from(zipSync(entries))), error => error.status === 413);
	await assert.rejects(Bundles.import({}, Buffer.from('not a zip')), error => error.status === 422);
});

test('ordinary bundles still import after preflight', async t => {
	t.mock.method(Yaml, 'run', async text => { assert.equal(text, 'matches: []'); return { matches: [] }; });
	const bytes = Buffer.from(zipSync({ 'bundle.json': strToU8(JSON.stringify({ version: 1, name: 'Test', assets: [] })), 'snippets.yml': strToU8('matches: []') }));
	assert.deepEqual(await Bundles.import({}, bytes), { name: 'Test', snippets: [] });
});

test('forged expanded sizes cannot truncate an oversized deflate stream into an accepted bundle', async () => {
	const bytes = Buffer.from(zipSync({ 'bundle.json': strToU8(JSON.stringify({ version: 1, name: 'Test', assets: [] })), 'snippets.yml': strToU8('matches: []' + ' '.repeat(25 * 1048576)) }));
	for (let offset = 0; offset < bytes.length - 46; offset++) if (bytes.readUInt32LE(offset) === 0x02014b50) {
		const length = bytes.readUInt16LE(offset + 28);
		if (bytes.subarray(offset + 46, offset + 46 + length).toString() === 'snippets.yml') bytes.writeUInt32LE(11, offset + 24);
	}
	await assert.rejects(Bundles.import({}, bytes), error => error.status === 422);
});
