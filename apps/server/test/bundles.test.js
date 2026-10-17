import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { Bundles } from '../services/bundles.js';
import { Yaml } from '../services/support.js';

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
