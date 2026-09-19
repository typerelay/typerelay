import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import bcrypt from 'bcryptjs';
import * as M from '../model/index.js';
import { Admin } from '../admin.js';
import { AdminAccounts } from '../services/admin_accounts.js';
import { AdminSettings } from '../services/admin_settings.js';
import { AccountAccess } from '../services/account_access.js';
import { Billing } from '../services/billing.js';
import { Auth } from '../services/auth.js';
import { Support } from '../services/support.js';
import { Assets } from '../services/assets.js';
import { Team } from '../services/team.js';

class Fixture {
	static origin = 'http://127.0.0.1:3195';
	static cookie = ''; static csrf = ''; static server; static root; static emails = []; static originalMail;
	static async request(path, method = 'GET', body, headers = {}) {
		const response = await fetch(Fixture.origin + path, { method, redirect: 'manual', headers: { Cookie: Fixture.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': Fixture.csrf, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		if (response.headers.get('set-cookie')) Fixture.cookie = response.headers.get('set-cookie').split(';')[0];
		return response;
	}
	static async json(path, method = 'GET', body, status = 200) { const response = await Fixture.request(path, method, body); const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result; }
	static async csrfFrom(path) { const dom = new JSDOM(await (await Fixture.request(path)).text()); Fixture.csrf = dom.window.document.querySelector('meta[name="csrf-token"]').content; dom.window.close(); }
}

before(async () => {
	Object.assign(process.env, { NODE_ENV: 'test', PORT: '3195', SYSADMIN_EMAIL: 'sysadmin@example.test', SYSADMIN_PASSWORD: randomUUID(), GIT_ENCRYPTION_KEY: 'a'.repeat(64), BILLING_ENABLED: 'false', TYPERELAY_HOSTED_EDITION: 'false', WHITE_LABEL_ENABLED: 'false', APP_URL: Fixture.origin });
	process.env.MONGO_URI = process.env.MONGO_URI.replace('/typerelay?', '/typerelay_admin_test?');
	assert.match(process.env.MONGO_URI, /\/typerelay_admin_test\?/);
	Auth.origin = Fixture.origin;
	Fixture.root = await mkdtemp(join(tmpdir(), 'type-relay-admin-')); process.env.WHITE_LABEL_ASSETS_DIR = Fixture.root;
	Fixture.originalMail = Auth.mail.sendMail; Auth.mail.sendMail = async message => { Fixture.emails.push(message); };
	const { Server } = await import('../app.js'); Fixture.server = await Server.start();
});
after(async () => { Auth.mail.sendMail = Fixture.originalMail; if (Fixture.server) await new Promise(resolve => Fixture.server.close(resolve)); await M.mongoose.connection.dropDatabase(); await M.mongoose.disconnect(); await rm(Fixture.root, { recursive: true, force: true }); });

test('sysadmin credentials fail closed and admin auth requires platform host, CSRF, separate session', async () => {
	assert.equal(Admin.credentials(' SYSADMIN@EXAMPLE.TEST ', process.env.SYSADMIN_PASSWORD), true);
	assert.equal(Admin.credentials('sysadmin@example.test', 'wrong'), false);
	const configured = process.env.SYSADMIN_PASSWORD; delete process.env.SYSADMIN_PASSWORD; assert.equal(Admin.credentials('sysadmin@example.test', ''), false); process.env.SYSADMIN_PASSWORD = configured;
	assert.equal((await Fixture.request('/admin/api/accounts')).status, 401);
	await Fixture.csrfFrom('/admin/login'); const beforeCookie = Fixture.cookie;
	assert.equal((await Fixture.request('/admin/login', 'POST', { email: process.env.SYSADMIN_EMAIL, password: configured }, { 'X-CSRF-Token': '', Authorization: 'Bearer irrelevant' })).status, 403);
	assert.equal((await Fixture.request('/admin/login', 'POST', { email: process.env.SYSADMIN_EMAIL, password: configured }, { Origin: 'https://other.example' })).status, 403);
	const foreignHostStatus = await new Promise((resolve, reject) => { const request = httpRequest(Fixture.origin + '/admin', { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
	assert.equal(foreignHostStatus, 403);
	const login = await Fixture.json('/admin/login', 'POST', { email: process.env.SYSADMIN_EMAIL, password: configured }); Fixture.csrf = login.csrf;
	assert.notEqual(Fixture.cookie, beforeCookie);
	assert.equal((await Fixture.request('/api/v2/libraries', 'GET', undefined, { 'X-Account-Id': new M.Account()._id.toString() })).status, 403);
});

test('account creation, shared users, counts, search, CSV and revisions', async () => {
	const password = 'A'.repeat(32); const emailCount = Fixture.emails.length;
	const created = await Fixture.json('/admin/api/accounts', 'POST', { name: 'Admin fixture', owner_name: 'Owner', owner_email: 'Owner@example.test', password, plan: 'pro', send_signup_email: false }, 201);
	const id = created.id;
	assert.equal(created.account.effective_plan, 'pro'); assert.equal(created.account.override.plan, 'pro'); assert.equal(Fixture.emails.length, emailCount); assert.equal(JSON.stringify(created).includes(password), false);
	const storedUser = await M.User.findOne({ email: 'owner@example.test' }).select('+password').lean(); assert.ok(await bcrypt.compare(password, storedUser.password)); assert.equal((await M.User.findById(storedUser._id).lean()).password, undefined);
	assert.equal(created.account.usage.libraries, 1); assert.equal(created.account.usage.snippets, 6); assert.equal(created.account.usage.assets, 1); assert.ok(created.account.usage.bytes > 0);
	assert.deepEqual((await M.Snippet.find({ account: id }).sort({ position: 1 }).select('trigger').lean()).map(snippet => snippet.trigger), ['welcome', 'jslog', 'rich', 'sig', 'status', 'support']);
	const beforeDuplicate = { accounts: await M.Account.countDocuments(), members: await M.Member.countDocuments(), libraries: await M.Library.countDocuments(), snippets: await M.Snippet.countDocuments() };
	await Fixture.json('/admin/api/accounts', 'POST', { name: 'Rejected account', owner_name: 'Duplicate', owner_email: 'owner@example.test', password: 'B'.repeat(32), plan: 'free', send_signup_email: false }, 409);
	assert.deepEqual({ accounts: await M.Account.countDocuments(), members: await M.Member.countDocuments(), libraries: await M.Library.countDocuments(), snippets: await M.Snippet.countDocuments() }, beforeDuplicate);
	const secondAccount = await M.Account.create({ name: 'Second account' }); await M.Member.create({ account: secondAccount._id, user: storedUser._id, role: 'owner' }); const second = await AdminAccounts.get(String(secondAccount._id));
	const active = await M.Library.create({ account: id, name: 'Active', state: 'active' }); const trashed = await M.Library.create({ account: id, name: 'Trash', state: 'trashed' });
	await M.Snippet.create([{ account: id, library: active._id, id: 'one', state: 'active' }, { account: id, library: trashed._id, id: 'two', state: 'active' }, { account: id, library: active._id, id: 'three', state: 'trashed' }]);
	const detail = await Fixture.json('/admin/api/accounts/' + id);
	assert.equal(detail.account.usage.snippets, 7); assert.equal(detail.account.usage.trash_snippets, 1); assert.equal(detail.account.usage.users, 1); assert.equal(detail.account.owner_accounts, 2);
	const changed = await Fixture.json('/admin/api/accounts/' + id, 'PUT', { revision: detail.revision, name: '=Formula', owner_name: 'Changed shared name', override: { plan: 'team', limits: { people: 8, snippets: 0, machines: 2 } } });
	assert.equal(changed.account.effective_plan, 'team'); assert.equal((await AdminAccounts.get(second.id)).owner.name, 'Changed shared name');
	assert.equal(changed.related[0].id, second.id); assert.equal(changed.related[0].account.owner.name, 'Changed shared name');
	await Fixture.json('/admin/api/accounts/' + id, 'PUT', { revision: detail.revision, name: 'Stale' }, 409);
	const list = await Fixture.json('/admin/api/accounts?q=owner%40example.test'); assert.equal(list.total, 2);
	const csv = await (await Fixture.request('/admin/api/users.csv')).text(); assert.ok(csv.includes('"\'=Formula"'));
	const page = await (await Fixture.request('/admin')).text(); assert.ok(page.includes('account-' + id)); assert.ok(page.includes('Snippets'));
	const form = await Fixture.request('/admin/api/accounts/' + id + '/form'); assert.equal(form.status, 200); assert.match(await form.text(), /affects every account/);
	const newForm = new JSDOM(await (await Fixture.request('/admin/api/accounts/new/form')).text()); const generated = newForm.window.document.querySelector('[name=password]');
	assert.equal(generated.readOnly, true); assert.match(generated.value, /^[A-Za-z0-9_-]{32}$/); assert.equal(newForm.window.document.querySelector('[name=plan]').value, 'free'); assert.equal(newForm.window.document.querySelector('[name=send_signup_email]').checked, false); assert.equal(newForm.window.document.querySelector('[data-rotate-password]'), null); newForm.window.close();
	const email = randomUUID() + '@example.test'; const mailed = await Fixture.json('/admin/api/accounts', 'POST', { name: 'Mailed team', owner_name: 'Mailed Owner', owner_email: email, password: 'C'.repeat(32), plan: 'team', send_signup_email: true }, 201);
	assert.equal(mailed.account.effective_plan, 'team'); assert.ok(Fixture.emails.some(message => message.to === email && message.subject === 'Confirm your Type Relay account'));
	const ticket = await M.Ticket.findOne({ email, kind: 'login' }).lean(); assert.equal(String(ticket.account), mailed.id); assert.equal(ticket.data.name, 'Mailed Owner');
	const free = await Fixture.json('/admin/api/accounts', 'POST', { name: 'Free account', owner_name: 'Free Owner', owner_email: randomUUID() + '@example.test', password: 'D'.repeat(32), plan: 'free', send_signup_email: false }, 201); assert.equal(free.account.effective_plan, 'free');
	const loginPage = await fetch(Fixture.origin + '/login'); const loginCookie = loginPage.headers.get('set-cookie').split(';')[0]; const loginDom = new JSDOM(await loginPage.text()); const loginCsrf = loginDom.window.document.querySelector('meta[name="csrf-token"]').content; loginDom.window.close();
	const login = await fetch(Fixture.origin + '/auth/password', { method: 'POST', redirect: 'manual', headers: { Cookie: loginCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': loginCsrf }, body: JSON.stringify({ email: 'owner@example.test', password }) }); assert.equal(login.status, 200); const authenticatedCookie = login.headers.get('set-cookie').split(';')[0];
	const application = await fetch(Fixture.origin + '/', { headers: { Cookie: authenticatedCookie } }); assert.equal(application.status, 200); assert.match(await application.text(), new RegExp(id));
});

test('post-creation billing and signup email failures warn without breaking password login', async () => {
	const initialize = Billing.initializeAccount; const sendMail = Auth.mail.sendMail; const email = randomUUID() + '@example.test'; const password = 'E'.repeat(32);
	Billing.initializeAccount = async () => { throw new Error('billing unavailable'); }; Auth.mail.sendMail = async () => { throw new Error('mail unavailable'); };
	try {
		const result = await AdminAccounts.create({ name: 'Warning account', owner_name: 'Warning Owner', owner_email: email, password, plan: 'pro', send_signup_email: true });
		assert.deepEqual(result.warnings, ['Billing initialization failed; account created.', 'Signup confirmation email failed; owner can sign in with the generated password.']);
		const user = await M.User.findOne({ email }).select('+password').lean(); assert.ok(await bcrypt.compare(password, user.password)); assert.equal((await Support.context(String(user._id), result.account.id)).account, result.account.id);
	} finally { Billing.initializeAccount = initialize; Auth.mail.sendMail = sendMail; }
});

test('suspension and deletion block web context, desktop and integration credentials', async () => {
	const user = await M.User.create({ email: randomUUID() + '@example.test', name: 'Suspension' }); const account = await M.Account.create({ name: 'Suspension' });
	await M.Member.create({ account: account._id, user: user._id, role: 'owner' });
	const ctx = await Support.context(String(user._id), String(account._id));
	const token = Support.token(); await M.Device.create({ account: account._id, user: user._id, access: Support.hash(token), access_expires: new Date(Date.now() + 60000) });
	const grant = await Auth.createIntegration(ctx, { name: 'Admin test', days: 1, scopes: ['content:read'] });
	await M.Account.updateOne({ _id: account._id }, { $set: { is_active: false } });
	await assert.rejects(Support.context(ctx.user, ctx.account), /unavailable/); await assert.rejects(Auth.bearer(token), /unavailable/); await assert.rejects(Auth.integration('Bearer ' + grant.token), /unavailable/);
	await M.Account.updateOne({ _id: account._id }, { $set: { is_active: true } }); assert.equal((await Support.context(ctx.user, ctx.account)).account, ctx.account);
});

test('overrides survive webhook updates and never change billing fields', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true'; process.env.BILLING_ENABLED = 'true'; process.env.STRIPE_PRO_PRICE_ID = 'price_pro';
	try {
		const account = await M.Account.create({ name: 'Override', plan: 'free', billing: { stripe_customer_id: 'cus_admin_test' }, admin_override: { plan: 'team', limits: { people: 10, snippets: 12 } } });
		const subscription = { id: 'sub_admin_test', object: 'subscription', customer: 'cus_admin_test', status: 'active', metadata: Billing.metadata(account, 'pro'), items: { data: [{ id: 'si_test', price: { id: 'price_pro' }, quantity: 1 }] } };
		await Billing.handleWebhook(null, null, { stripe: {}, event: { type: 'customer.subscription.updated', data: { object: subscription } } });
		const updated = await M.Account.findById(account._id).lean(); assert.equal(updated.plan, 'pro'); assert.equal(Billing.entitlements(updated).plan, 'team'); assert.equal(Billing.entitlements(updated).limits.snippets, 12);
		assert.throws(() => Billing.assertLimit({ entitlements: Billing.entitlements(updated) }, 'snippets', 12, 1), /allows 12/);
		await M.Account.updateOne({ _id: account._id }, { $set: { is_active: false } });
		await Billing.handleWebhook(null, null, { stripe: {}, event: { type: 'customer.subscription.updated', data: { object: { ...subscription, status: 'past_due' } } } });
		assert.equal((await M.Account.findById(account._id).lean()).billing.status, 'past_due', 'Suspension must not lose billing updates');
		await AdminAccounts.requestDeletion(String(account._id), String(account._id));
		assert.deepEqual(await Billing.handleWebhook(null, null, { stripe: {}, event: { type: 'customer.subscription.deleted', data: { object: subscription } } }), { handled: false });
	} finally { process.env.TYPERELAY_HOSTED_EDITION = 'false'; process.env.BILLING_ENABLED = 'false'; }
});

test('templates validate, preview safely, send through existing mail flow and reset', async () => {
	const signup = await AdminSettings.template('signup');
	assert.match(signup.html, /Thanks for signing up for Type Relay/); assert.match(signup.text, /15 minutes/);
	await AdminSettings.set('email.signup', { subject: 'Custom subject', text: '{{url}}' });
	assert.match((await AdminSettings.template('signup')).html, /Thanks for signing up/); assert.equal((await AdminSettings.template('signup')).subject, 'Custom subject');
	await AdminSettings.set('email.signup', { subject: 'Deliberately minimal', text: '{{url}}', html: '' });
	assert.equal((await AdminSettings.template('signup')).text, '{{url}}'); assert.equal((await AdminSettings.template('signup')).html, '');
	await AdminSettings.set('email.signup', {});
	await Fixture.json('/admin/api/email-templates/login', 'PUT', { subject: 'Hello {{bad}}', text: '{{url}}' }, 400);
	await Fixture.json('/admin/api/email-templates/login', 'PUT', { subject: 'Hello', text: 'Open {{url}}' });
	const preview = await Fixture.json('/admin/api/email-templates/login/preview', 'POST', { subject: 'Hello', text: 'Open {{url}}' }); assert.match(preview.text, /example-link/);
	await Fixture.json('/admin/api/email-templates/login/test', 'POST', { email: 'test@example.test' }); assert.equal(Fixture.emails.at(-1).subject, 'Hello');
	await Auth.login('owner@example.test'); assert.equal(Fixture.emails.at(-1).subject, 'Hello'); assert.match(Fixture.emails.at(-1).text, /auth\/callback\?token=/);
	assert.equal(Fixture.emails.at(-1).html, undefined, 'Preserve existing plain-text customizations');
	await Fixture.json('/admin/api/email-templates/login/reset', 'POST', {}); assert.equal((await AdminSettings.template('login')).subject, 'Sign in to Type Relay');
	await Auth.login('owner@example.test'); assert.match(Fixture.emails.at(-1).html, /<a href=/); assert.match(Fixture.emails.at(-1).text, /15 minutes/);
	const defaults = await AdminSettings.template('signup');
	await Fixture.json('/admin/api/email-templates/signup', 'PUT', { subject: defaults.subject, text: defaults.text, html: defaults.html });
	const htmlPreview = await Fixture.json('/admin/api/email-templates/signup/preview', 'POST', defaults); assert.match(htmlPreview.html, /Hi Alex/); assert.match(htmlPreview.preview_html, /Content-Security-Policy/);
	await Fixture.json('/admin/api/email-templates/signup/test', 'POST', { email: 'test@example.test' }); assert.match(Fixture.emails.at(-1).html, /Hi Alex/);
	await Auth.login('new-signup@example.test', 'New <Name>'); assert.match(Fixture.emails.at(-1).html, /New &lt;Name&gt;/); assert.match(Fixture.emails.at(-1).text, /New <Name>/);
	const account = await M.Account.findOne({ name: '=Formula' }).lean(); const owner = await M.User.findOne({ email: 'owner@example.test' }).lean();
	await Team.invite(await Support.context(String(owner._id), String(account._id)), 'invited@example.test');
	assert.match(Fixture.emails.at(-1).subject, /Changed shared name invited you to join =Formula on Type Relay/); assert.match(Fixture.emails.at(-1).html, /Hi there/); assert.match(Fixture.emails.at(-1).text, /7 days/);
});

test('settings encrypt and mask secrets; custom code only enters authenticated app CSP', async () => {
	const secret = 'private-test-secret'; const encrypted = AdminSettings.encrypt(secret); assert.notEqual(encrypted, secret); assert.equal(AdminSettings.decrypt(encrypted), secret);
	const result = await Fixture.json('/admin/api/settings/managani', 'PUT', { enabled: true, base_url: 'https://managani.example.test', site_key: 'public', site_secret: secret }); assert.equal(result.settings.site_secret_configured, true); assert.ok(!JSON.stringify(result).includes(secret));
	assert.ok(!JSON.stringify(await M.SystemSetting.findOne({ key: 'managani' }).lean()).includes(secret));
	await Fixture.json('/admin/api/settings/custom-code', 'PUT', { js: 'window.adminFixture = true;', css: 'body { color: navy; }', origins: ['https://cdn.example.test'] });
	await Fixture.json('/admin/api/settings/custom-code', 'PUT', { js: '</script>', css: '', origins: [] }, 400);
	const locals = { styleNonce: 'nonce-test' }; const headers = { 'Content-Security-Policy': "script-src 'self'; style-src 'self'" }; const response = { locals, getHeader: key => headers[key], setHeader: (key, value) => { headers[key] = value; } };
	await AdminSettings.application({}, response, { _id: new M.User()._id, name: 'Test', email: 'test@example.test' }, { account: 'account', role: 'owner', entitlements: { plan: 'team' } });
	assert.ok(locals.managani.token); assert.match(headers['Content-Security-Policy'], /nonce-nonce-test/); assert.match(headers['Content-Security-Policy'], /style-src-elem 'self' https:\/\/cdn\.example\.test/); assert.match(headers['Content-Security-Policy'], /font-src 'self' https:\/\/cdn\.example\.test/);
	for (const path of ['/admin', '/admin/login', '/login', '/signup']) { const html = await (await Fixture.request(path)).text(); assert.ok(!html.includes('window.adminFixture')); assert.ok(!html.includes('managani.js')); }
	const adminLogin = new JSDOM(await (await Fixture.request('/admin/login')).text()); assert.equal(adminLogin.window.document.title, 'System Administrator Login — Type Relay'); assert.ok(adminLogin.window.document.body.classList.contains('auth-page')); assert.ok(adminLogin.window.document.querySelector('.auth-panel')); assert.ok(adminLogin.window.document.querySelector('.auth-cover')); assert.ok(adminLogin.window.document.querySelector('form[data-admin-login]')); assert.ok(!adminLogin.serialize().includes('/app.js')); adminLogin.window.close();
	const adminCookie = Fixture.cookie; const adminCsrf = Fixture.csrf;
	const token = Support.token(); await M.Ticket.create({ hash: Support.hash(token), kind: 'login', email: 'owner@example.test', expires: new Date(Date.now() + 60000) });
	Fixture.cookie = '';
	await Fixture.request('/auth/callback?token=' + token); const application = await Fixture.request('/'); const applicationHtml = await application.text(); assert.match(applicationHtml, /window.adminFixture/); assert.match(applicationHtml, /managani.js/); assert.equal((await Fixture.request('/admin/api/accounts')).status, 401);
	Fixture.cookie = adminCookie; Fixture.csrf = adminCsrf;
	const factory = AdminSettings.client; AdminSettings.client = () => { throw new Error('Integration unavailable'); };
	try { await AdminSettings.application({}, response, { _id: new M.User()._id }, { account: 'account', role: 'owner', entitlements: { plan: 'team' } }); await AdminSettings.track({ user: (await M.User.findOne({ email: 'owner@example.test' }).lean())._id }, 'test', {}); } finally { AdminSettings.client = factory; }
	await AdminSettings.track({ user: new M.User()._id.toString() }, 'test', {});
	await Fixture.json('/admin/api/settings/managani', 'PUT', { enabled: false, base_url: '', site_key: '', clear_site_secret: true });
	assert.equal((await Fixture.json('/admin/api/settings')).managani.site_secret_configured, false);
});

test('purge drains in-flight operations, retries external failure, removes every owned record and keeps shared users', async () => {
	const shared = await M.User.create({ email: randomUUID() + '@example.test', name: 'Shared' }); const orphan = await M.User.create({ email: randomUUID() + '@example.test', name: 'Orphan' });
	const account = await M.Account.create({ name: 'Purge everything', white_label: { cloudflare_hostname_id: 'hostname' } }); const survivor = await M.Account.create({ name: 'Keep me' }); const id = String(account._id);
	await M.Member.create([{ account: account._id, user: shared._id, role: 'owner' }, { account: account._id, user: orphan._id, role: 'member' }, { account: survivor._id, user: shared._id, role: 'owner' }]);
	await M.Passkey.create([{ user: orphan._id, credential_id: 'orphan-key' }, { user: shared._id, credential_id: 'shared-key' }]);
	for (const name of AdminAccounts.owned.filter(name => name !== 'Member')) await M[name].create({ account: account._id, user: orphan._id, id: name, name, operation: randomUUID(), hash: randomUUID(), ...(name === 'SignupNotification' ? { email: orphan.email, message_id: '<purge@typerelay.test>' } : {}) });
	const grant = await M.Integration.findOne({ account: account._id }).lean(); await M.IntegrationToken.create({ grant: grant._id, hash: randomUUID() });
	await M.Ticket.create([{ hash: randomUUID(), account: account._id }, { hash: randomUUID(), data: { account: id } }, { hash: randomUUID(), data: { grant: grant._id } }, { hash: randomUUID(), email: orphan.email, data: { user: String(orphan._id) } }]);
	await M.MigrationBackup.create([{ key: randomUUID(), source_collection: 'accounts', payload: account.toObject() }, { key: randomUUID(), source_collection: 'libraries', payload: { account: account._id, snippets: [{ secret: 'purge me' }] } }, { key: 'survivor-backup', payload: { account: survivor._id } }]);
	await M.OAuthClient.create({ client_id: 'keep-global-client', name: 'Global' });
	await M.mongoose.connection.collection('web_sessions').insertMany([{ _id: 'orphan-session', session: JSON.stringify({ user: String(orphan._id) }) }, { _id: 'shared-session', session: JSON.stringify({ user: String(shared._id) }) }]);
	await mkdir(join(Fixture.root, id), { recursive: true }); await writeFile(join(Fixture.root, id, 'logo.png'), 'test');
	let started; const ready = new Promise(resolve => { started = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
	const inflight = AccountAccess.run(id, async () => { started(); await gate; await M.Group.create({ account: account._id, name: 'Last in-flight write' }); }); await ready;
	await assert.rejects(AdminAccounts.requestDeletion(id, 'wrong'), /Type the account ID/); await AdminAccounts.requestDeletion(id, id);
	assert.deepEqual(await AdminAccounts.purge(id), { pending: true }); await assert.rejects(AccountAccess.run(id, async () => {}), /unavailable/);
	release(); await inflight;
	await assert.rejects(AdminAccounts.purge(id, { cancelBilling: async () => { throw new Error('External down'); } }), /External down/); assert.equal((await AdminAccounts.get(id)).status, 'failed'); assert.ok(await M.Snippet.exists({ account: account._id }));
	await AdminAccounts.retry(id); let hostname;
	const purged = await AdminAccounts.purge(id, { cancelBilling: async () => {}, deleteHostname: async value => { hostname = value; } }); assert.equal(purged.deleted, id); assert.equal(hostname, 'hostname');
	for (const name of AdminAccounts.owned) assert.equal(await M[name].countDocuments({ account: account._id }), 0, name);
	assert.equal(await M.IntegrationToken.countDocuments({ grant: grant._id }), 0); assert.equal(await M.MigrationBackup.countDocuments(AdminAccounts.backups(account)), 0);
	assert.equal(await M.User.exists({ _id: orphan._id }), null); assert.ok(await M.User.exists({ _id: shared._id })); assert.ok(await M.Passkey.exists({ user: shared._id })); assert.equal(await M.Passkey.exists({ user: orphan._id }), null);
	assert.ok(await M.Account.exists({ _id: survivor._id })); assert.ok(await M.OAuthClient.exists({ client_id: 'keep-global-client' })); assert.ok(await M.MigrationBackup.exists({ key: 'survivor-backup' }));
	assert.equal(await M.mongoose.connection.collection('web_sessions').findOne({ _id: 'orphan-session' }), null); assert.ok(await M.mongoose.connection.collection('web_sessions').findOne({ _id: 'shared-session' }));
	await assert.rejects(access(join(Fixture.root, id)), { code: 'ENOENT' }); assert.deepEqual(await Fixture.json('/admin/api/accounts/' + id + '/deletion'), { deleted: id });
	await assert.rejects(Assets.save({ account: id }, { id: 'a'.repeat(64), data: Buffer.from('test') }), /unavailable/);
});

test('Stripe purge expires sessions and cancels schedules and all subscriptions without billing proration', async () => {
	const calls = [];
	const stripe = { checkout: { sessions: { list: async function* () { yield { id: 'checkout' }; }, expire: async id => calls.push(['expire', id]) } }, subscriptionSchedules: { list: async function* () { yield { id: 'schedule', status: 'active' }; }, retrieve: async () => ({ status: 'active' }), cancel: async (id, options) => calls.push(['schedule', id, options]) }, subscriptions: { list: async function* () { yield { id: 'paid', status: 'active' }; yield { id: 'free', status: 'active' }; }, retrieve: async () => ({ status: 'active' }), cancel: async (id, options) => calls.push(['subscription', id, options]) } };
	stripe.customers = { retrieve: async () => ({ deleted: false }) };
	await AdminAccounts.cancelBilling({ billing: { stripe_customer_id: 'customer' } }, stripe);
	assert.deepEqual(calls.map(call => call[0]), ['expire', 'schedule', 'subscription', 'subscription']); for (const call of calls.slice(1)) assert.deepEqual(call[2], { invoice_now: false, prorate: false });
	stripe.customers.retrieve = async () => { throw Object.assign(new Error('Already deleted'), { code: 'resource_missing' }); };
	await AdminAccounts.cancelBilling({ billing: { stripe_customer_id: 'missing' } }, stripe); assert.equal(calls.length, 4);
});

test('purge resumes an expired worker lease and finds a domain whose ID was never persisted', async () => {
	const account = await M.Account.create({ name: 'Restart cleanup', is_active: false, deletion: { requested_at: new Date(), stage: 'database', lease: 'crashed-worker', lease_until: new Date(Date.now() - 1000) }, white_label: { hostname: 'old.example.test' } });
	await M.AccountLease.create({ account: account._id, token: randomUUID(), expires: new Date(Date.now() - 1000) });
	const removed = [];
	await AdminAccounts.purge(account._id, { cancelBilling: async () => {}, listHostnames: async hostname => [{ id: 'orphan-domain', hostname, custom_metadata: { catalog: Billing.catalogName } }, { id: 'unrelated', hostname, custom_metadata: { catalog: 'other-product' } }], deleteHostname: async id => removed.push(id) });
	assert.deepEqual(removed, ['orphan-domain']); assert.equal(await M.Account.exists({ _id: account._id }), null); assert.equal(await M.AccountLease.exists({ account: account._id }), null);
	await AdminSettings.audit('sysadmin', 'late-failed-request', account._id, 409); assert.equal(await M.AdminAudit.exists({ account: account._id }), null);
});

test('audit logs query both sources and logout removes admin access', async () => {
	const result = await Fixture.json('/admin/api/audit-logs?action=account.create'); assert.ok(result.rows.length >= 2); assert.ok(!JSON.stringify(result).includes(process.env.SYSADMIN_PASSWORD));
	for (const path of ['/admin/settings', '/admin/email-templates', '/admin/audit-logs']) assert.equal((await Fixture.request(path)).status, 200);
	await Fixture.json('/admin/logout', 'POST', {}); assert.equal((await Fixture.request('/admin/api/accounts')).status, 401);
});

test('admin sign-in attempts are throttled', async () => {
	await Fixture.csrfFrom('/admin/login');
	let status;
	for (let index = 0; index < 11; index++) status = (await Fixture.request('/admin/login', 'POST', { email: process.env.SYSADMIN_EMAIL, password: 'invalid' })).status;
	assert.equal(status, 429);
});
