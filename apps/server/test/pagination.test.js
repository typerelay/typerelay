import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicApi } from '../api/public.js';

test('pagination visits mixed-case and punctuation IDs exactly once', () => {
	const ids = ['aaaaaaaaaaaaaaaa', 'AAAAAAAAAAAAAAAA', 'bbbbbbbbbbbbbbbb', '_aaaaaaaaaaaaaaa', '-aaaaaaaaaaaaaaa', '0000000000000001'];
	for (const limit of [1, 2, 3, 100]) {
		const seen = []; let cursor;
		do {
			const page = PublicApi.page(ids.map(id => ({ id })), { limit, cursor });
			seen.push(...page.items.map(row => row.id));
			assert.ok(seen.length <= ids.length, 'pagination must terminate without duplicates');
			cursor = page.next_cursor;
		} while (cursor);
		assert.deepEqual(seen, [...ids].sort());
	}
});
