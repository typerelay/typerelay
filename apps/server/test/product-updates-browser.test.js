import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
	static post(id = 'one') { return { _id: id, title: 'Update ' + id, excerpt: 'Safe excerpt', published_at: new Date('2026-09-16'), link: 'https://typerelay.com/blog/' + id + '/', feature_image: '' }; }
	static archive(updates = [Fixture.post()], cursor = '') { return pug.renderFile('./views/ajax/section/news.pug', { product_updates: { updates, latest_update_id: updates[0]?._id || '', next_cursor: cursor } }); }
	static modal() { return pug.renderFile('./views/ajax/product_updates_modal.pug', { product_updates: { updates: [Fixture.post()], through_update_id: 'one' } }); }
	static async create(request) {
		const dom = new JSDOM('<a class="brand-link" href="/">Home</a><a href="/news" data-product-updates-nav>News</a><span id="product-updates-badge" class="d-none"></span><div id="workspace-content"><input id="draft" value="unsaved"><input type="checkbox" checked></div><div id="conflicts"></div><div id="news-view" hidden></div><div id="product-updates-modal-root"></div>', { url: 'https://app.typerelay.com/?account=account', runScripts: 'outside-only', pretendToBeVisual: true });
		const { window } = dom;
		window.scrollTo = (x, y) => { Object.defineProperty(window, 'scrollX', { configurable: true, value: x }); Object.defineProperty(window, 'scrollY', { configurable: true, value: y }); };
		const instances = new Map();
		window.bootstrap = { Modal: { getInstance: node => instances.get(node), getOrCreateInstance: node => { if (!instances.has(node)) instances.set(node, { show: () => node.classList.add('show'), hide: () => { node.classList.remove('show'); node.dispatchEvent(new window.Event('hidden.bs.modal', { bubbles: true })); }, dispose: () => instances.delete(node) }); return instances.get(node); } } };
		const errors = []; const calls = [];
		const app = { account: 'account', request: async (...args) => { calls.push(args); return request(...args); }, fragment: html => { const template = window.document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; }, toast: message => errors.push(message) };
		window.eval((await readFile('./public/product-updates.js', 'utf8')).replace('export class ProductNews', 'window.ProductNews = class ProductNews'));
		const news = new window.ProductNews(app);
		await Fixture.flush();
		return { dom, window, news, calls, errors };
	}
	static async flush() { await new Promise(resolve => setImmediate(resolve)); }
}

test('archive navigation preserves workspace nodes, draft, selection and scroll; pagination deduplicates', async () => {
	const fixture = await Fixture.create(async path => {
		if (path.endsWith('/status')) return { new_count: 2, has_modal: false };
		if (path === '/ajax/section/news') return Fixture.archive([Fixture.post()], 'cursor');
		if (path.endsWith('/seen')) return { new_count: 0 };
		if (path.includes('/items?')) return pug.renderFile('./views/ajax/product_update_items.pug', { product_updates: { updates: [Fixture.post(), Fixture.post('two')], next_cursor: '' } });
		assert.fail('Unexpected reload: ' + path);
	});
	try {
		const { news, window, calls } = fixture; const { document } = window;
		const workspace = document.querySelector('#workspace-content'); const input = document.querySelector('#draft');
		input.value = 'unsaved changes'; input.focus(); input.setSelectionRange(2, 5); window.scrollTo(0, 450);
		await news.navigate(true, true);
		assert.equal(window.location.pathname, '/news'); assert.equal(workspace.hidden, true);
		const root = document.querySelector('#product-updates-news'); const list = root.querySelector('#product-updates-list');
		await news.more(root, root.querySelector('button'));
		assert.equal(list.children.length, 2); assert.equal(root.querySelector('button').classList.contains('d-none'), true);
		await news.navigate(false, true);
		assert.equal(document.querySelector('#workspace-content'), workspace); assert.equal(workspace.hidden, false);
		assert.equal(document.querySelector('#draft'), input); assert.equal(input.value, 'unsaved changes'); assert.equal(input.selectionStart, 2); assert.equal(document.activeElement, input);
		assert.equal(document.querySelector('input[type=checkbox]').checked, true); assert.equal(window.scrollY, 450);
		await news.navigate(true, true);
		assert.equal(document.querySelector('#product-updates-list'), list);
		assert.equal(calls.filter(([path]) => path === '/ajax/section/news').length, 1);
	} finally { fixture.dom.window.close(); }
});

