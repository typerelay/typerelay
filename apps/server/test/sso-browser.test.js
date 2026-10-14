import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
	static settings(revision = 1, issuer = 'https://idp.example.test') { return { revision, html: pug.renderFile('./views/ajax/sso.pug', { settings: { entitled: true, owner: true, revision, issuer, login_url: issuer + '/sso', certificate: 'Fixture certificate', urls: { metadata: '/metadata', callback: '/callback', login: '/login', recovery: '/recovery' } } }) }; }
	static async create(request, hash = '') {
		const dom = new JSDOM('<div id="workspace"><input id="draft" value="Unsaved snippet"></div><div id="settings" class="modal show"><div class="modal-body"><button data-settings-tab="profile">Profile</button><button data-settings-tab="sso">Single sign-on</button><div class="settings-pane" id="settings-pane-profile"></div><div class="settings-pane" id="settings-pane-sso"><div id="sso-settings-container"></div><div id="sso-secret-container"></div></div></div></div>', { url: 'https://app.typerelay.com/' + hash, runScripts: 'outside-only', pretendToBeVisual: true });
		const app = (await readFile('./public/app.js', 'utf8')).replace(/^import .*;$/gm, '').replace('const client = new TypeRelay();', 'const client = window.client = Object.create(TypeRelay.prototype);').replace('export { client };', '');
		dom.window.eval(app);
		const client = dom.window.client; client.account = 'account'; client.request = request; client.toast = () => {};
		dom.window.eval((await readFile('./public/auth.js', 'utf8')).replace(/^import .*;$/gm, '').replace('new AccountUI();', 'window.accountUI = new AccountUI();'));
		return { dom, client, ui: dom.window.accountUI, document: dom.window.document };
	}
	static async flush() { await new Promise(resolve => setImmediate(resolve)); }
}

test('keyboard and direct-link activation load Single sign-on settings', async () => {
	for (const hash of ['', '#settings-sso']) {
		let count = 0; const fixture = await Fixture.create(async path => { assert.equal(path, 'sso'); count++; return Fixture.settings(); }, hash);
		try {
			if (!hash) fixture.client.keyboard({ target: fixture.document.querySelector('[data-settings-tab="profile"]'), key: 'ArrowDown', preventDefault() {} });
			await Fixture.flush();
			assert.equal(count, 1); assert.ok(fixture.document.querySelector('#sso-settings-form'));
			if (!hash) assert.equal(fixture.document.activeElement.dataset.settingsTab, 'sso');
		} finally { fixture.dom.window.close(); }
	}
});

test('SSO saves update only the configuration, preserve focus and scroll, and ignore stale responses', async () => {
	const pending = []; const fixture = await Fixture.create(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
	try {
		const { ui, document } = fixture; const workspace = document.querySelector('#workspace'); const modal = document.querySelector('#settings'); const panel = document.querySelector('.modal-body');
		const initial = ui.sso(); pending[0].resolve(Fixture.settings()); await initial;
		document.querySelector('#sso-issuer').focus(); panel.scrollTop = 230;
		const older = ui.sso(); const save = ui.sso('PUT', {});
		pending[2].resolve(Fixture.settings(2, 'https://new.example.test')); await save;
		assert.equal(document.activeElement.id, 'sso-issuer'); assert.equal(panel.scrollTop, 230);
		pending[1].resolve(Fixture.settings(1)); await older;
		assert.equal(document.querySelector('#sso-issuer').value, 'https://new.example.test');
		const failed = ui.sso('PUT', {}); pending[3].reject(new Error('Offline')); await assert.rejects(failed, /Offline/);
		assert.equal(document.querySelector('#sso-issuer').value, 'https://new.example.test'); assert.equal(document.querySelector('#workspace'), workspace); assert.equal(document.querySelector('#settings'), modal); assert.equal(document.querySelector('#draft').value, 'Unsaved snippet');
	} finally { fixture.dom.window.close(); }
});
