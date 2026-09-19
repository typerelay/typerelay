import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
	static async browser(page = 'accounts', locals = {}, hash = '') {
		const dom = new JSDOM(pug.renderFile('./views/admin/' + page + '.pug', { csrf: 'csrf', adminEmail: 'admin@example.test', accounts: [], total: 0, page: 1, pages: 1, query: {}, ...locals }), { url: 'https://app.example.test/admin' + hash, runScripts: 'outside-only' });
		dom.window.setInterval = () => 0; dom.window.Swal = { fire: async () => ({ isConfirmed: false }) }; dom.window.bootstrap = { Modal: { getOrCreateInstance: () => ({ hide() {}, show() {} }) } };
		const password = (await readFile('./public/password-field.js', 'utf8')).replace('export class PasswordField', 'class PasswordField');
		const source = (await readFile('./public/admin.js', 'utf8')).replace(/^import .*;$/gm, '').replace('export class AdminUI', 'class AdminUI');
		dom.window.eval(password + '\n' + source + '\nwindow.AdminUI = AdminUI;'); return dom;
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

test('settings left navigation preserves drafts and supports deep links and keyboard selection without fetching', async () => {
	const dom = await Fixture.browser('settings', { managani: {}, customCode: { js: '', css: '', origins: [] }, status: { smtp: true } }, '#settings-custom-code');
	const { document, AdminUI } = dom.window;
	try {
		dom.window.fetch = () => { throw new Error('Panel navigation must not fetch or reload'); };
		const custom = document.querySelector('[data-admin-settings="custom-code"]'); const managani = document.querySelector('[data-admin-settings="managani"]');
		assert.equal(custom.closest('[role="tabpanel"]').hidden, false);
		custom.elements.js.value = 'unsaved custom code';
		await AdminUI.click({ target: document.getElementById('settings-nav-managani') });
		managani.elements.base_url.value = 'https://unsaved.example.test';
		assert.equal(custom.closest('[role="tabpanel"]').hidden, true);
		document.getElementById('settings-nav-managani').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(document.activeElement.id, 'settings-nav-custom-code'); assert.equal(custom.elements.js.value, 'unsaved custom code');
		await AdminUI.click({ target: document.getElementById('settings-nav-managani') }); assert.equal(managani.elements.base_url.value, 'https://unsaved.example.test');
		assert.equal(document.querySelector('[data-admin-settings="custom-code"]'), custom); assert.equal(document.querySelectorAll('[role="tab"][aria-selected="true"]').length, 1);
		assert.equal(dom.window.location.hash, '#settings-managani');
	} finally { dom.window.close(); }
});

test('template editor saves and resets only the selected form, preserving other drafts and panel nodes', async () => {
	const templates = [{ key: 'login', name: 'Sign in', subject: 'Sign in', text: '{{url}}' }, { key: 'invite', name: 'Invitation', subject: 'Join', text: '{{url}}' }];
	const dom = await Fixture.browser('templates', { templates }); const { document, AdminUI } = dom.window;
	try {
		const ids = [...document.querySelectorAll('[id]')].map(node => node.id); assert.equal(ids.length, new Set(ids).size);
		const login = document.querySelector('[data-admin-template="login"]'); const invite = document.querySelector('[data-admin-template="invite"]');
		login.elements.subject.value = 'Saved subject'; login.elements.html.value = '<p>Saved {{url}}</p>'; invite.elements.text.value = 'Keep this invitation draft {{url}}'; invite.elements.html.value = '<p>Invitation draft {{url}}</p>';
		await AdminUI.click({ target: document.getElementById('templates-nav-invite') }); await AdminUI.click({ target: document.getElementById('templates-nav-login') });
		assert.equal(login.elements.subject.value, 'Saved subject');
		const calls = []; dom.window.fetch = async (path, options) => { calls.push([path, options.method]); return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ id: 'login', template: { subject: path.endsWith('/reset') ? 'Default subject' : 'Saved subject', text: '{{url}}', html: path.endsWith('/reset') ? '<p>Default {{url}}</p>' : '<p>Saved {{url}}</p>' } }) }; };
		await AdminUI.submit({ target: login, submitter: login.querySelector('[type="submit"]'), preventDefault() {} });
		assert.equal(document.querySelector('[data-admin-template="login"]'), login); assert.equal(invite.elements.text.value, 'Keep this invitation draft {{url}}');
		login.elements.subject.value = 'Discard this change'; login.elements.html.value = '<p>Discard HTML</p>'; login.reset(); assert.equal(login.elements.subject.value, 'Saved subject'); assert.equal(login.elements.html.value, '<p>Saved {{url}}</p>');
		dom.window.Swal.fire = async () => ({ isConfirmed: true });
		await AdminUI.click({ target: login.querySelector('[data-template-reset]') });
		assert.equal(login.elements.subject.value, 'Default subject'); assert.equal(invite.elements.text.value, 'Keep this invitation draft {{url}}');
		assert.equal(login.elements.html.value, '<p>Default {{url}}</p>'); assert.equal(invite.elements.html.value, '<p>Invitation draft {{url}}</p>');
		const frame = login.querySelector('[data-template-preview-frame]'); assert.equal(frame.getAttribute('sandbox'), ''); assert.equal(frame.hidden, true);
		assert.equal(document.getElementById('templates-panel-login').hidden, false);
		assert.deepEqual(calls, [['/admin/api/email-templates/login', 'PUT'], ['/admin/api/email-templates/login/reset', 'POST']]);
	} finally { dom.window.close(); }
});

