import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mongoose, User, Account, Member, Ticket, ProductUpdate } from '../model/index.js';
import { Support } from '../services/support.js';
import { ProductUpdates } from '../services/product_updates.js';
import { Auth } from '../services/auth.js';

class Fixture {
	static origin = 'http://127.0.0.1:3183'; static cookie = ''; static csrf = ''; static server; static user; static account; static updates;
	static async request(path, method = 'GET', body, headers = {}) {
		const response = await fetch(Fixture.origin + path, { method, redirect: 'manual', headers: { Cookie: Fixture.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': Fixture.csrf, ...headers }, body: body ? JSON.stringify(body) : undefined });
		if (response.headers.get('set-cookie')) Fixture.cookie = response.headers.get('set-cookie').split(';')[0];
		return response;
	}
}

before(async () => {
	process.env.NODE_ENV = 'test'; process.env.PORT = '3183'; process.env.TYPERELAY_HOSTED_EDITION = 'true'; process.env.TYPERELAY_GHOST_CONTENT_API_KEY = 'fixture-key'; process.env.BILLING_ENABLED = 'false'; process.env.WHITE_LABEL_ENABLED = 'false';
	process.env.MONGO_URI = process.env.MONGO_URI.replace(/\/[^/?]+(?=\?|$)/, '/typerelay_product_updates_test');
	process.env.SESSION_SECRET = Support.token(); process.env.JWT_SECRET = Support.token();
	Auth.origin = Fixture.origin;
	await mongoose.connect(process.env.MONGO_URI);
	const id = new mongoose.Types.ObjectId();
	await User.collection.insertOne({ _id: id, email: randomUUID() + '@example.test', name: 'News reader', createdAt: new Date('2020-01-01'), updatedAt: new Date('2020-01-01') });
	const { Server } = await import('../app.js'); Fixture.server = await Server.start();
	Fixture.user = await User.findById(id).select('+product_updates_seen_at').lean();
	Fixture.account = await Account.create({ name: 'News test' });
	await Member.create({ user: id, account: Fixture.account._id, role: 'owner' });
	const baseline = Fixture.user.product_updates_seen_at.getTime();
	Fixture.updates = await ProductUpdate.create(Array.from({ length: 9 }, (_, index) => ({ ghost_id: 'ghost-' + index, title: 'Update ' + index, excerpt: 'Details', slug: 'update-' + index, link: 'https://typerelay.com/blog/update-' + index + '/', published_at: new Date(baseline + index * 1000 + 1000), show_modal: index % 2 === 0, active: true })));
});

after(async () => {
	if (Fixture.server) await new Promise(resolve => Fixture.server.close(resolve));
	if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});

test('real authenticated routes enforce CSRF, persist monotonic seen state and render the archive', async () => {
	assert.ok(Fixture.user.product_updates_seen_at > new Date('2020-01-01'));
	assert.equal((await User.findById(Fixture.user._id).lean()).product_updates_seen_at, undefined);
	const baseline = Fixture.user.product_updates_seen_at;
	await ProductUpdates.backfillProductUpdatesSeenAt({ now: new Date('2099-01-01') });
	assert.deepEqual((await User.findById(Fixture.user._id).select('+product_updates_seen_at').lean()).product_updates_seen_at, baseline);
	assert.ok(new User({ email: 'new@example.test' }).product_updates_seen_at >= baseline);
	assert.equal((await Fixture.request('/ajax/product-updates/status')).status, 401);
	const token = Support.token();
	await Ticket.create({ hash: Support.hash(token), kind: 'login', email: Fixture.user.email, expires: new Date(Date.now() + 60000) });
	assert.equal((await Fixture.request('/auth/callback?token=' + token)).status, 302);
	const page = await Fixture.request('/news?account=' + Fixture.account._id);
	assert.equal(page.status, 200);
	assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: https: http:/);
	const pageHtml = await page.text();
	const dom = new JSDOM(pageHtml);
	Fixture.csrf = dom.window.document.querySelector('meta[name=csrf-token]').content;
	assert.equal(dom.window.document.querySelectorAll('[data-product-update-id]').length, 7);
	assert.equal(dom.window.document.querySelector('#workspace-content').hidden, false);
	assert.ok(dom.window.document.querySelector('#product-updates-drawer #product-updates-news'));
	const newsLink = dom.window.document.querySelector('[data-product-updates-nav]');
	assert.ok(newsLink);
	assert.equal(newsLink.querySelector('span:not(#product-updates-badge)').classList.contains('fw-semibold'), false);
	const cursor = dom.window.document.querySelector('#product-updates-news').dataset.nextCursor;
	dom.window.close();
	assert.deepEqual(await (await Fixture.request('/ajax/product-updates/status')).json(), { new_count: 9, has_modal: true });
	const modalHtml = await (await Fixture.request('/ajax/product-updates/modal')).text();
	const modal = new JSDOM(modalHtml);
	assert.equal(modal.window.document.querySelectorAll('.product-update-modal-item').length, 5);
	assert.equal(modal.window.document.querySelector('#productUpdatesModal').dataset.throughUpdateId, String(Fixture.updates[8]._id));
	modal.window.close();
	const itemsHtml = await (await Fixture.request('/ajax/product-updates/items?cursor=' + encodeURIComponent(cursor))).text();
	const remaining = new JSDOM(itemsHtml);
	assert.equal(remaining.window.document.querySelectorAll('[data-product-update-id]').length, 2); remaining.window.close();
	if (process.env.PRODUCT_UPDATES_BROWSER_CAPTURE) await writeFile(process.env.PRODUCT_UPDATES_BROWSER_CAPTURE, JSON.stringify({ page: await (await Fixture.request('/')).text(), news: pageHtml, modal: modalHtml, items: itemsHtml, archive: await (await Fixture.request('/ajax/section/news')).text() }));
	assert.equal((await Fixture.request('/ajax/product-updates/items?cursor=invalid')).status, 400);
	assert.equal((await Fixture.request('/ajax/product-updates/seen', 'POST', { update_id: String(Fixture.updates[8]._id) }, { 'X-CSRF-Token': '' })).status, 403);
	const responses = await Promise.all([8, 2, 6].map(index => Fixture.request('/ajax/product-updates/seen', 'POST', { update_id: String(Fixture.updates[index]._id) })));
	assert.ok(responses.every(response => response.ok));
	assert.deepEqual((await User.findById(Fixture.user._id).select('+product_updates_seen_at').lean()).product_updates_seen_at, Fixture.updates[8].published_at);
	assert.deepEqual(await (await Fixture.request('/ajax/product-updates/status')).json(), { new_count: 0, has_modal: false });
	assert.equal((await Fixture.request('/ajax/product-updates/modal')).status, 204);
	await ProductUpdate.updateMany({}, { $set: { active: false } });
	assert.match(await (await Fixture.request('/ajax/section/news')).text(), /No product updates yet/);
	assert.equal(ProductUpdates.eligible({ session: { user: Fixture.user._id }, boundAccount: 'white-label' }), false);
	delete process.env.TYPERELAY_GHOST_CONTENT_API_KEY;
	assert.equal((await Fixture.request('/ajax/product-updates/status')).status, 404);
	assert.equal((await Fixture.request('/news')).status, 302);
	process.env.TYPERELAY_GHOST_CONTENT_API_KEY = 'fixture-key'; process.env.TYPERELAY_HOSTED_EDITION = 'false';
	assert.equal((await Fixture.request('/ajax/product-updates/status')).status, 404);
});
