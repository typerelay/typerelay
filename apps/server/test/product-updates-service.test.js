import assert from 'node:assert/strict';
import test from 'node:test';
import { mongoose } from '../model/index.js';
import { ProductUpdates } from '../services/product_updates.js';
import { Scheduler } from '../services/scheduler.js';
const { backfillProductUpdatesSeenAt, getModalProductUpdates, getProductUpdateStatus, listProductUpdates, markProductUpdatesSeen, syncProductUpdates } = ProductUpdates;

class Fixture {
static queryResult(result, capture = {}) {
	const query = { sort(value) { capture.sort = value; return query; }, limit(value) { capture.limit = value; return query; }, select(value) { capture.select = value; return query; }, lean() { return Promise.resolve(result); } };
	return query;
}
}

test('invalid Ghost records are skipped; excerpts and links remain safe', () => {
	assert.equal(ProductUpdates.mapGhostPost({ id: 'bad', title: 'Bad', slug: 'bad', published_at: 'invalid' }), null);
	const mapped = ProductUpdates.mapGhostPost({ id: 'one', title: '<script>title</script>', slug: '../escaped', published_at: '2026-09-16', custom_excerpt: '<script>alert(1)</script><style>hidden</style><b>Safe &amp; plain</b>', feature_image: 'data:image/png,test', tags: [{ slug: 'hash-modal' }] });
	assert.equal(mapped.excerpt, 'Safe & plain');
	assert.equal(mapped.feature_image, '');
	assert.equal(mapped.link, 'https://typerelay.com/blog/..%2Fescaped/');
	assert.equal(mapped.show_modal, true);
});

test('later-page failures and malformed payloads never deactivate cached posts', async () => {
	for (const failure of [{ ok: false, status: 502 }, { ok: true, json: async () => ({ posts: null }) }]) {
		let page = 0;
		await assert.rejects(ProductUpdates.syncProductUpdates({ config: { contentApiKey: 'test' }, fetchImpl: async () => ++page === 1 ? { ok: true, json: async () => ({ posts: [], meta: { pagination: { pages: 2 } } }) } : failure, productUpdateModel: { bulkWrite: () => assert.fail('Unexpected write'), updateMany: () => assert.fail('Unexpected deactivation') } }));
	}
	let query;
	await ProductUpdates.syncProductUpdates({ config: { contentApiKey: 'test' }, fetchImpl: async () => ({ ok: true, json: async () => ({ posts: [] }) }), productUpdateModel: { updateMany: async value => { query = value; return {}; } } });
	assert.deepEqual(query, { active: true });
});

test('cursor uses timestamp and ID tie-breaker; rejects invalid cursor and seen IDs', async () => {
	const update = { _id: new mongoose.Types.ObjectId(), published_at: new Date('2026-09-16') };
	let query;
	await ProductUpdates.listProductUpdates({ cursor: ProductUpdates.encodeCursor(update), productUpdateModel: { find: value => { query = value; return Fixture.queryResult([]); } } });
	assert.deepEqual(query.$or, [{ published_at: { $lt: update.published_at } }, { published_at: update.published_at, _id: { $lt: update._id } }]);
	await assert.rejects(ProductUpdates.listProductUpdates({ cursor: 'garbage' }), { status: 400 });
	await assert.rejects(ProductUpdates.markProductUpdatesSeen('user', 'garbage'), { status: 400 });
	await assert.rejects(ProductUpdates.markProductUpdatesSeen('user', String(update._id), { productUpdateModel: { findOne: () => Fixture.queryResult(null) } }), { status: 404 });
});