test('modal defers behind another modal; failed dismissal preserves UI; successful dismissal updates badge only', async () => {
	let fail = true;
	const fixture = await Fixture.create(async path => {
		if (path.endsWith('/status')) return { new_count: 1, has_modal: false };
		if (path.endsWith('/seen')) { if (fail) throw new Error('Save failed'); return { new_count: 0 }; }
		assert.fail(path);
	});
	try {
		const { news, window, errors } = fixture; const { document } = window;
		const other = document.createElement('div'); other.className = 'modal show'; document.body.append(other);
		news.root.append(news.app.fragment(Fixture.modal())); news.queued = true; news.showQueued();
		const modal = news.root.firstElementChild;
		assert.equal(modal.classList.contains('show'), false);
		other.remove(); news.showQueued(); assert.equal(modal.classList.contains('show'), true);
		const button = modal.querySelector('[data-product-updates-dismiss]');
		await news.dismiss(button, false);
		assert.deepEqual(errors, ['Save failed']); assert.equal(modal.classList.contains('show'), true); assert.equal(button.disabled, false);
		assert.equal(document.querySelector('#product-updates-badge').textContent, '1');
		fail = false; await news.dismiss(button, false);
		assert.equal(document.querySelector('#product-updates-badge').classList.contains('d-none'), true);
		assert.equal(document.querySelector('#draft').value, 'unsaved');
	} finally { fixture.dom.window.close(); }
});

test('late status and modal responses cannot restore a dismissed update', async () => {
	let release; let delayed = false;
	const fixture = await Fixture.create(async path => {
		if (path.endsWith('/status')) return delayed ? new Promise(resolve => { release = resolve; }) : { new_count: 0, has_modal: false };
		if (path.endsWith('/seen')) return { new_count: 0 };
		assert.fail('Stale response triggered modal: ' + path);
	});
	try {
		const { news } = fixture;
		delayed = true; news.lastCheck = 0; const checking = news.check();
		await news.seen('one'); release({ new_count: 10, has_modal: true }); await checking;
		assert.equal(news.root.children.length, 0);
		assert.equal(fixture.window.document.querySelector('#product-updates-badge').textContent, '0');
	} finally { fixture.dom.window.close(); }
});

test('empty archive and escaped Ghost content render with Mailtwine modal controls', () => {
	assert.match(Fixture.archive([]), /No product updates yet/);
	const post = { ...Fixture.post(), title: '<img src=x onerror=alert(1)>', excerpt: '<script>alert(1)</script>' };
	const html = pug.renderFile('./views/ajax/product_updates_modal.pug', { product_updates: { updates: [post], through_update_id: 'one' } });
	assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
	assert.match(html, /modal-dialog-centered modal-dialog-scrollable modal-lg/);
	assert.match(html, /Got it/); assert.match(html, /Read more/); assert.match(html, /data-bs-keyboard="false"/);
});

test('concurrent acknowledgements cannot restore an older badge count', async () => {
	const pending = [];
	const fixture = await Fixture.create(async path => {
		if (path.endsWith('/status')) return { new_count: 9, has_modal: false };
		if (path.endsWith('/seen')) return new Promise(resolve => pending.push(resolve));
		assert.fail(path);
	});
	try {
		const older = fixture.news.seen('old'); const newer = fixture.news.seen('new');
		pending[0]({ new_count: 5 }); await older;
		pending[1]({ new_count: 0 }); await newer;
		assert.equal(fixture.window.document.querySelector('#product-updates-badge').textContent, '0');
		const first = fixture.news.seen('old'); const second = fixture.news.seen('new');
		pending[3]({ new_count: 0 }); await second;
		pending[2]({ new_count: 5 }); await first;
		assert.equal(fixture.window.document.querySelector('#product-updates-badge').textContent, '0');
	} finally { fixture.dom.window.close(); }
});

test('new arrivals refresh the archive on explicit navigation, never during polling', async () => {
	let latest = 'one'; let archiveLoads = 0;
	const fixture = await Fixture.create(async path => {
		if (path.endsWith('/status')) return { new_count: 1, has_modal: false };
		if (path.endsWith('/seen')) return { new_count: 0 };
		if (path === '/ajax/section/news') { archiveLoads++; return Fixture.archive([Fixture.post(latest)]); }
		assert.fail(path);
	});
	try {
		const { news, window } = fixture;
		await news.navigate(true, true); await news.navigate(false, true);
		latest = 'two'; news.lastCheck = 0; await news.check();
		assert.equal(archiveLoads, 1);
		assert.equal(window.document.querySelector('[data-product-update-id]').dataset.productUpdateId, 'one');
		await news.navigate(true, true);
		assert.equal(archiveLoads, 2);
		assert.equal(window.document.querySelector('[data-product-update-id]').dataset.productUpdateId, 'two');
	} finally { fixture.dom.window.close(); }
});
