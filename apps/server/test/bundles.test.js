import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { Bundles } from '../services/bundles.js';
import { Yaml } from '../services/support.js';
import { Libraries } from '../services/libraries.js';
import { Assets } from '../services/assets.js';
import sharp from 'sharp';
import { Library, Snippet, Conflict, SnippetAsset } from '../model/index.js';

function assetQueries(t, assets) {
	const calls = { queries: 0, streamed: 0, closed: 0 };
	const query = rows => { calls.queries++; return { select() { return this; }, session() { return this; }, lean() { return this; }, then(resolve) { return Promise.resolve(rows).then(resolve); }, cursor(options) { assert.equal(options.batchSize, 16); return { async *[Symbol.asyncIterator]() { for (const row of rows) { calls.streamed++; yield row; } }, async close() { calls.closed++; } }; } }; };
	for (const model of [Library, Snippet, Conflict]) t.mock.method(model, 'find', () => query([]));
	t.mock.method(SnippetAsset, 'find', filter => { assert.equal(filter.account, 'account'); const rows = filter.id.$in.map(id => assets.get(id)).filter(Boolean); return query(filter.staged_by ? rows.map(asset => ({ id: asset.id })) : rows); });
	return calls;
}

test('a library exported with 65 distinct images imports with every image intact', async t => {
	const assets = new Map();
	for (let index = 0; index < 65; index++) {
		const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: index, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
		const asset = await Assets.normalize(data); assets.set(asset.id, asset);
	}
	const snippets = [...assets.keys()].map(id => ({ trigger: null, title: '', content: { version: 2, type: 'rich_text', markdown: `![](typerelay-asset:${id})`, variables: {}, assets: [id] } }));
	t.mock.method(Libraries, 'get', async () => ({ name: 'Images', snippets }));
	const calls = assetQueries(t, assets);
	// Exercise the real ZIP and image paths without requiring the separate YAML executable.
	t.mock.method(Yaml, 'export', async matches => ({ yaml: JSON.stringify(matches) }));
	t.mock.method(Yaml, 'run', async yaml => ({ matches: JSON.parse(yaml) }));
	const saved = new Map();
	t.mock.method(Assets, 'save', async (ctx, asset) => { saved.set(asset.id, asset); return asset; });
	const exported = await Bundles.export({ account: 'account', user: 'user' }, 'library');
	assert.equal(calls.queries, 5); assert.equal(calls.streamed, 65); assert.equal(calls.closed, 1);
	const imported = await Bundles.import({}, exported.bytes);
	assert.equal(imported.name, 'Images');
	assert.deepEqual(imported.snippets, snippets.map(snippet => Libraries.exportEntry(snippet, true)));
	assert.equal(saved.size, 65);
	for (const [id, asset] of assets) assert.deepEqual(saved.get(id).data, asset.data);
});

test('export refuses archives exceeding the import entry or expanded-byte limits', async t => {
	t.mock.method(Yaml, 'export', async () => ({ yaml: 'matches: []' }));
	t.mock.method(Libraries, 'get', async () => ({ name: 'Large', snippets: [{ content: { version: 2, type: 'rich_text', markdown: 'Image', assets: Array.from({ length: 999 }, (_, index) => String(index)) } }] }));
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

for (const legacy of [false, true]) test('bundle import preserves every image source from ' + (legacy ? 'legacy native' : 'canonical') + ' metadata', async t => {
 const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
 const id = Assets.id(data); const metadata = { source_urls: ['https://example.test/one.png', 'https://example.test/two.png'] };
 const files = { 'bundle.json': strToU8(JSON.stringify({ version: 1, name: 'Sources', assets: [id], ...(legacy ? {} : { asset_metadata: { [id]: metadata } }) })), 'snippets.yml': strToU8('matches: []'), ['assets/' + id]: data };
 if (legacy) files['metadata/' + id + '.json'] = strToU8(JSON.stringify(metadata));
 const sources = []; t.mock.method(Assets, 'save', async (ctx, asset, source) => { sources.push(...source); return asset; }); t.mock.method(Yaml, 'run', async () => ({ matches: [] }));
 await Bundles.import({}, Buffer.from(zipSync(files)));
 assert.deepEqual(sources, metadata.source_urls); assert.equal(Assets.save.mock.callCount(), 1);
});


for (const failure of ['inaccessible', 'missing', 'oversized']) test(`batched bundle export rejects ${failure} assets and closes its cursor`, async t => {
 const ids = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, '0'));
 const assets = new Map(ids.map(id => [id, { id, data: Buffer.alloc(failure === 'oversized' ? 2 * 1048576 : 1), mime_type: 'image/png', size: 1 }]));
 const calls = assetQueries(t, assets);
 t.mock.method(Libraries, 'get', async () => ({ name: 'Images', snippets: [{ content: { version: 2, type: 'rich_text', markdown: 'Image', assets: [...ids, ids[0]] } }] }));
 t.mock.method(Yaml, 'export', async () => ({ yaml: 'matches: []' }));
 t.mock.method(Assets, 'visible', async (ctx, requested) => { assert.deepEqual(requested, ids); return failure === 'inaccessible' ? ids.slice(1) : ids; });
 if (failure === 'missing') assets.delete(ids[0]);
 await assert.rejects(Bundles.export({ account: 'account', user: 'user' }, 'library'), error => error.status === (failure === 'oversized' ? 413 : 404));
 assert.equal(calls.queries, failure === 'inaccessible' ? 0 : 1);
 assert.equal(calls.closed, failure === 'inaccessible' ? 0 : 1);
 if (failure === 'oversized') assert.equal(calls.streamed, 12, 'stop at the expanded limit without loading the whole library');
});