test('scheduler immediately syncs, prevents overlap, retries failures, and honors disabled mode', async () => {
	const jobs = [];
	class Cron { constructor(pattern, options, callback) { jobs.push({ pattern, options, callback }); } }
	let calls = 0; let release;
	const gate = new Promise(resolve => { release = resolve; });
	const errors = [];
	Scheduler.start({ CronClass: Cron, productUpdatesEnabled: true, syncProductUpdates: async () => { calls++; if (calls === 1) { await gate; throw new Error('Offline'); } return { fetched: 2 }; }, logger: { log() {}, error: value => errors.push(value) } });
	assert.equal(calls, 1);
	const job = jobs.at(-1);
	assert.equal(job.pattern, '*/15 * * * *');
	assert.equal(job.options.protect, true);
	await job.callback();
	assert.equal(calls, 1);
	release(); await new Promise(resolve => setImmediate(resolve));
	await job.callback();
	assert.equal(calls, 2);
	assert.equal(errors.length, 1);
	jobs.length = 0;
	Scheduler.start({ CronClass: Cron, productUpdatesEnabled: false, syncProductUpdates: () => assert.fail('Disabled sync') });
	assert.equal(jobs.length, 6);
});

test('syncs every Ghost product post and maps #modal safely', async () => {
	let requestedUrl;
	let bulkOperations;
	let staleQuery;
	const productUpdateModel = {
		bulkWrite: async (operations) => { bulkOperations = operations; return { upsertedCount: 2 }; },
		updateMany: async (query) => { staleQuery = query; return { modifiedCount: 1 }; },
	};
	const fetchImpl = async (url) => {
		requestedUrl = url;
		return { ok: true, json: async () => ({ posts: [
			{ id: 'ghost-1', title: 'Modal update', slug: 'modal-update', excerpt: '<strong>Safe copy</strong>', feature_image: 'https://cdn.example.com/image.jpg', published_at: '2026-08-30T12:00:00.000Z', tags: [{ name: '#modal', slug: 'hash-modal' }] },
			{ id: 'ghost-2', title: 'Regular update', slug: 'regular-update', custom_excerpt: 'Regular copy', feature_image: 'javascript:alert(1)', published_at: '2026-08-29T12:00:00.000Z', tags: [{ name: 'product', slug: 'product' }] },
		], meta: { pagination: { pages: 1 } } }) };
	};
	const result = await syncProductUpdates({ fetchImpl, productUpdateModel, config: { contentApiKey: 'content-key', ghostBaseUrl: 'https://typerelay.com' } });
	assert.equal(requestedUrl.searchParams.get('filter'), 'tag:product');
	assert.equal(requestedUrl.searchParams.get('include'), 'tags');
	assert.equal(bulkOperations.length, 2);
	assert.equal(bulkOperations[0].updateOne.update.$set.show_modal, true);
	assert.equal(bulkOperations[0].updateOne.update.$set.excerpt, 'Safe copy');
	assert.equal(bulkOperations[0].updateOne.update.$set.link, 'https://typerelay.com/blog/modal-update/');
	assert.equal(bulkOperations[1].updateOne.update.$set.feature_image, '');
	assert.deepEqual(staleQuery, { active: true, ghost_id: { $nin: ['ghost-1', 'ghost-2'] } });
	assert.deepEqual(result, { enabled: true, fetched: 2, upserted: 2, deactivated: 1 });
});

test('does not change stored updates when Ghost fails', async () => {
	let wrote = false;
	const productUpdateModel = { bulkWrite: async () => { wrote = true; }, updateMany: async () => { wrote = true; } };
	await assert.rejects(syncProductUpdates({ fetchImpl: async () => ({ ok: false, status: 503 }), productUpdateModel, config: { contentApiKey: 'content-key', ghostBaseUrl: 'https://typerelay.com' } }), /503/);
	assert.equal(wrote, false);
});

