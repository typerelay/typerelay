import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pug from 'pug';
import { JSDOM } from 'jsdom';
import { WhiteLabel } from '../services/white_label.js';

class Fixture {
	static settings(hostname = '') { return WhiteLabel.domainSettings({ _id: 'account-proof', plan: 'team', billing: { status: 'active' }, white_label: { hostname } }); }
	static render(settings) { return pug.renderFile('./views/ajax/white-label.pug', { whiteLabelSettings: settings }); }
	static async open(hostname = '') {
		const dom = new JSDOM(`<link rel="icon" href="/favicon.ico"><section id="settings-pane-whiteLabel">${Fixture.render(Fixture.settings(hostname))}</section><input id="outside">`, { runScripts: 'outside-only', url: 'https://tr.n.lan' });
		const source = (await readFile('./public/app.js', 'utf8')).replace(/^import .*;$/gm, '').replace('const client = new TypeRelay();', '').replace('export { client };', 'window.TypeRelay = TypeRelay;');
		dom.window.CSS = { escape: value => value };
		dom.window.eval(source);
		const client = Object.create(dom.window.TypeRelay.prototype);
		client.toast = () => {};
		return { dom, client, document: dom.window.document };
	}
}

test('owner settings render exact TXT instructions after save, with no internal claim token', () => {
	const settings = Fixture.settings('portal.example.test');
	const dom = new JSDOM(Fixture.render(settings));
	try {
		assert.equal(dom.window.document.querySelector('#white-label-txt-name').value, '_typerelay.portal.example.test');
		assert.equal(dom.window.document.querySelector('#white-label-txt-value').value, 'typerelay-domain-verification=account-proof');
		assert.equal(dom.window.document.querySelector('#white-label-txt-value').readOnly, true);
		assert.doesNotMatch(dom.serialize(), /claim_token/);
		assert.equal(new JSDOM(Fixture.render(Fixture.settings())).window.document.querySelector('#white-label-txt-name'), null);
	} finally { dom.window.close(); }
});

test('adding TXT instructions preserves hostname focus, selection, scroll and unrelated nodes', async () => {
	const { dom, client, document } = await Fixture.open();
	try {
		const outside = document.querySelector('#outside'); const hostname = document.querySelector('#white-label-hostname');
		hostname.value = 'portal.example.test'; hostname.focus(); hostname.setSelectionRange(2, 7);
		Object.defineProperty(dom.window, 'scrollY', { value: 170, configurable: true });
		client.applyWhiteLabel({ settings: Fixture.settings('portal.example.test'), html: Fixture.render(Fixture.settings('portal.example.test')) });
		assert.equal(document.activeElement.id, 'white-label-hostname'); assert.equal(document.activeElement.selectionStart, 2); assert.equal(document.activeElement.selectionEnd, 7); assert.equal(dom.window.scrollY, 170); assert.equal(document.querySelector('#outside'), outside);
		assert.ok(document.querySelector('#white-label-txt-value'));
	} finally { dom.window.close(); }
});

for (const failed of [false, true]) for (const moved of [false, true]) test(`verification ${failed ? 'failure' : 'success'} ${moved ? 'preserves moved focus' : 'restores initiating control focus'} without navigation`, async () => {
	const { dom, client, document } = await Fixture.open('portal.example.test');
	try {
		const button = document.querySelector('#white-label-verify'); button.focus();
		const result = { settings: Fixture.settings('portal.example.test'), html: Fixture.render(Fixture.settings('portal.example.test')) };
		client.request = async () => { assert.equal(button.disabled, true); if (moved) document.querySelector('#outside').focus(); else button.blur(); if (failed) throw Object.assign(new Error('TXT mismatch'), result); return result; };
		const request = client.whiteLabelRequest('white-label/domain/verify', 'POST', {}, button);
		if (failed) await assert.rejects(request, /TXT mismatch/); else await request;
		assert.equal(document.activeElement.id, moved ? 'outside' : 'white-label-verify'); assert.equal(document.querySelector('#white-label-verify').disabled, false); assert.equal(dom.window.location.pathname, '/');
	} finally { dom.window.close(); }
});
