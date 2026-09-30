// Frontend regression tests: intentionally left for user execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import pug from 'pug';
import { AiProvider } from '../ai/index.js';

class BrowserFixture {
	static status = { identity: { account: 'account', user: 'user' }, revisions: { personal: 0, team: 0, installation: 0 }, enabled: true, personal_enabled: true, team_enabled: true, installation_enabled: true, effective: { authoring: { name: 'Test', model: 'test', managed: false }, search: { name: 'Test', model: 'test', managed: false } } };
	static settings = { enabled: true, revision: 0, routes: {}, connections: [{ id: 'a', name: 'A', provider: 'openai', key_configured: true }, { id: 'b', name: 'B', provider: 'openai', key_configured: true }], private_endpoints: [] };
	static create(request, admin = false) {
		const html = pug.renderFile('views/ajax/ai-settings.pug', { canManageTeam: false });
		const dom = new JSDOM(html, { url: 'https://example.test', runScripts: 'outside-only', pretendToBeVisual: true }); const window = dom.window;
		window.structuredClone = structuredClone; window.AbortController = AbortController; window.crypto.randomUUID = randomUUID; window.Swal = { fire: async () => ({ isConfirmed: true }) };
		window.eval(readFileSync('node_modules/tom-select/dist/js/tom-select.complete.min.js', 'utf8'));
		window.eval(readFileSync('public/ai.js', 'utf8').replace('export class AiClient', 'class AiClient') + '\nwindow.AiClient = AiClient;');
		const errors = []; const client = new window.AiClient({ request, identity: () => 'fixture', notify: (message, icon) => { if (icon === 'error') errors.push(message); }, manage: () => {}, admin }); client.acceptStatus(structuredClone(BrowserFixture.status));
		return { dom, window, document: window.document, client, errors };
	}
	static html(settings, scope = 'personal') { return pug.renderFile('views/ajax/ai-configuration.pug', { settings, scope, providers: AiProvider.catalog, protocols: AiProvider.protocols }); }
	static tick() { return new Promise(resolve => setTimeout(resolve, 0)); }
}

test('connection updates affect one row and preserve other fields, focus and scroll', async () => {
	const settings = structuredClone(BrowserFixture.settings); const changed = { ...settings, revision: 1, connections: settings.connections.map(connection => connection.id === 'b' ? { ...connection, name: 'Changed B' } : connection) };
	const response = { id: 'b', settings: changed, connection: changed.connections[1], html: pug.renderFile('views/ajax/ai-connection.pug', { connection: changed.connections[1], scope: 'personal', providers: AiProvider.catalog }), status: { ...BrowserFixture.status, revisions: { personal: 1 } } };
	const fixture = BrowserFixture.create(async path => path.startsWith('/settings') ? { settings, html: BrowserFixture.html(settings), status: BrowserFixture.status } : response);
	try {
		await fixture.client.loadSettings(fixture.document.querySelector('[data-ai-settings]'));
		const root = fixture.document.querySelector('[data-ai-configuration]'); const a = root.querySelector('[data-ai-connection="a"]'); const b = root.querySelector('[data-ai-connection="b"]');
		a.querySelector("form").hidden = false; const other = a.querySelector('[name="api_key"]'); other.value = 'unsaved-other-key'; other.focus(); root.scrollTop = 175;
		const form = b.querySelector('form'); form.hidden = false; form.elements.name.value = 'Changed B'; await fixture.client.submit(form);
		assert.equal(root.querySelector('[data-ai-connection="a"]'), a); assert.equal(other.value, 'unsaved-other-key'); assert.equal(fixture.document.activeElement, other); assert.equal(root.scrollTop, 175);
		assert.match(root.querySelector('[data-ai-connection="b"]').textContent, /Changed B/); assert.deepEqual(fixture.errors, []);
	} finally { fixture.dom.window.close(); }
});

test('AI tabs preserve forms, focus and configuration nodes without requesting a section reload', async () => {
	let requests = 0; const fixture = BrowserFixture.create(async () => { requests++; return { settings: BrowserFixture.settings, html: BrowserFixture.html(BrowserFixture.settings), status: BrowserFixture.status }; });
	try {
		await fixture.client.loadSettings(fixture.document.querySelector('[data-ai-settings]')); const root = fixture.document.querySelector('[data-ai-configuration]'); const providers = root.querySelector('[data-ai-config-panel="providers"]'); const defaults = root.querySelector('[data-ai-config-panel="defaults"]'); const key = providers.querySelector('[name="api_key"]'); key.value = 'unsaved-key'; root.scrollTop = 120;
		const tab = root.querySelector('[data-ai-config-tab="defaults"]'); tab.click(); tab.focus(); assert.equal(providers.hidden, true); assert.equal(defaults.hidden, false); assert.equal(fixture.document.activeElement, tab);
		tab.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); assert.equal(providers.hidden, false); assert.equal(defaults.hidden, true); assert.equal(key.value, 'unsaved-key'); assert.equal(root.scrollTop, 120); assert.equal(requests, 1); assert.equal(root.querySelector('[data-ai-config-panel="providers"]'), providers); assert.equal(root.querySelector('[data-ai-config-panel="defaults"]'), defaults);
	} finally { fixture.dom.window.close(); }
});