test('follows Ghost pagination before reconciling stored posts', async () => {
	const requestedPages = [];
	let operationCount = 0;
	const fetchImpl = async (url) => {
		const page = Number(url.searchParams.get('page'));
		requestedPages.push(page);
		return { ok: true, json: async () => ({ posts: [{ id: `ghost-${page}`, title: `Update ${page}`, slug: `update-${page}`, excerpt: '', published_at: `2026-08-${31 - page}T12:00:00.000Z`, tags: [{ name: 'product' }] }], meta: { pagination: { pages: 2 } } }) };
	};
	const productUpdateModel = { bulkWrite: async (operations) => { operationCount = operations.length; return {}; }, updateMany: async () => ({}) };
	await syncProductUpdates({ fetchImpl, productUpdateModel, config: { contentApiKey: 'content-key', ghostBaseUrl: 'https://typerelay.com' } });
	assert.deepEqual(requestedPages, [1, 2]);
	assert.equal(operationCount, 2);
});

test('returns a stable cursor page using lean queries', async () => {
	const capture = {};
	const updates = Array.from({ length: 8 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), published_at: new Date(2026, 7, 30 - index) }));
	const productUpdateModel = { find: (query) => { capture.query = query; return Fixture.queryResult(updates, capture); } };
	const page = await listProductUpdates({ productUpdateModel, limit: 7 });
	assert.deepEqual(capture.query, { active: true });
	assert.deepEqual(capture.sort, { published_at: -1, _id: -1 });
	assert.equal(capture.limit, 8);
	assert.equal(page.updates.length, 7);
	assert.ok(ProductUpdates.decodeCursor(page.next_cursor));
	assert.equal(page.latest_update_id, updates[0]._id.toString());
});

test('counts unseen updates and returns modal posts newer than the user marker', async () => {
	const seenAt = new Date('2026-08-20T00:00:00.000Z');
	const userModel = { findById: () => Fixture.queryResult({ product_updates_seen_at: seenAt }) };
	const capturedCounts = [];
	const modalUpdates = [{ _id: new mongoose.Types.ObjectId(), published_at: new Date('2026-08-30T00:00:00.000Z') }];
	const throughUpdate = { _id: new mongoose.Types.ObjectId(), published_at: new Date('2026-08-31T00:00:00.000Z') };
	const productUpdateModel = {
		countDocuments: async (query) => { capturedCounts.push(query); return query.show_modal ? 1 : 3; },
		find: () => Fixture.queryResult(modalUpdates),
		findOne: () => Fixture.queryResult(throughUpdate),
	};
	assert.deepEqual(await getProductUpdateStatus('user-1', { productUpdateModel, userModel }), { new_count: 3, has_modal: true });
	const modal = await getModalProductUpdates('user-1', { productUpdateModel, userModel });
	assert.equal(capturedCounts[0].published_at.$gt, seenAt);
	assert.equal(capturedCounts[1].show_modal, true);
	assert.equal(modal.updates.length, 1);
	assert.equal(modal.through_update_id, throughUpdate._id.toString());
});

test('marks seen state monotonically and backfills only missing users', async () => {
	const updateId = new mongoose.Types.ObjectId();
	const publishedAt = new Date('2026-08-31T00:00:00.000Z');
	let userWrite;
	const productUpdateModel = { findOne: () => Fixture.queryResult({ _id: updateId, published_at: publishedAt }) };
	const userModel = {
		updateOne: async (query, update) => { userWrite = { query, update }; },
		updateMany: async (query, update, options) => { userWrite = { query, update, options }; return { modifiedCount: 4 }; },
	};
	await markProductUpdatesSeen('user-1', updateId.toString(), { productUpdateModel, userModel });
	assert.deepEqual(userWrite, { query: { _id: 'user-1' }, update: { $max: { product_updates_seen_at: publishedAt } } });
	const now = new Date('2026-08-31T12:00:00.000Z');
	assert.deepEqual(await backfillProductUpdatesSeenAt({ userModel, now }), { migrated: 4 });
	assert.deepEqual(userWrite.query, { $or: [{ product_updates_seen_at: { $exists: false } }, { product_updates_seen_at: null }] });
	assert.deepEqual(userWrite.update, { $set: { product_updates_seen_at: now } });
	assert.deepEqual(userWrite.options, { timestamps: false });
});
