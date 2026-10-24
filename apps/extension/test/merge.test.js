import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCursor, mergeItems } from '../merge.js';

const snippet = (id, trigger, extra = {}) => ({ id, trigger, title: id, content: { type: 'plain_text', text: id }, state: 'active', ...extra });
const library = (_id, snippets, extra = {}) => ({ _id, name: _id, shared: false, state: 'active', snippets, ...extra });
const item = (id, trigger, libraryId, extra = {}) => ({ id, trigger, title: id, library: libraryId, library_id: libraryId, shared: false, content: { type: 'plain_text', text: id }, ...extra });

test('resolveCursor keeps a valid stored cursor and falls back to zero when state is missing', () => {
	assert.equal(resolveCursor({ items: [], cursor: 5 }), 5);
	assert.equal(resolveCursor({ items: [{}], cursor: 7 }), 7);
	assert.equal(resolveCursor({}), 0);
	assert.equal(resolveCursor({ cursor: 5 }), 0);
	assert.equal(resolveCursor({ items: [{}] }), 0);
	assert.equal(resolveCursor({ items: [{}], cursor: 0 }), 0);
	assert.equal(resolveCursor({ items: [{}], cursor: 'stale' }), 0);
});

test('incremental merge replaces changed libraries and retains unchanged ones', () => {
	const existing = [item('a1', 'a1', 'A'), item('b1', 'b1', 'B')];
	const snapshot = { accessible: ['A', 'B'], libraries: [library('A', [snippet('a1', 'a1-changed'), snippet('a2', 'a2')])] };
	const merged = mergeItems(existing, snapshot);
	assert.deepEqual(merged.map(row => row.id).sort(), ['a1', 'a2', 'b1']);
	assert.equal(merged.find(row => row.id === 'a1').trigger, 'a1-changed');
});

test('tombstones and purged libraries remove their snippets', () => {
	const existing = [item('a1', 'a1', 'A'), item('b1', 'b1', 'B')];
	const snapshot = { accessible: ['A'], libraries: [], purged: ['B'], tombstones: [{ library: 'A', id: 'a1', revision: 2 }] };
	const merged = mergeItems(existing, snapshot);
	assert.deepEqual(merged, []);
});

test('accessible removes libraries the user can no longer read', () => {
	const existing = [item('a1', 'a1', 'A'), item('b1', 'b1', 'B')];
	const snapshot = { accessible: ['A'], libraries: [] };
	assert.deepEqual(mergeItems(existing, snapshot).map(row => row.id), ['a1']);
});

test('a resync full snapshot drops stale libraries and keeps the current set', () => {
	const existing = [item('a1', 'a1', 'A'), item('stale', 'stale', 'C')];
	const snapshot = { resync: true, accessible: ['A', 'B'], libraries: [library('A', [snippet('a1', 'a1-new')]), library('B', [snippet('b1', 'b1')])] };
	assert.deepEqual(mergeItems(existing, snapshot).map(row => row.id).sort(), ['a1', 'b1']);
	assert.equal(mergeItems(existing, snapshot).find(row => row.id === 'a1').trigger, 'a1-new');
});

test('a trashed library removes its active snippets and a moved snippet is removed from its old library', () => {
	const existing = [item('a1', 'a1', 'A')];
	const trashed = mergeItems(existing, { accessible: ['A'], libraries: [library('A', [snippet('a1', 'a1')], { state: 'trashed' })] });
	assert.deepEqual(trashed, []);
	const departed = mergeItems(existing, { accessible: ['A', 'B'], libraries: [library('B', [snippet('a1', 'a1')])], departures: [{ library: 'A', id: 'a1' }] });
	assert.deepEqual(departed.map(row => row.id), ['a1']);
	assert.equal(departed[0].library_id, 'B');
});

test('personal abbreviations override shared triggers and collisions are recomputed across the merge', () => {
	const existing = [item('a1', 'tw', 'A'), item('a2', 'mine', 'A')];
	const shared = library('A', [snippet('a1', 'tw'), snippet('a2', 'mine')], { shared: true });
	const snapshot = { accessible: ['A'], libraries: [shared], personal_abbreviations: [{ snippet: 'a1', trigger: 'mine' }] };
	const merged = mergeItems(existing, snapshot);
	assert.equal(merged.find(row => row.id === 'a1').trigger, 'mine');
	assert.equal(merged.filter(row => row.abbreviation_collision).length, 2);
});

test('a missing accessible array leaves the merged items intact', () => {
	const existing = [];
	const snapshot = { libraries: [library('A', [snippet('a1', 'a1')])] };
	assert.deepEqual(mergeItems(existing, snapshot).map(row => row.id), ['a1']);
});