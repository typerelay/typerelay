import { TestDatabase } from './database.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { mongoose, User, Account, Member, Library, Snippet, SnippetAsset, Conflict, Change, Operation } from '../model/index.js';
import { Support } from '../services/support.js';
import { Libraries } from '../services/libraries.js';
import { Assets } from '../services/assets.js';
import { Bundles } from '../services/bundles.js';
import { RichText } from '../services/rich_text.js';
import { StorageMigration } from '../services/storage_migration.js';

class Fixture {
	static async context(name = 'Limits') {
		const account = await Account.create({ name });
		const user = await User.create({ email: randomUUID() + '@example.test', name: 'owner' });
		await Member.create({ account: account._id, user: user._id, role: 'owner' });
		return Support.context(String(user._id), String(account._id));
	}
	// Direct inserts keep bulk fixtures fast; the code under test is the purge, not the creation.
	static async trashed(ctx, snippets, { expired = false, library = null } = {}) {
		const expires_at = new Date(Date.now() + (expired ? -1000 : 86400000));
		library ||= await Library.create({ account: ctx.account, creator: ctx.user, name: 'Bulk', shared: false, editable: false, members: [], groups: [], revision: 1, state: 'active' });
		const rows = Array.from({ length: snippets }, (_, index) => ({ account: ctx.account, library: library._id, id: randomUUID(), title: 'Title ' + index, content: { version: 1, type: 'plain_text', text: 'x' }, position: index, revision: 2, state: 'trashed', trashed_at: new Date(), trashed_by: ctx.user, expires_at }));
		await Snippet.insertMany(rows);
		return { library, targets: rows.map(row => ({ type: 'snippet', id: row.id, library: String(library._id), revision: 2 })) };
	}
	static async image(seed) { return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: (seed * 53) % 256, g: (seed * 97) % 256, b: (seed * 29) % 256 } } }).png().toBuffer(); }
	static rich(...sources) { return { version: 2, type: 'rich_text', markdown: sources.map(source => `![](${source})`).join('\n\n'), variables: {} }; }
}
before(async () => {
	await mongoose.connect(TestDatabase.uri(process.env.MONGO_URI, 'typerelay_sync_limits_test'));
	await TestDatabase.drop(mongoose.connection, 'typerelay_sync_limits_test');
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
after(async () => { await TestDatabase.drop(mongoose.connection, 'typerelay_sync_limits_test'); await mongoose.disconnect(); });

test('emptying Trash purges thousands of snippets and libraries with one change per library, well inside the transaction limit', async () => {
	const ctx = await Fixture.context('Empty');
	const targets = [];
	for (let index = 0; index < 4; index++) targets.push(...(await Fixture.trashed(ctx, 500)).targets);
	const started = Date.now();
	const result = await Libraries.mutate(ctx, randomUUID(), { targets }, (fresh, session) => Libraries.empty(fresh, targets, session));
	assert.equal(result.affected.length, 2000);
	assert.ok(Date.now() - started < 10000, 'Purging 2000 snippets took ' + (Date.now() - started) + ' ms');
	assert.equal(await Snippet.countDocuments({ account: ctx.account, state: 'purged' }), 2000);
	assert.equal(await Snippet.countDocuments({ account: ctx.account, content: { $exists: true } }), 0);
	assert.equal(await Change.countDocuments({ account: ctx.account, kind: 'purge' }), 4);
	const parents = [];
	for (let index = 0; index < 300; index++) { const { library } = await Fixture.trashed(ctx, 1); await Library.updateOne({ _id: library._id }, { $set: { state: 'trashed', trashed_at: new Date(), expires_at: new Date(Date.now() + 86400000) } }); parents.push({ type: 'library', id: String(library._id), library: String(library._id), revision: 1 }); }
	const libraryStarted = Date.now();
	await Libraries.mutate(ctx, randomUUID(), { parents }, (fresh, session) => Libraries.empty(fresh, parents, session));
	assert.ok(Date.now() - libraryStarted < 20000, 'Purging 300 libraries took ' + (Date.now() - libraryStarted) + ' ms');
	assert.equal(await Library.countDocuments({ account: ctx.account, state: 'purged' }), 300);
	assert.equal(await Change.countDocuments({ account: ctx.account, kind: 'purge' }), 304);
});

test('emptying Trash validates the whole selection before purging anything', async () => {
	const ctx = await Fixture.context('Empty validation');
	const { library, targets } = await Fixture.trashed(ctx, 3);
	await assert.rejects(Libraries.empty(ctx, [...targets.slice(0, 2), { ...targets[2], revision: 9 }], null), error => error.status === 409);
	await assert.rejects(Libraries.empty(ctx, [targets[0], targets[0]], null), error => error.status === 409);
	assert.equal(await Snippet.countDocuments({ library: library._id, state: 'trashed' }), 3);
	await assert.rejects(Libraries.empty(ctx, [{ ...targets[0], library: String(new mongoose.Types.ObjectId()) }], null), error => error.status === 404);
});

test('nightly cleanup purges in bounded transactions and a failed run resumes where it stopped', async t => {
	const ctx = await Fixture.context('Cleanup chunks');
	const { library } = await Fixture.trashed(ctx, 450, { expired: true });
	for (let index = 0; index < 45; index++) { const { library: parent } = await Fixture.trashed(ctx, 0); await Library.updateOne({ _id: parent._id }, { $set: { state: 'trashed', expires_at: new Date(Date.now() - 1000) } }); }
	const filters = []; const deleteMany = Conflict.deleteMany;
	t.mock.method(Conflict, 'deleteMany', function (filter, ...rest) { filters.push(filter); return deleteMany.call(this, filter, ...rest); });
	const purge = Libraries.purge; let calls = 0;
	const failing = t.mock.method(Libraries, 'purge', async (target, entry, session, directory) => { if (Array.isArray(entry) && ++calls === 2) throw new Error('synthetic chunk failure'); return purge(target, entry, session, directory); });
	const first = await Libraries.cleanup();
	assert.equal(first.failed, 1);
	assert.equal(first.libraries, 45);
	assert.equal(first.snippets, 200, 'The first snippet chunk stays committed');
	assert.equal(await Snippet.countDocuments({ library: library._id, state: 'purged' }), 200);
	failing.mock.restore();
	const second = await Libraries.cleanup();
	assert.deepEqual(second, { libraries: 0, snippets: 250, failed: 0 });
	assert.equal(await Snippet.countDocuments({ library: library._id, state: 'purged' }), 450);
	assert.equal(await Change.countDocuments({ account: ctx.account, kind: 'purge', library: library._id }), 3, 'One change per library per chunk');
	assert.ok(filters.length && filters.every(filter => String(filter.account) === ctx.account), 'Conflict deletion is scoped to the account');
});

test('indexes: conflicts, snippet assets and operations use the new indexes and the redundant ones migrate away', async () => {
	const names = async model => (await model.collection.indexes()).map(index => index.name);
	assert.ok((await names(Conflict)).includes('account_1_library_1'));
	assert.ok((await names(Snippet)).includes('account_1_content.assets_1'));
	assert.ok((await names(Operation)).includes('expires_1'));
	assert.ok(!(await names(Library)).includes('account_1'));
	assert.ok(!(await names(SnippetAsset)).includes('account_1_last_referenced_at_1'));
	await Library.collection.createIndex({ account: 1 }); await Conflict.collection.createIndex({ account: 1 }); await SnippetAsset.collection.createIndex({ account: 1, last_referenced_at: 1 });
	await StorageMigration.indexes(); await StorageMigration.indexes();
	assert.ok(!(await names(Library)).includes('account_1'));
	assert.ok(!(await names(Conflict)).includes('account_1'));
	assert.ok(!(await names(SnippetAsset)).includes('account_1_last_referenced_at_1'));
	assert.ok((await names(Library)).includes('account_1_state_1_purge_sequence_1'));
	assert.ok((await names(Conflict)).includes('account_1_library_1'));
});

test('the legacy retention migration stamps receipts and removes resolved conflicts once', async () => {
	const ctx = await Fixture.context('Retention');
	const id = new mongoose.Types.ObjectId();
	await Operation.collection.insertOne({ account: new mongoose.Types.ObjectId(ctx.account), user: new mongoose.Types.ObjectId(ctx.user), operation: randomUUID(), fingerprint: 'x', result: {} });
	await Conflict.create({ account: ctx.account, library: id, user: ctx.user, snippet: 'old-resolved', resolved: true });
	await Conflict.create({ account: ctx.account, library: id, user: ctx.user, snippet: 'open', resolved: false });
	await mongoose.connection.collection('migrations').deleteOne({ key: 'retention-v1' });
	await StorageMigration.retention();
	assert.equal(await Operation.countDocuments({ account: ctx.account, expires: { $type: 'date' } }), 1);
	assert.deepEqual((await Conflict.find({ account: ctx.account }).lean()).map(row => row.snippet), ['open']);
});

test('operation receipts expire; replaying an expired operation ID runs it as a new operation', async () => {
	const ctx = await Fixture.context('Receipts');
	const operation = randomUUID(); let runs = 0;
	const run = body => Libraries.mutate(ctx, operation, body, async () => ({ run: ++runs }));
	assert.deepEqual(await run({ a: 1 }), { run: 1 });
	const stored = await Operation.findOne({ account: ctx.account, operation }).lean();
	assert.ok(Math.abs(+stored.expires - (Date.now() + 30 * 86400000)) < 60000);
	assert.deepEqual(await run({ a: 1 }), { run: 1 });
	await assert.rejects(run({ a: 2 }), error => error.status === 409);
	await Operation.updateOne({ _id: stored._id }, { $set: { expires: new Date(Date.now() - 1000) } });
	assert.deepEqual(await run({ a: 2 }), { run: 2 });
	assert.equal(await Operation.countDocuments({ account: ctx.account, operation }), 1);
	assert.ok((await Operation.findOne({ account: ctx.account, operation }).lean()).expires > new Date());
});

test('one request budget caps remote fetches, embedded images and time, and reuses fetched URLs', async t => {
	const ctx = await Fixture.context('Budget');
	const asset = { id: 'a'.repeat(64) };
	const remote = t.mock.method(Assets, 'remote', async () => asset);
	const put = t.mock.method(Assets, 'put', async () => asset);
	const same = { snippets: [{ content: Fixture.rich('https://example.test/shared.png') }, { content: Fixture.rich('https://example.test/shared.png') }] };
	await Libraries.stage(ctx, same);
	assert.equal(remote.mock.callCount(), 1);
	remote.mock.resetCalls();
	const batch = index => ({ content: Fixture.rich(...Array.from({ length: 11 }, (_, position) => `https://example.test/${index}-${position}.png`)) });
	await assert.rejects(Libraries.stage(ctx, { snippets: [batch(0), batch(1), batch(2)] }), error => error.status === 422 && /at most 32/.test(error.message));
	assert.equal(remote.mock.callCount(), 32);
	const embedded = count => ({ snippets: [{ content: Fixture.rich(...Array.from({ length: count }, (_, index) => `data:image/png;base64,AAA${index.toString(36).padStart(3, 'A')}`)) }] });
	await Libraries.stage(ctx, embedded(64));
	assert.equal(put.mock.callCount(), 64);
	await assert.rejects(Libraries.stage(ctx, embedded(65)), error => error.status === 422 && /at most 64/.test(error.message));
	const budget = Assets.budget(); budget.deadline = Date.now() - 1;
	remote.mock.resetCalls();
	await assert.rejects(RichText.prepare(ctx, Fixture.rich('https://example.test/late.png'), null, budget), error => error.status === 422 && /took too long/.test(error.message));
	assert.equal(remote.mock.callCount(), 0);
});

test('per-account image quota rejects new images only and never touches existing ones', async t => {
	const ctx = await Fixture.context('Quota');
	const saved = { ...Assets.quota };
	try {
		Assets.quota.assets = 2;
		const first = await Assets.put(ctx, await Fixture.image(1));
		await Assets.put(ctx, await Fixture.image(2));
		await assert.rejects(Assets.put(ctx, await Fixture.image(3)), error => error.status === 413 && /storage is full/.test(error.message));
		assert.equal((await Assets.put(ctx, await Fixture.image(1))).id, first.id, 'Existing images stay saveable');
		assert.equal(await SnippetAsset.countDocuments({ account: ctx.account }), 2);
		Assets.quota.assets = 1;
		await assert.rejects(Assets.put(ctx, await Fixture.image(4)), /storage is full/);
		assert.equal(await SnippetAsset.countDocuments({ account: ctx.account }), 2, 'Over-quota accounts keep their images');
		Assets.quota.assets = 1000; Assets.quota.bytes = 1;
		await assert.rejects(Assets.put(ctx, await Fixture.image(5)), /storage is full/);
	} finally { Object.assign(Assets.quota, saved); }
});

test('image source URLs are capped at 10 http(s) URLs of 2048 characters, including bundle metadata', async () => {
	const ctx = await Fixture.context('Sources');
	const bytes = await Fixture.image(10);
	const list = count => Array.from({ length: count }, (_, index) => 'https://example.test/' + index);
	await assert.rejects(Assets.accept(ctx, bytes, '', list(11)), error => error.status === 422);
	await assert.rejects(Assets.accept(ctx, bytes, '', ['javascript:alert(1)']), error => error.status === 422);
	await assert.rejects(Assets.accept(ctx, bytes, '', ['https://example.test/' + 'x'.repeat(2048)]), error => error.status === 422);
	const image = await Assets.accept(ctx, bytes, '', list(8));
	await Assets.mergeSources(ctx, image.id, list(13).slice(3));
	assert.deepEqual((await SnippetAsset.findOne({ account: ctx.account, id: image.id }).lean()).source_urls, list(10));
	await Assets.mergeSources(ctx, image.id, list(3));
	assert.equal((await SnippetAsset.findOne({ account: ctx.account, id: image.id }).lean()).source_urls.length, 10);
	const bundle = sources => Buffer.from(zipSync({ 'snippets.yml': strToU8('matches: []\n'), [`assets/${image.id}`]: new Uint8Array(bytes), 'bundle.json': strToU8(JSON.stringify({ version: 1, name: 'Sources', assets: [image.id], asset_metadata: { [image.id]: { source_urls: sources } } })) }));
	await assert.rejects(Bundles.import(ctx, bundle(list(11))), error => error.status === 422 && /Image sources/.test(error.message));
	await assert.rejects(Bundles.import(ctx, bundle(['ftp://example.test/a.png'])), error => error.status === 422);
});

test('download skips tombstone work for quiet incremental syncs but still reports purges', async t => {
	const ctx = await Fixture.context('Quiet sync');
	const { library, targets } = await Fixture.trashed(ctx, 1);
	await Support.change(ctx.account, library._id, 'library', null);
	const before = await Libraries.download(ctx, 0);
	await Libraries.mutate(ctx, randomUUID(), { targets }, (fresh, session) => Libraries.empty(fresh, targets, session));
	const after = await Libraries.download(ctx, before.cursor);
	assert.deepEqual(after.tombstones.map(row => row.id), [targets[0].id]);
	const find = Snippet.find; const filters = [];
	t.mock.method(Snippet, 'find', function (filter, ...rest) { filters.push(filter); return find.call(this, filter, ...rest); });
	const quiet = await Libraries.download(ctx, after.cursor);
	assert.deepEqual([quiet.tombstones, quiet.purged, quiet.departures], [[], [], []]);
	assert.ok(!filters.some(filter => filter.state === 'purged'), 'No tombstone query without changes');
	assert.ok(filters.some(filter => String(filter.account) === ctx.account && filter.state === 'trashed'), 'Trash lists are filtered by account');
});