test('account status sidebar retains search/plan and resets pagination; logs have no sidebar', async () => {
	const dom = await Fixture.browser('accounts', { query: { q: 'Example', plan: 'team', status: 'suspended', page: '4' } });
	try {
		const nav = dom.window.document.querySelector('nav[aria-label="Account statuses"]'); assert.equal(nav.querySelector('[aria-current="page"]').textContent, 'Suspended');
		const link = new URL(nav.querySelector('a').href); assert.equal(link.searchParams.get('q'), 'Example'); assert.equal(link.searchParams.get('plan'), 'team'); assert.equal(link.searchParams.get('page'), '1');
		assert.equal(dom.window.document.querySelector('input[name="status"]').value, 'suspended');
	} finally { dom.window.close(); }
	const logs = await Fixture.browser('audit', { rows: [], more: false }); try { assert.equal(logs.window.document.querySelector('.admin-section-nav'), null); } finally { logs.window.close(); }
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

test('new account form keeps generated password readonly, copies it and normalizes creation fields', async () => {
	const dom = await Fixture.browser(); const { document, AdminUI } = dom.window;
	try {
		const password = 'A'.repeat(32);
		document.getElementById('admin-modal-body').innerHTML = pug.renderFile('./views/ajax/admin-account-form.pug', { account: null, password });
		const form = document.querySelector('[data-admin-account]'); const input = form.elements.password; const submitter = form.querySelector('[type=submit]');
		assert.equal(input.readOnly, true); assert.equal(input.value, password); assert.equal(form.elements.plan.value, 'free'); assert.equal(form.elements.send_signup_email.checked, false); assert.equal(form.querySelector('[data-rotate-password]'), null);
		Object.defineProperty(dom.window, 'isSecureContext', { value: true }); Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } });
		document.execCommand = command => command === 'copy'; let copied = false; dom.window.Swal.fire = async options => { copied ||= options.title === 'Password copied'; return {}; };
		await AdminUI.click({ target: form.querySelector('[data-copy-password]') }); assert.equal(copied, true); assert.equal(form.querySelector('[data-password-status]').textContent, '');
		form.elements.name.value = 'New account'; form.elements.owner_name.value = 'New owner'; form.elements.owner_email.value = 'new@example.test';
		let requestBody; let errorShown = false; dom.window.Swal.fire = async options => { errorShown ||= options.icon === 'error'; return {}; };
		dom.window.fetch = async (path, options) => { requestBody = JSON.parse(options.body); return { ok: false, json: async () => ({ error: 'Creation failed' }) }; };
		await AdminUI.submit({ target: form, submitter, preventDefault() {} });
		assert.equal(requestBody.password, password); assert.equal(requestBody.plan, 'free'); assert.equal(requestBody.send_signup_email, false); assert.equal(input.value, password); assert.equal(form.elements.owner_email.value, 'new@example.test'); assert.equal(errorShown, true);
	} finally { dom.window.close(); }
});
