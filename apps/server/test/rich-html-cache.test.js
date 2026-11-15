import test from 'node:test';
import assert from 'node:assert/strict';
import { Libraries } from '../services/libraries.js';
import { ApiRateLimit } from '../rate_limit.js';

const snippet = { id: 'a', account: 'acct', state: 'active', content: { version: 2, type: 'rich_text', markdown: '**bold** {{name}}', variables: {}, assets: [] } };

test('rich HTML is cached by input hash, identical on hit, and rendered when the cache fails', async t => {
	const store = new Map();
	const calls = { get: 0, set: 0 };
	t.after(() => { ApiRateLimit.cache = undefined; });
	ApiRateLimit.cache = ({ getMany: async keys => { calls.get++; return keys.map(key => store.get(key) ?? null); }, setMany: async entries => { calls.set++; for (const entry of entries) store.set(entry.key, entry.value); } });
	const direct = Libraries.entry(snippet).rich_html;
	const [first] = await Libraries.richHtml([snippet]);
	assert.equal(first, direct);
	assert.equal(store.size, 1);
	store.set([...store.keys()][0], '<p>cached</p>');
	assert.deepEqual(await Libraries.richHtml([snippet, { ...snippet, content: { ...snippet.content, type: 'plain_text' } }]), ['<p>cached</p>', undefined]);
	assert.equal(calls.set, 1);
	ApiRateLimit.cache = { getMany: async () => { throw new Error('down'); }, setMany: async () => { throw new Error('down'); } };
	assert.deepEqual(await Libraries.richHtml([snippet]), [direct]);
});
