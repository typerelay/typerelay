import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoose, Account, Library, Snippet, SnippetAsset, Conflict, Change, Operation, UsageEvent, Device, Member } from '../model/index.js';
import { Libraries } from '../services/libraries.js';
import { Statistics } from '../services/statistics.js';
import { Assets } from '../services/assets.js';
import { RichText } from '../services/rich_text.js';
import { Support, Yaml } from '../services/support.js';
import { AccountAccess } from '../services/account_access.js';
import { AdminAccounts } from '../services/admin_accounts.js';
import { WhiteLabel } from '../services/white_label.js';

class Fixture {
	static ctx = { account: '0123456789abcdef01234567', user: '1123456789abcdef01234567', role: 'owner', groups: [] };
	static library = { _id: '2123456789abcdef01234567', account: Fixture.ctx.account, creator: Fixture.ctx.user, state: 'active', shared: false, members: [], groups: [], revision: 1 };
	static image() { return { content: { version: 2, type: 'rich_text', markdown: '![](https://example.test/image.png)' } }; }
	static query(rows) { return { session() { return this; }, read() { return this; }, select() { return this; }, sort() { return this; }, lean() { return this; }, then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) }; }
	static transaction(t) {
		t.mock.method(mongoose.connection, 'transaction', async action => action({ inTransaction: () => true }));
		t.mock.method(Account, 'updateOne', async () => ({ matchedCount: 1 }));
		t.mock.method(Support, 'context', async () => Fixture.ctx);
		t.mock.method(Operation, 'findOne', () => Fixture.query(null));
		t.mock.method(Operation, 'create', async () => []);
	}
}
test('pending domain cleanup cannot discover a domain verified during provider lookup', async t => {
	let verified = false;
	const account = { _id: Fixture.ctx.account, white_label: { hostname: 'pending.example.test' } };
	t.mock.method(WhiteLabel, 'mutation', async (id, action, team, purge) => { assert.equal(id, account._id); assert.equal(team, false); assert.equal(purge, true); return action(account); });
	t.mock.method(WhiteLabel, 'saveState', async (current, state) => ({ ...current, white_label: { ...current.white_label, ...state } }));
	const options = { listHostnames: async hostname => { verified = true; return [{ id: 'new-owner', hostname, custom_metadata: { catalog: 'typerelay' } }]; }, deleteHostname: async () => assert.fail('new owner domain deleted') };
	await AdminAccounts.removeDomain({ _id: Fixture.ctx.account, white_label: { hostname: 'pending.example.test' } }, options);
	assert.equal(verified, false, 'pending accounts must never discover provider resources');
});