test('both model selectors discover automatically and discard delayed replies after switching providers', async () => {
	const pending = []; const fixture = BrowserFixture.create(async (path, method, body, signal) => path === '/models' ? new Promise(resolve => pending.push({ body, signal, resolve })) : { settings: BrowserFixture.settings, html: BrowserFixture.html(BrowserFixture.settings), status: BrowserFixture.status });
	try {
		await fixture.client.loadSettings(fixture.document.querySelector('[data-ai-settings]')); const root = fixture.document.querySelector('[data-ai-configuration]'); const author = root.querySelector('[data-ai-route="authoring"]'); const search = root.querySelector('[data-ai-route="search"]'); const model = author.querySelector('[data-ai-model]'); assert.ok(model.tomselect); assert.ok(search.querySelector('[data-ai-model]').tomselect);
		const provider = author.querySelector('[name="authoring_connection"]'); provider.value = 'a'; provider.dispatchEvent(new fixture.window.Event('change', { bubbles: true })); assert.equal(pending.length, 1);
		provider.value = 'b'; provider.dispatchEvent(new fixture.window.Event('change', { bubbles: true })); assert.equal(pending.length, 2); assert.equal(pending[0].signal.aborted, true);
		pending[1].resolve({ models: [{ id: 'b-model', name: 'B model' }] }); await BrowserFixture.tick(); pending[0].resolve({ models: [{ id: 'a-model', name: 'A model' }] }); await BrowserFixture.tick(); assert.ok(model.tomselect.options['b-model']); assert.equal(model.tomselect.options['a-model'], undefined);
		model.tomselect.createItem('manual-model'); assert.equal(model.value, 'manual-model'); const searchProvider = search.querySelector('[name="search_connection"]'); searchProvider.value = 'a'; searchProvider.dispatchEvent(new fixture.window.Event('change', { bubbles: true })); assert.equal(pending.length, 3); pending[2].resolve({ models: [{ id: 'search-model', name: 'Search model' }] }); await BrowserFixture.tick(); assert.ok(search.querySelector('[data-ai-model]').tomselect.options['search-model']);
		searchProvider.value = ''; searchProvider.dispatchEvent(new fixture.window.Event('change', { bubbles: true })); assert.equal(search.querySelector('[data-ai-model]').tomselect.isDisabled, true); assert.equal(search.querySelector('[data-ai-models]').disabled, true); assert.deepEqual(fixture.errors, []);
	} finally { fixture.dom.window.close(); }
});

test('model discovery failure preserves a saved model and allows refresh without replacing the form', async () => {
	const settings = { ...BrowserFixture.settings, routes: { authoring: { connection: 'a', model: 'saved-model', protocol: 'auto' } } }; let discoveries = 0;
	const fixture = BrowserFixture.create(async path => { if (path !== '/models') return { settings, html: BrowserFixture.html(settings), status: BrowserFixture.status }; if (++discoveries === 1) throw Error('Provider unavailable'); return { models: [{ id: 'new-model', name: 'New model' }] }; });
	try {
		await fixture.client.loadSettings(fixture.document.querySelector('[data-ai-settings]')); await BrowserFixture.tick(); const root = fixture.document.querySelector('[data-ai-configuration]'); const row = root.querySelector('[data-ai-route="authoring"]'); const model = row.querySelector('[data-ai-model]'); assert.equal(model.value, 'saved-model'); assert.deepEqual(fixture.errors, ['Provider unavailable']);
		row.querySelector('[data-ai-models]').click(); await BrowserFixture.tick(); assert.equal(model.value, 'saved-model'); assert.ok(model.tomselect.options['new-model']); assert.equal(fixture.document.querySelector('[data-ai-configuration]'), root);
	} finally { fixture.dom.window.close(); }
});

