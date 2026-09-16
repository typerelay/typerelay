import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
	static async browser() {
		const dom = new JSDOM(pug.renderFile('./views/admin/accounts.pug', { csrf: 'csrf', adminEmail: 'admin@example.test', accounts: [], total: 0, page: 1, pages: 1, query: {} }), { url: 'https://app.example.test/admin', runScripts: 'outside-only' });
		dom.window.setInterval = () => 0; dom.window.Swal = { fire: async () => ({ isConfirmed: false }) }; dom.window.bootstrap = { Modal: { getOrCreateInstance: () => ({ hide() {}, show() {} }) } };
		const source = (await readFile('./public/admin.js', 'utf8')).replace('export class AdminUI', 'class AdminUI');
		dom.window.eval(source + '\nwindow.AdminUI = AdminUI;'); return dom;
	}
	static result(id, revision, name = 'Account', status = 'active') {
		const account = { id, revision, name, status, plan: 'free', effective_plan: 'free', billing_status: 'incomplete', owner: { email: 'owner@example.test' }, usage: { users: 1, snippets: 2, libraries: 1, devices: 1 } };
		return { id, revision, account, html: pug.renderFile('./views/ajax/admin-account.pug', { account }) };
	}
}

test('create, edit, status and delete touch only stable account row; stale responses cannot resurrect records', async () => {
	const dom = await Fixture.browser(); const { document, AdminUI } = dom.window;
	try {
		const container = document.getElementById('admin-accounts'); const search = document.getElementById('q'); search.value = 'retained'; search.focus();
		const mutations = []; const observer = new dom.window.MutationObserver(records => mutations.push(...records)); observer.observe(container.parentNode.parentNode, { childList: true, subtree: true });
		AdminUI.update(Fixture.result('one', 1)); AdminUI.update(Fixture.result('two', 1)); const sibling = document.getElementById('account-two');
		AdminUI.update(Fixture.result('one', 2, 'Edited')); AdminUI.update(Fixture.result('one', 2, 'Edited'));
		assert.equal(document.querySelectorAll('#account-one').length, 1); assert.equal(document.getElementById('account-two'), sibling); assert.equal(document.activeElement, search); assert.equal(search.value, 'retained');
		AdminUI.update(Fixture.result('one', 1, 'Stale')); assert.match(document.getElementById('account-one').textContent, /Edited/);
		AdminUI.update(Fixture.result('one', 3, 'Edited', 'deleting')); assert.equal(document.getElementById('account-one').dataset.status, 'deleting');
		AdminUI.update({ deleted: 'one' }); AdminUI.update(Fixture.result('one', 999)); assert.equal(document.getElementById('account-one'), null); assert.equal(document.getElementById('admin-accounts'), container);
		await Promise.resolve(); assert.ok(mutations.every(record => record.target === container || container.contains(record.target))); observer.disconnect();
	} finally { dom.window.close(); }
});

test('failed account save preserves form and rows; success updates immediately without list loader', async () => {
	const dom = await Fixture.browser(); const { document, AdminUI } = dom.window;
	try {
		const result = Fixture.result('a'.repeat(24), 1); result.account.domain = {}; result.account.override = {}; result.account.members = [];
		AdminUI.update(result); const row = document.getElementById('account-' + result.id);
		document.getElementById('admin-modal-body').innerHTML = pug.renderFile('./views/ajax/admin-account-form.pug', { account: result.account });
		const form = document.querySelector('[data-admin-account]'); form.elements.name.value = 'Unsaved'; const submitter = form.querySelector('[type=submit]');
		let errorShown = false; dom.window.Swal.fire = async options => { errorShown ||= options.icon === 'error'; };
		dom.window.fetch = async () => ({ ok: false, json: async () => ({ error: 'Save failed' }) });
		await AdminUI.submit({ target: form, submitter, preventDefault() {} }); assert.equal(form.elements.name.value, 'Unsaved'); assert.equal(document.getElementById('account-' + result.id), row); assert.ok(errorShown); assert.equal(submitter.disabled, false);
		const calls = []; dom.window.fetch = async (path, options) => { calls.push([path, options.method]); return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => Fixture.result(result.id, 2, 'Saved') }; };
		await AdminUI.submit({ target: form, submitter, preventDefault() {} }); assert.match(document.getElementById('account-' + result.id).textContent, /Saved/); assert.deepEqual(calls, [['/admin/api/accounts/' + result.id, 'PUT']]);
	} finally { dom.window.close(); }
});