test('device token and member lookup indexes match authentication queries', () => {
	for (const key of ['access', 'refresh']) assert.ok(Device.schema.indexes().some(([fields, options]) => fields[key] === 1 && options.sparse));
	assert.ok(Member.schema.indexes().some(([fields]) => fields.user === 1 && Object.keys(fields).length === 1));
});
for (const shape of ['create', 'upload', 'move', 'resolve', 'wrapped']) test(`${shape}: failed image fetch is not retried inside a transaction`, async t => {
	const value = Fixture.image(); const input = shape === 'create' ? { snippets: [value] } : shape === 'upload' ? { changes: [{ value }] } : shape === 'move' ? { items: [{ value }] } : { value };
	const body = shape === 'wrapped' ? { operation: 'update_snippet', params: {}, body: input } : input;
	t.mock.method(Operation, 'findOne', () => Fixture.query(null));
	t.mock.method(Assets, 'remote', async (ctx, url, session) => { assert.equal(session, null); throw new Error('fetch failed'); });
	t.mock.method(mongoose.connection, 'transaction', async () => assert.fail('transaction started'));
	await assert.rejects(Libraries.mutate(Fixture.ctx, randomUUID(), body, () => assert.fail('action ran')), /fetch failed/);
	assert.equal(Assets.remote.mock.callCount(), 1); assert.equal(mongoose.connection.transaction.mock.callCount(), 0);
});
test('prepared images preserve operation fingerprints and idempotent retries', async t => {
	Fixture.transaction(t); const value = Fixture.image(); const body = { snippets: [value] }; const serialized = JSON.stringify(body); let stored; let actions = 0;
	t.mock.method(Assets, 'remote', async (ctx, url, session) => { assert.equal(session, null); return { id: 'a'.repeat(64) }; });
	t.mock.method(Operation, 'findOne', () => Fixture.query(stored));
	t.mock.method(Operation, 'create', async rows => { [stored] = rows; });
	const operation = randomUUID(); const action = async (ctx, session) => { actions++; assert.match((await Libraries.prepared(ctx, value, session)).content.markdown, /typerelay-asset:/); return { ok: true }; };
	assert.deepEqual(await Libraries.mutate(Fixture.ctx, operation, body, action), { ok: true });
	assert.deepEqual(await Libraries.mutate(Fixture.ctx, operation, body, action), { ok: true });
	assert.equal(JSON.stringify(body), serialized); assert.equal(actions, 1); assert.equal(Assets.remote.mock.callCount(), 1);
});
test('YAML creation prepares parsed images before the action', async t => {
	Fixture.transaction(t); const entry = { type: 'rich_text', replace: '![](https://example.test/image.png)' }; const body = { yaml: 'source' };
	t.mock.method(Yaml, 'run', async () => ({ matches: [entry] })); t.mock.method(Assets, 'remote', async () => ({ id: 'a'.repeat(64) }));
	await Libraries.mutate(Fixture.ctx, randomUUID(), body, async (ctx, session) => { assert.match((await Libraries.prepared(ctx, body[Libraries.preparedYaml][0], session)).content.markdown, /typerelay-asset:/); return {}; });
	assert.equal(body.yaml, 'source'); assert.equal(Assets.remote.mock.callCount(), 1);
});
test('bundle import stages parsed snippets while retaining the archive fingerprint', async t => {
	Fixture.transaction(t); const value = Fixture.image(); const bundle = { snippets: [value] }; const body = { bundle: 'archive-hash' };
	t.mock.method(Assets, 'remote', async (ctx, url, session) => { assert.equal(session, null); return { id: 'a'.repeat(64) }; });
	t.mock.method(Operation, 'create', async ([operation]) => { assert.equal(operation.fingerprint, Support.hash(JSON.stringify(body))); });
	await Libraries.mutate(Fixture.ctx, randomUUID(), body, async (ctx, session) => { assert.match((await Libraries.prepared(ctx, value, session)).content.markdown, /typerelay-asset:/); return {}; }, { input: bundle });
	assert.equal(Assets.remote.mock.callCount(), 1);
});
for (const wrapped of [false, true]) test(`import stages selected images for ${wrapped ? 'API' : 'web'} callers`, async t => {
	Fixture.transaction(t); const input = { selected: [{ key: 'one' }] }; const body = wrapped ? { operation: 'commit_import', params: { format: 'yaml' }, body: input } : input;
	t.mock.method(Libraries, 'previewImport', async () => ({ entries: [{ key: 'one', ...Fixture.image() }, { key: 'two', ...Fixture.image() }] }));
	t.mock.method(Assets, 'remote', async () => ({ id: 'a'.repeat(64) }));
	await Libraries.mutate(Fixture.ctx, randomUUID(), body, async () => { assert.match(input[Libraries.importPreview].entries[0].content.markdown, /typerelay-asset:/); return {}; }, wrapped ? {} : { format: 'yaml' });
	assert.equal(Assets.remote.mock.callCount(), 1);
});
test('local conflict images prepare before the transaction', async t => {
	Fixture.transaction(t); const input = { choice: 'local' };
	t.mock.method(Conflict, 'findOne', () => Fixture.query({ library: Fixture.library._id, local: Fixture.image() })); t.mock.method(Libraries, 'get', async () => Fixture.library);
	t.mock.method(Assets, 'remote', async (ctx, url, session) => { assert.equal(session, null); return { id: 'a'.repeat(64) }; });
	await Libraries.mutate(Fixture.ctx, randomUUID(), { operation: 'resolve_conflict', params: { id: Fixture.library._id }, body: input }, async () => { assert.match(input[Libraries.conflictValue].content.markdown, /typerelay-asset:/); return {}; });
	assert.equal(Assets.remote.mock.callCount(), 1);
});
test('invalid import selection is rejected before staging any images', async t => {
	Fixture.transaction(t);
	t.mock.method(Libraries, 'previewImport', async () => ({ entries: [{ key: 'one', ...Fixture.image() }, { key: 'two', trigger: 'valid' }] }));
	t.mock.method(Assets, 'remote', async () => assert.fail('image staged'));
	const body = { selected: [{ key: 'one' }, { key: 'two', trigger: '#' }] };
	await assert.rejects(Libraries.mutate(Fixture.ctx, randomUUID(), body, () => assert.fail('action ran'), { format: 'yaml' }), /Invalid abbreviation/);
});
test('missed preflight cannot fetch images while holding a transaction', async t => {
	t.mock.method(Assets, 'remote', async () => assert.fail('remote fetched')); t.mock.method(Assets, 'put', async () => assert.fail('embedded image prepared'));
	for (const markdown of ['![](https://example.test/a)', '![](data:image/png;base64,AAAA)']) await assert.rejects(RichText.prepare(Fixture.ctx, { version: 2, type: 'rich_text', markdown }, {}), /before starting/);
});
test('usage batches discard invalid IDs/dates, deduplicate, and insert once per transaction attempt', async t => {
	const valid = { event_id: randomUUID(), library: Fixture.library._id, snippet: 'snippet-one', occurred_at: new Date().toISOString(), action: 'copy', client: 'web', characters: 5 };
	const invalid = [{ ...valid, event_id: randomUUID(), library: 'bad' }, ...[null, false, {}, 'invalid', '9999-01-01'].map(occurred_at => ({ ...valid, event_id: randomUUID(), occurred_at }))];
	const invalidIds = [null, false, {}, ['abcdefghijklmnop'], 1234567890123456].map(event_id => ({ ...valid, event_id }));
	t.mock.method(Library, 'find', () => Fixture.query([Fixture.library])); t.mock.method(Snippet, 'find', () => Fixture.query([{ id: valid.snippet, library: valid.library }])); t.mock.method(UsageEvent, 'find', () => Fixture.query([]));
	t.mock.method(UsageEvent, 'insertMany', async rows => { assert.equal(rows.length, 1); assert.equal(rows[0].account, Fixture.ctx.account); });
	t.mock.method(AccountAccess, 'write', async (id, action) => { await action({}); return action({}); });
	assert.deepEqual(await Statistics.ingest(Fixture.ctx, { events: [...invalid, ...invalidIds, valid, valid] }), { accepted: [valid.event_id, valid.event_id], discarded: invalid.map(event => event.event_id) });
	assert.equal(UsageEvent.insertMany.mock.callCount(), 2); assert.equal(Library.find.mock.callCount(), 2); assert.equal(Snippet.find.mock.callCount(), 2);
});
test('resolved conflicts no longer retain image binaries', async t => {
	t.mock.method(Snippet, 'find', () => Fixture.query([]));
	t.mock.method(Conflict, 'find', filter => { assert.equal(filter.resolved, false); return Fixture.query([{ local: { content: { type: 'rich_text', assets: ['live'] } } }]); });
	t.mock.method(SnippetAsset, 'deleteMany', async filter => { assert.deepEqual(filter.$and[1], { id: { $nin: ['live'] } }); });
	await Libraries.cleanupAssets(Fixture.ctx.account, {}, { updatedAt: { $lte: new Date() } });
});
test('nightly cleanup selects accounts with expired trash or images', async t => {
	for (const model of [Library, Snippet]) t.mock.method(model, 'distinct', async (field, filter) => { assert.equal(filter.state, 'trashed'); assert.ok(filter.expires_at.$lte instanceof Date); return [Fixture.ctx.account]; });
	t.mock.method(SnippetAsset, 'distinct', async (field, filter) => { assert.ok(filter.updatedAt.$lte instanceof Date); return []; });
	t.mock.method(Account, 'find', filter => { assert.deepEqual(filter._id.$in, [Fixture.ctx.account]); return Fixture.query([]); });
	assert.deepEqual(await Libraries.cleanup(), { libraries: 0, snippets: 0, failed: 0 });
});
test('history pruning and cursor expiry share the change transaction', async t => {
	const session = {}; const sequence = Support.changeHistory + 10;
	t.mock.method(Account, 'findOneAndUpdate', () => Fixture.query({ sequence, sync_history_version: 1 }));
	t.mock.method(Account, 'updateOne', async (filter, update, options) => { assert.equal(update.$max.sync_floor, 10); assert.equal(options.session, session); });
	t.mock.method(Change, 'create', async () => []); t.mock.method(Change, 'deleteMany', async (filter, options) => { assert.deepEqual(filter.sequence, { $lte: 10 }); assert.equal(options.session, session); });
	assert.equal(await Support.change(Fixture.ctx.account, Fixture.library._id, 'snippets', session), sequence);
});
for (const cursor of [0, 1, 50, 100, 101]) test(`sync cursor ${cursor} uses a full snapshot only when needed`, async t => {
	Fixture.transaction(t); t.mock.method(Account, 'findById', () => Fixture.query({ sequence: 100, sync_history_version: 1, sync_floor: 50 })); t.mock.method(Change, 'find', () => Fixture.query([]));
	t.mock.method(Library, 'find', filter => Fixture.query(filter.state === 'purged' ? [] : [Fixture.library]));
	t.mock.method(Snippet, 'find', filter => { if (filter.state === 'purged') assert.deepEqual(filter.purge_sequence, cursor > 0 && cursor >= 50 && cursor <= 100 ? { $gt: cursor, $lte: 100 } : undefined); return Fixture.query([]); });
	t.mock.method(Conflict, 'find', () => Fixture.query([])); t.mock.method(Libraries, 'trash', async () => []);
	const result = await Libraries.download(Fixture.ctx, cursor);
	assert.equal(result.resync, cursor === 1 || cursor === 101); assert.equal(result.libraries.length, cursor === 0 || cursor === 1 || cursor === 101 ? 1 : 0);
});
test('helper failure does not spawn a process per entry', async t => {
	t.mock.method(Yaml, 'each', async () => { throw new Error('helper unavailable'); }); t.mock.method(Yaml, 'validate', async () => assert.fail('per-entry fallback ran'));
	await assert.rejects(Libraries.failures([{ replace: 'one' }, { replace: 'two' }]), /helper unavailable/); assert.equal(Yaml.each.mock.callCount(), 1);
});