test('saving endpoint approvals sends only approvals and preserves unsaved defaults and editor fields', async () => {
	const settings = { ...BrowserFixture.settings, daily_limit: 50 }; let saved; const fixture = BrowserFixture.create(async (path, method, body) => { if (method === 'PATCH') { saved = body; return { settings: { ...settings, revision: 1, private_endpoints: ['http://127.0.0.1:11434'] } }; } return { settings, html: BrowserFixture.html(settings, 'installation') }; }, true);
	try {
		await fixture.client.loadSettings(fixture.document.querySelector('[data-ai-settings]')); const root = fixture.document.querySelector('[data-ai-configuration]'); const quota = root.querySelector('[name="daily_limit"]'); quota.value = '90'; const key = root.querySelector('[name="api_key"]'); key.value = 'unsaved-key'; const form = root.querySelector('[data-ai-endpoints-form]'); form.elements.private_endpoints.value = 'http://127.0.0.1:11434'; await fixture.client.submit(form);
		assert.deepEqual(JSON.parse(JSON.stringify(saved)), { scope: 'installation', revision: 0, private_endpoints: 'http://127.0.0.1:11434' }); assert.equal(quota.value, '90'); assert.equal(key.value, 'unsaved-key'); assert.equal(fixture.document.querySelector('[data-ai-configuration]'), root); assert.equal(root.dataset.aiTab, 'providers');
	} finally { fixture.dom.window.close(); }
});

test('late HTTP responses cannot restore deleted rows or older enabled policies', async () => {
	const fixture = BrowserFixture.create(async () => ({ settings: BrowserFixture.settings, html: BrowserFixture.html(BrowserFixture.settings), status: BrowserFixture.status }));
	try {
		await fixture.client.loadSettings(fixture.document.querySelector('[data-ai-settings]')); const root = fixture.document.querySelector('[data-ai-configuration]');
		fixture.client.updateConfig(root, { id: 'b', deleted: true, settings: { ...BrowserFixture.settings, revision: 2, connections: [BrowserFixture.settings.connections[0]] } });
		fixture.client.updateConfig(root, { id: 'b', settings: { ...BrowserFixture.settings, revision: 1 }, html: pug.renderFile('views/ajax/ai-connection.pug', { connection: BrowserFixture.settings.connections[1], scope: 'personal', providers: AiProvider.catalog }) });
		assert.equal(root.querySelector('[data-ai-connection="b"]'), null); assert.equal(root.querySelector('option[value="b"]'), null);
		fixture.client.acceptStatus({ ...BrowserFixture.status, enabled: false, personal_enabled: false, revisions: { personal: 3 } }); fixture.client.acceptStatus(BrowserFixture.status);
		assert.equal(fixture.client.status.enabled, false);
	} finally { fixture.dom.window.close(); }
});

test('app opt-out during status loading prevents authoring dispatch', async () => {
	let resolveStatus; let calls = 0; const fixture = BrowserFixture.create(async () => { calls++; return new Promise(resolve => { resolveStatus = resolve; }); });
	try {
		const ready = fixture.client.ready('authoring'); await BrowserFixture.tick(); fixture.window.localStorage.setItem(fixture.client.localKey(), 'false'); fixture.client.update();
		resolveStatus({ status: BrowserFixture.status }); await assert.rejects(ready, /disabled in this app/); assert.equal(calls, 1);
	} finally { fixture.dom.window.close(); }
});

test('changed editor content discards delayed proposals without saving or replacing surrounding UI', async () => {
	let resolveAuthor; let submitted = false; const fixture = BrowserFixture.create(async path => path === '/author' ? new Promise(resolve => { submitted = true; resolveAuthor = resolve; }) : { status: BrowserFixture.status });
	try {
		const form = fixture.document.createElement('form'); form.append(fixture.client.fragment(pug.renderFile('views/ajax/ai-author.pug'))); fixture.document.body.append(form);
		const root = form.querySelector('[data-ai-author]'); let text = 'Original'; let applied = false;
		fixture.client.bindAuthor(root, async () => ({ title: 'Title', content: { version: 1, type: 'plain_text', text } }), async () => { applied = true; });
		root.querySelector('[data-ai-prompt]').value = 'Improve this';
		root.querySelector('[data-ai-generate]').click(); for (let count = 0; count < 10 && !submitted; count++) await BrowserFixture.tick(); assert.equal(submitted, true);
		text = 'New user edit'; resolveAuthor({ proposal: { title: 'Title', content: { version: 1, type: 'plain_text', text: 'Delayed proposal' } }, status: BrowserFixture.status }); await BrowserFixture.tick();
		assert.equal(root.querySelector('[data-ai-proposal]').hidden, true); assert.equal(applied, false); assert.equal(text, 'New user edit'); assert.equal(form.isConnected, true);
	} finally { fixture.dom.window.close(); }
});
