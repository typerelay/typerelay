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
	static create(request) {
		const html = pug.renderFile('views/ajax/ai-settings.pug', { canManageTeam: false });
		const dom = new JSDOM(html, { url: 'https://example.test', runScripts: 'outside-only', pretendToBeVisual: true }); const window = dom.window;
		window.structuredClone = structuredClone; window.AbortController = AbortController; window.crypto.randomUUID = randomUUID; window.Swal = { fire: async () => ({ isConfirmed: true }) };
		window.eval(readFileSync('public/ai.js', 'utf8').replace('export class AiClient', 'class AiClient') + '\nwindow.AiClient = AiClient;');
		const errors = []; const client = new window.AiClient({ request, identity: () => 'fixture', notify: (message, icon) => { if (icon === 'error') errors.push(message); }, manage: () => {} }); client.acceptStatus(structuredClone(BrowserFixture.status));
		return { dom, window, document: window.document, client, errors };
	}
	static html(settings) { return pug.renderFile('views/ajax/ai-configuration.pug', { settings, scope: 'personal', providers: AiProvider.catalog, protocols: AiProvider.protocols }); }
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
