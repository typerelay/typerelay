import { BrowserSource } from './browser-source.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Encoder } from 'cbor-x';
const cbor = new Encoder({ useRecords: false, useTag259ForMaps: false, tagUint8Array: false });
import { generateSync } from 'otplib';
import { JSDOM } from 'jsdom';
import bcrypt from 'bcryptjs';
import { mongoose, User, Account, Ticket, Member, Passkey, Device, SignupNotification, Integration, IntegrationToken, OAuthClient, Library, Snippet, SnippetAsset, Change } from '../model/index.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Security } from '../services/security.js';
import { SignupNotifications } from '../services/signup_notifications.js';
import { Team } from '../services/team.js';
import { Billing } from '../services/billing.js';
import { RichText } from '../services/rich_text.js';
import { StarterContent } from '../services/starter_content.js';

class Browser {
	cookie = ''; csrf = ''; account = '';
	async call(path, method = 'GET', body) {
		const response = await fetch(Fixture.origin + path, { method, redirect: 'manual', headers: { Cookie: this.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf, 'X-Account-Id': this.account }, body: body ? JSON.stringify(body) : undefined });
		if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
		return response;
	}
	async page(path = '/') {
		const response = await this.call(path);
		const dom = new JSDOM(await response.text());
		this.csrf = dom.window.document.querySelector('meta[name=csrf-token]')?.content || this.csrf;
		this.account = dom.window.document.querySelector('#workspace')?.dataset.account || this.account;
		dom.window.close();
	}
	async json(path, method = 'POST', body = {}, expected = 200) {
		const response = await this.call(path, method, body);
		const value = await response.json();
		assert.equal(response.status, expected, JSON.stringify(value));
		if (value.csrf) this.csrf = value.csrf;
		return value;
	}
	async tokens() {
		const token = await this.json('/api/v2/access-tokens', 'POST', { name: 'Session token' });
		assert.ok((await this.json('/api/v2/access-tokens', 'GET', null)).some(row => row.id === token.id));
		await this.json('/api/v2/access-tokens/' + token.id, 'DELETE');
	}
}
class Fixture {
	static origin = 'http://127.0.0.1:3150'; static server; static mails = [];
	static mailUrl(mail) { const match = mail.text.match(/https?:\/\/[^\s]+/); assert.ok(match, 'Email contains an action URL'); return new URL(match[0]); }
	static async account() {
		const browser = new Browser();
		await browser.page();
		const email = randomUUID() + '@example.test';
		await browser.json('/auth/signup', 'POST', { name: 'Original Name', email });
		const mail = Fixture.mails.findLast(mail => mail.to === email);
		await browser.call(Fixture.mailUrl(mail).pathname + Fixture.mailUrl(mail).search);
		await browser.page();
		return { browser, email, user: await User.findOne({ email }).lean() };
	}
	static b64(bytes) { return Buffer.from(bytes).toString('base64url'); }
	static credential(challenge) {
		const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		const jwk = pair.publicKey.export({ format: 'jwk' });
		const id = randomBytes(32);
		const cose = cbor.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
		const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
		const authData = Buffer.concat([createHash('sha256').update('127.0.0.1').digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, cose]);
		const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: Fixture.origin, crossOrigin: false }));
		return { id: Fixture.b64(id), pair, response: { id: Fixture.b64(id), rawId: Fixture.b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: Fixture.b64(clientDataJSON), attestationObject: Fixture.b64(cbor.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] } } };
	}
	static assertion(credential, challenge, user) {
		const counter = Buffer.alloc(4); counter.writeUInt32BE(1);
		const authData = Buffer.concat([createHash('sha256').update('127.0.0.1').digest(), Buffer.from([0x05]), counter]);
		const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: Fixture.origin, crossOrigin: false }));
		const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), credential.pair.privateKey);
		return { id: credential.id, rawId: credential.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: Fixture.b64(clientData), authenticatorData: Fixture.b64(authData), signature: Fixture.b64(signature), userHandle: Fixture.b64(Buffer.from(String(user._id))) } };
	}
}
before(async () => {
	process.env.NODE_ENV = 'test';
	process.env.PORT = '3150';
	process.env.MONGO_URI = process.env.MONGO_URI.replace('/typerelay?', '/typerelay_security?');
	process.env.SESSION_SECRET = Support.token();
	process.env.JWT_SECRET = Support.token();
	process.env.ENABLE_SIGNUP = 'true';
	Auth.origin = Fixture.origin;
	Auth.mail.sendMail = async mail => { Fixture.mails.push(mail); return { accepted: [mail.to] }; };
	const { Server } = await import('../app.js');
	Fixture.server = await Server.start();
});
after(async () => {
	await new Promise(resolve => Fixture.server.close(resolve));
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
});
test('SMTP_SERVERS uses the shared authenticated multi-server format', () => {
	const servers = Auth.smtpServers({ SMTP_FROM: 'fallback@example.test', SMTP_SERVERS: JSON.stringify([{ name: 'one', host: 'smtp1.example.test', port: 587, user: 'user', pass: 'pass' }, { host: 'smtp2.example.test', port: 465, secure: true, from: 'two@example.test' }]) });
	assert.deepEqual(servers, [{ name: 'one', host: 'smtp1.example.test', port: 587, secure: false, user: 'user', pass: 'pass', from: 'fallback@example.test' }, { name: 'smtp-2', host: 'smtp2.example.test', port: 465, secure: true, user: '', pass: '', from: 'two@example.test' }]);
	Auth.smtpIndex = 0;
	assert.equal(Auth.nextSmtpServer(servers).name, 'one');
	assert.equal(Auth.nextSmtpServer(servers).name, 'smtp-2');
	assert.equal(Auth.nextSmtpServer(servers).name, 'one');
	assert.throws(() => Auth.smtpServers({ SMTP_SERVERS: '{}' }), /non-empty JSON array/);
});
test('confirmed hosted signups notify Type Relay through a durable retrying outbox', async () => {
	const email = randomUUID() + '@example.test';
	await Auth.login(email, 'Hosted Owner');
	const confirmation = Fixture.mailUrl(Fixture.mails.findLast(mail => mail.to === email));
	const originalSendMail = Auth.mail.sendMail;
	process.env.TYPERELAY_HOSTED_EDITION = 'true';
	Auth.mail.sendMail = async mail => { if (mail.to === 'hi@typerelay.com') throw new Error('temporary SMTP failure'); Fixture.mails.push(mail); return { accepted: [mail.to] }; };
	try { await Auth.consume(confirmation.searchParams.get('token')); }
	finally { Auth.mail.sendMail = originalSendMail; delete process.env.TYPERELAY_HOSTED_EDITION; }
	const user = await User.findOne({ email }).lean();
	let record;
	for (let attempt = 0; attempt < 100; attempt++) { record = await SignupNotification.findOne({ user: user._id }).lean(); if (record?.attempts) break; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.equal(record.status, 'pending'); assert.equal(record.attempts, 1);
	assert.equal(await Library.countDocuments({ account: record.account, state: 'active' }), 1); assert.equal(await Snippet.countDocuments({ account: record.account, state: 'active' }), 6);
	await SignupNotification.updateOne({ _id: record._id }, { $set: { next_attempt_at: new Date(0) } });
	const delivered = [];
	assert.deepEqual(await SignupNotifications.reconcile(async message => delivered.push(message)), { checked: 1, sent: 1, retrying: 0, failed: 0 });
	assert.equal(delivered[0].to, 'hi@typerelay.com'); assert.equal(delivered[0].replyTo, email); assert.match(delivered[0].subject, /^Type Relay signup:/); assert.match(delivered[0].text, /Account ID:/); assert.match(delivered[0].messageId, /^<typerelay-signup-/);
	assert.equal((await SignupNotification.findById(record._id).lean()).status, 'sent');
	assert.deepEqual(await SignupNotifications.reconcile(async () => { throw new Error('must not resend'); }), { checked: 0, sent: 0, retrying: 0, failed: 0 });
	const failedUser = await User.create({ email: randomUUID() + '@example.test', name: 'Failed notification' });
	const failedAccount = await Account.create({ name: 'Failed notification' });
	const failedRecord = await SignupNotification.create({ account: failedAccount._id, user: failedUser._id, email: failedUser.email, name: failedUser.name, attempts: SignupNotifications.maxAttempts - 1, message_id: SignupNotifications.messageId(failedAccount._id) });
	await assert.rejects(SignupNotifications.deliver(failedRecord._id, async () => { throw new Error('permanent SMTP failure'); }), /permanent SMTP failure/);
	const exhausted = await SignupNotification.findById(failedRecord._id).lean(); assert.equal(exhausted.status, 'failed'); assert.equal(exhausted.attempts, SignupNotifications.maxAttempts);
});
test('self-hosted signup confirmation creates no operational notification', async () => {
	const email = randomUUID() + '@example.test'; await Auth.login(email, 'Self-hosted Owner');
	const confirmation = Fixture.mailUrl(Fixture.mails.findLast(mail => mail.to === email));
	const user = await User.findById(await Auth.consume(confirmation.searchParams.get('token'))).lean();
	assert.equal(await SignupNotification.exists({ user: user._id }), null);
	const member = await Member.findOne({ user: user._id, role: 'owner' }).lean();
	const library = await Library.findOne({ account: member.account, creator: user._id }).lean();
	assert.equal(library.name, 'My snippets'); assert.equal(library.shared, false); assert.equal(library.state, 'active');
	const snippets = await Snippet.find({ library: library._id, state: 'active' }).sort({ position: 1 }).lean();
	assert.deepEqual(snippets.map(snippet => snippet.trigger), ['welcome', 'jslog', 'rich', 'sig', 'status', 'support']);
	assert.deepEqual(snippets.map(snippet => snippet.content.type), ['template', 'code', 'rich_text', 'template', 'template', 'rich_text']);
	assert.equal(snippets[0].content.variables.name.label, 'Name'); assert.equal(snippets[1].content.language, 'javascript');
	assert.equal(snippets[4].content.variables.date.format, 'YYYY-MM-DD'); assert.equal(snippets[4].content.variables.date.timezone, 'local');
	const icon = await SnippetAsset.findOne({ account: member.account }).lean();
	assert.ok(icon); assert.deepEqual(snippets[2].content.assets, [icon.id]); assert.equal(snippets[2].content.markdown.split('\n')[0], `![TypeRelay icon](typerelay-asset:${icon.id})`); assert.doesNotMatch(snippets[2].content.markdown, /<img/); assert.equal(await Change.countDocuments({ account: member.account, library: library._id }), 1);
	const support = RichText.render({ ...snippets[5].content, values: { name: 'Alex' }, preview: false, assets: {} });
	assert.match(support.html, /Hi Alex/); assert.match(support.html, /href="https:\/\/typerelay\.com\/"/); assert.match(support.html, /href="https:\/\/docs\.typerelay\.com\/mcp\/"/); assert.match(support.html, /href="https:\/\/app\.typerelay\.com\/"/); assert.match(support.rtf, /TypeRelay Support/); assert.match(support.text, /open the in-app chat/);
	assert.deepEqual(await Billing.usage(member.account), { libraries: 1, snippets: 6, people: 1, invitations: 0, machines: 0 });
	await Auth.login(email); const repeat = Fixture.mailUrl(Fixture.mails.findLast(mail => mail.to === email)); assert.equal(await Auth.consume(repeat.searchParams.get('token')), String(user._id)); assert.equal(await Library.countDocuments({ account: member.account }), 1);
});
test('starter content rolls back with its account transaction', async () => {
	let account; let user;
	await assert.rejects(mongoose.connection.transaction(async session => {
		[user] = await User.create([{ email: randomUUID() + '@example.test', name: 'Rollback Owner' }], { session });
		[account] = await Account.create([{ name: 'Rollback account' }], { session });
		await Member.create([{ account: account._id, user: user._id, role: 'owner' }], { session });
		await StarterContent.create(account, user, session);
		throw new Error('rollback starter content');
	}), /rollback starter content/);
	assert.equal(await User.exists({ _id: user._id }), null); assert.equal(await Account.exists({ _id: account._id }), null); assert.equal(await Member.exists({ account: account._id }), null);
	assert.equal(await Library.exists({ account: account._id }), null); assert.equal(await Snippet.exists({ account: account._id }), null); assert.equal(await SnippetAsset.exists({ account: account._id }), null); assert.equal(await Change.exists({ account: account._id }), null);
});
test('team admins directly add new or existing users without replacing existing passwords', async () => {
	const owner = await User.create({ email: randomUUID() + '@example.test', name: 'Team Owner' });
	const account = await Account.create({ name: 'Direct team' });
	await Member.create({ user: owner._id, account: account._id, role: 'owner' });
	const ctx = await Support.context(String(owner._id), String(account._id));
	const generatedEmail = randomUUID() + '@example.test';
	await Ticket.create({ hash: Support.hash(Support.token()), kind: 'invite', email: generatedEmail, account: account._id, expires: new Date(Date.now() + 60000) });
	const generated = await Team.add(ctx, { name: 'Generated User', email: generatedEmail, password: '', send_welcome_email: false });
	assert.ok(generated.temporary_password.length >= 20); assert.equal(generated.member.profile.name, 'Generated User');
	const generatedUser = await User.findOne({ email: generatedEmail }).select('+password').lean();
	assert.ok(!JSON.stringify(generated).includes('$2')); assert.ok(await bcrypt.compare(generated.temporary_password, generatedUser.password)); assert.equal((await User.findById(generatedUser._id).lean()).password, undefined); assert.equal(await Ticket.exists({ kind: 'invite', email: generatedEmail, account: account._id }), null);
	assert.ok(!Fixture.mails.some(mail => mail.to === generatedEmail));
	await assert.rejects(Team.add(ctx, { name: 'Duplicate', email: generatedEmail, password: '', send_welcome_email: false }), /already a member/);
	await assert.rejects(Team.add(ctx, { name: '', email: randomUUID() + '@example.test', password: '', send_welcome_email: false }), /Invalid text/);
	await assert.rejects(Team.add(ctx, { name: 'Short password', email: randomUUID() + '@example.test', password: 'short', send_welcome_email: false }), /at least 8 characters/);
	await assert.rejects(Team.add({ ...ctx, role: 'member' }, { name: 'Blocked', email: randomUUID() + '@example.test', password: '', send_welcome_email: false }), /Admin required/);
	const customEmail = randomUUID() + '@example.test';
	const custom = await Team.add(ctx, { name: 'Custom User', email: customEmail, password: 'custom-password', send_welcome_email: true });
	assert.equal(custom.temporary_password, 'custom-password'); assert.ok(Fixture.mails.some(mail => mail.to === customEmail && mail.subject.includes('access')));
	const existingPassword = await Security.password('existing-password');
	const existing = await User.create({ email: randomUUID() + '@example.test', name: 'Existing User', password: existingPassword.hash });
	const linked = await Team.add(ctx, { name: '', email: existing.email, password: 'replacement-password', send_welcome_email: false });
	assert.equal(linked.temporary_password, undefined); assert.equal(linked.member.profile.name, 'Existing User');
	assert.ok(await bcrypt.compare(existingPassword.password, (await User.findById(existing._id).select('+password').lean()).password));
});
test('signup, generated password, password login, OAuth continuation and recovery', async () => {
	const { browser, email, user } = await Fixture.account();
	await browser.tokens();
	assert.equal(user.name, 'Original Name');
	const password = (await browser.json('/api/v2/security/password')).password;
	assert.ok(password.length >= 20);
	assert.equal((await User.findById(user._id).lean()).password, undefined);
	const login = new Browser();
	await login.page();
	await login.json('/auth/password', 'POST', { email, password: 'wrong' }, 401);
	const challenge = 'A'.repeat(43);
	const params = new URLSearchParams({ client_id: 'typerelay-desktop', redirect_uri: 'http://127.0.0.1:34000/callback', code_challenge_method: 'S256', code_challenge: challenge, state: 'B'.repeat(32) });
	await login.page('/oauth/authorize?' + params);
	const result = await login.json('/auth/password', 'POST', { email, password });
	assert.ok(result.redirect.startsWith('/oauth/authorize?'));
	await login.page('/');
	assert.ok(login.account);
	await login.tokens();
	await login.json('/auth/forgot-password', 'POST', { email });
	const reset = Fixture.mailUrl(Fixture.mails.findLast(mail => mail.subject.startsWith('Reset')));
	const fresh = (await login.json('/auth/reset-password', 'POST', { token: reset.searchParams.get('token') })).password;
	assert.notEqual(fresh, password);
	await login.json('/auth/reset-password', 'POST', { token: reset.searchParams.get('token') }, 400);
	assert.equal((await browser.call('/api/v2/libraries')).status, 403, 'Password reset invalidates other browser sessions');
	await login.json('/auth/password', 'POST', { email, password }, 401);
	await login.json('/auth/password', 'POST', { email, password: fresh });
});
test('profile name updates incrementally, email requires confirmation and cannot steal an existing address', async () => {
	const { browser, email, user } = await Fixture.account();
	const replacement = randomUUID() + '@example.test';
	const result = await browser.json('/api/v2/profile', 'PATCH', { name: 'Updated Name', email: replacement });
	assert.equal(result.pending_email, replacement);
	assert.equal((await User.findById(user._id).lean()).email, email);
	assert.match(result.avatar, /UN/);
	const confirm = Fixture.mailUrl(Fixture.mails.findLast(mail => mail.to === replacement));
	const anonymous = new Browser(); await anonymous.page();
	await anonymous.json('/auth/email', 'POST', { token: confirm.searchParams.get('token') }, 401);
	await browser.json('/auth/email', 'POST', { token: confirm.searchParams.get('token') });
	assert.equal((await User.findById(user._id).lean()).email, replacement);
	await browser.json('/auth/email', 'POST', { token: confirm.searchParams.get('token') }, 400);
	const other = await Fixture.account();
	await browser.json('/api/v2/profile', 'PATCH', { name: 'Updated Name', email: other.email }, 409);
	const html = await (await browser.call('/')).text();
	const dom = new JSDOM(html, { url: Fixture.origin, runScripts: 'outside-only' });
	dom.window.Swal = { fire: async () => ({ isConfirmed: true }) };
	dom.window.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() {}, hide() {} }) } };
	dom.window.fetch = (path, options = {}) => fetch(new URL(path, Fixture.origin), { ...options, headers: { ...options.headers, Cookie: browser.cookie } });
	dom.window.eval((await BrowserSource.script()).replace('new TypeRelay();', 'window.client = new TypeRelay();').replace('export { client };', ''));
	const settings = dom.window.document.querySelector('#settings');
	const name = dom.window.document.querySelector('#profile-name');
	name.value = 'Avatar Changed'; name.focus();
	const form = dom.window.document.querySelector('#profile-form');
	await dom.window.client.onSubmit({ target: form, preventDefault() {}, submitter: form.querySelector('button') });
	assert.equal(dom.window.document.querySelector('#settings'), settings);
	assert.equal(dom.window.document.activeElement, name);
	assert.equal(dom.window.document.querySelector('#account-avatar span').textContent, 'AC');
	assert.ok(dom.window.document.querySelector('#members').textContent.includes('Avatar Changed'));
	dom.window.close();
});
test('TOTP setup, password and magic-link challenges, invalid codes, replay prevention and disable', async () => {
	const { browser, email, user } = await Fixture.account();
	const password = (await browser.json('/api/v2/security/password')).password;
	const setup = await browser.json('/api/v2/security/totp/setup');
	assert.ok(setup.qr.startsWith('data:image/png;base64,'));
	const code = generateSync({ secret: setup.secret });
	await browser.json('/api/v2/security/totp/confirm', 'POST', { code });
	assert.equal((await User.findById(user._id).lean()).totp_secret, undefined);
	await browser.json('/api/v2/security/totp/setup', 'POST', {}, 400);
	const login = new Browser(); await login.page();
	const pending = await login.json('/auth/password', 'POST', { email, password });
	assert.equal(pending.requires2FA, true);
	assert.equal((await login.call('/api/v2/libraries')).status, 400);
	await login.json('/auth/two-factor', 'POST', { code: 'abcdef' }, 400);
	await login.json('/auth/two-factor', 'POST', { code });
	await login.page();
	await login.tokens();
	await login.json('/api/v2/security/totp/disable', 'POST', { code }, 401);
	// Simulate a new time window without delaying the suite.
	await User.updateOne({ _id: user._id }, { $unset: { totp_step: 1 } });
	await login.json('/api/v2/security/totp/disable', 'POST', { code: generateSync({ secret: setup.secret }) });
	assert.equal((await User.findById(user._id).lean()).totp_enabled, false);
	// Magic-link sign-in also honors enabled 2FA.
	await User.updateOne({ _id: user._id }, { $set: { totp_secret: setup.secret, totp_enabled: true } });
	const token = Support.token();
	await Ticket.create({ hash: Support.hash(token), kind: 'login', email, expires: new Date(Date.now() + 60000) });
	const magic = new Browser(); await magic.page();
	const response = await magic.call('/auth/callback?token=' + token);
	assert.equal(response.headers.get('location'), '/auth/two-factor');
	await magic.page('/auth/two-factor');
	await User.updateOne({ _id: user._id }, { $unset: { totp_step: 1 } });
	await magic.json('/auth/two-factor', 'POST', { code: generateSync({ secret: setup.secret }) });
	await magic.page();
	await magic.tokens();
});
test('real signed passkey registration/login, challenge replay and ownership', async () => {
	const { browser, user } = await Fixture.account();
	const options = await browser.json('/api/v2/security/passkeys/options');
	const credential = Fixture.credential(options.challenge);
	const result = await browser.json('/api/v2/security/passkeys/verify', 'POST', { name: 'Test passkey', response: credential.response });
	assert.ok(result.key._id);
	await browser.json('/api/v2/security/passkeys/verify', 'POST', { name: 'Replay', response: credential.response }, 400);
	assert.equal((await Passkey.findById(result.key._id).lean()).public_key, undefined);
	const login = new Browser(); await login.page();
	const invalidOptions = await login.json('/auth/passkey/options');
	const invalid = Fixture.assertion(credential, invalidOptions.challenge, user);
	invalid.response.signature = Fixture.b64(randomBytes(64));
	await login.json('/auth/passkey/verify', 'POST', { response: invalid }, 400);
	const request = await login.json('/auth/passkey/options');
	const authenticated = await login.json('/auth/passkey/verify', 'POST', { response: Fixture.assertion(credential, request.challenge, user) });
	assert.equal(authenticated.redirect, '/');
	await login.page();
	assert.ok(login.account);
	await login.tokens();
	const outsider = await Fixture.account();
	assert.equal((await outsider.browser.call('/api/v2/security/passkeys/' + result.key._id)).status, 404);
	await outsider.browser.json('/api/v2/security/passkeys/' + result.key._id, 'DELETE');
	assert.ok(await Passkey.exists({ _id: result.key._id }));
	await browser.json('/api/v2/security/passkeys/' + result.key._id, 'DELETE');
	assert.equal(await Passkey.exists({ _id: result.key._id }), null);
});
test('login exposes all requested methods and native OAuth form remains unaffected', async () => {
	const browser = new Browser();
	const response = await browser.call('/');
	const dom = new JSDOM(await response.text());
	const page = dom.window.document;
	assert.equal(page.querySelector('#magic-link-btn').textContent, 'Magic Link');
	assert.equal(page.querySelector('#passkey-btn').textContent, 'Passkey');
	assert.ok(page.querySelector('#password-login-form input[type=password]'));
	assert.ok(page.querySelector('a[href="/forgot-password"]'));
	assert.ok(page.querySelector('a[href="/signup"]'));
	dom.window.close();
});

test('ENABLE_SIGNUP=false removes signup controls and blocks signup', async () => {
	process.env.ENABLE_SIGNUP = 'false';
	try {
		const browser = new Browser();
		await browser.page('/login');
		const login = await browser.call('/login');
		const loginDom = new JSDOM(await login.text());
		assert.equal(loginDom.window.document.querySelector('a[href="/signup"]'), null);
		loginDom.window.close();
		const signup = await browser.call('/signup');
		const signupDom = new JSDOM(await signup.text());
		assert.equal(signupDom.window.document.querySelector('#signup-form'), null);
		assert.match(signupDom.window.document.body.textContent, /Sign up disabled/);
		signupDom.window.close();
		await browser.json('/auth/signup', 'POST', { name: 'Disabled', email: randomUUID() + '@example.test' }, 403);
	} finally { process.env.ENABLE_SIGNUP = 'true'; }
});

test('login waits for persistence before returning its redirect, including pending 2FA', async () => {
	const { user } = await Fixture.account();
	for (const factor of [false, true]) {
		await User.updateOne({ _id: user._id }, { $set: { totp_enabled: factor } });
		let persisted = false;
		const req = { session: { regenerate: callback => callback(), save: callback => setTimeout(() => { persisted = true; callback(); }, 30) } };
		const result = await Security.establish(req, user._id);
		assert.equal(persisted, true);
		assert.equal(result.redirect, factor ? '/auth/two-factor' : '/');
	}
});
test('token settings use the normal session and update individual rows without reloads', async () => {
	const { browser, user } = await Fixture.account();
	const dom = new JSDOM(await (await browser.call('/')).text(), { url: Fixture.origin, runScripts: 'outside-only' });
	try {
		const document = dom.window.document;
		for (const [label, href] of [['Docs', 'https://docs.typerelay.com'], ['Apps', 'https://typerelay.com/apps/']]) {
			const link = [...document.querySelectorAll('header .dropdown a')].find(node => node.textContent === label);
			assert.equal(link.href, new URL(href).href); assert.equal(link.target, '_blank');
		}
		document.querySelector('#workspace').removeAttribute('data-account');
		dom.window.fetch = (path, options) => fetch(Fixture.origin + path, { ...options, headers: { ...options.headers, Cookie: browser.cookie }, redirect: 'manual' });
		dom.window.eval((await BrowserSource.script()).replace('export { client };', 'window.testClient = client;'));
		const client = dom.window.testClient; client.account = browser.account;
		client.toast = () => {}; client.confirm = async () => true;
		client.poll = client.loadTrash = () => assert.fail('No page or section reload');
		const pane = document.querySelector('#settings-pane-tokens');
		const form = document.querySelector('#access-token-form');
		form.elements.name.value = 'CLI';
		const sessions = await mongoose.connection.collection('web_sessions').find({}).toArray();
		const stored = sessions.find(row => JSON.parse(row.session).user === String(user._id));
		const session = JSON.parse(stored.session); session.auth_at = Date.now() - 16 * 60000;
		await mongoose.connection.collection('web_sessions').updateOne({ _id: stored._id }, { $set: { session: JSON.stringify(session) } });
		const allowed = await browser.call('/api/v2/access-tokens'); assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'), 'no-store');
		await client.onSubmit({ target: form, preventDefault() {}, submitter: form.querySelector('button[type=submit]') });
		const row = document.querySelector('[data-access-token]'); assert.ok(row);
		assert.match(row.textContent, /CLI.*Created/s); assert.doesNotMatch(row.textContent, /scope|expire/i);
		const secret = document.querySelector('#access-token-secret [data-secret-value]'); assert.match(secret.value, /^tr_pat_/);
		assert.ok(!(await browser.json('/api/v2/access-tokens', 'GET', null)).some(item => JSON.stringify(item).includes(secret.value)));
		assert.equal(document.querySelector('#settings-pane-tokens'), pane);
		let release;
		const request = client.request.bind(client);
		client.request = async (path, ...args) => path === 'access-tokens' && !args.length ? new Promise(resolve => { release = resolve; }) : request(path, ...args);
		const pending = client.tokens();
		await client.onClick({ target: row.querySelector('[data-delete-token]') });
		release([{ id: row.dataset.accessToken, html: row.outerHTML }]); await pending;
		assert.equal(document.querySelector('[data-access-token]'), null, 'Late list response cannot restore revoked token');
		assert.equal(document.querySelector('#settings-pane-tokens'), pane);
		document.querySelector('#settings').dispatchEvent(new dom.window.Event('hidden.bs.modal')); assert.equal(document.querySelector('#access-token-secret').children.length, 0);
		const anonymous = new Browser(); await anonymous.page();
		assert.notEqual((await anonymous.call('/api/v2/access-tokens')).status, 200);
	} finally { dom.window.close(); }
});
test('OAuth settings manage metadata, authorized apps and confidential clients incrementally', async () => {
	const { browser, user } = await Fixture.account(); const dom = new JSDOM(await (await browser.call('/')).text(), { url: Fixture.origin, runScripts: 'outside-only' });
	try {
		const document = dom.window.document; const pane = document.querySelector('#settings-pane-tokens'); document.querySelector('#workspace').removeAttribute('data-account');
		dom.window.fetch = (path, options) => fetch(Fixture.origin + path, { ...options, headers: { ...options.headers, Cookie: browser.cookie }, redirect: 'manual' }); dom.window.eval((await BrowserSource.script()).replace('export { client };', 'window.testClient = client;'));
		const client = dom.window.testClient; client.account = browser.account; client.toast = () => {}; client.confirm = async () => true; client.poll = client.loadTrash = () => assert.fail('No page or section reload');
		await client.oauth(); assert.equal(document.querySelector('#oauth-issuer').textContent, Auth.origin); assert.match(document.querySelector('#oauth-mcp-endpoint').textContent, /\/mcp$/);
		const form = document.querySelector('#oauth-client-form'); form.elements.client_name.value = 'Dashboard client'; form.elements.client_uri.value = 'https://example.test/'; form.elements.redirect_uris.value = 'https://example.test/callback'; form.elements.token_endpoint_auth_method.value = 'client_secret_post';
		await client.onSubmit({ target: form, preventDefault() {}, submitter: form.querySelector('button[type=submit]') });
		const clientRow = document.querySelector('[data-oauth-client]'); const secret = document.querySelector('#oauth-client-secret [data-secret-value]').value; assert.ok(clientRow); assert.ok(secret); assert.ok(!JSON.stringify(await browser.json('/api/v2/oauth/clients', 'GET', null)).includes(secret));
		const storedClient = await OAuthClient.findById(clientRow.dataset.oauthClient).lean();
		const grant = await Integration.create({ account: browser.account, user: user._id, name: storedClient.name, kind: 'oauth', client: storedClient.client_id, resource: Auth.apiResource(), scopes: ['content:read'], expires: new Date(Date.now() + 86400000) }); const delegated = await IntegrationToken.create({ grant: grant._id, hash: Support.hash(Support.token()), resource: Auth.apiResource(), expires: new Date(Date.now() + 60000) });
		await client.oauth(); const consent = document.querySelector('[data-oauth-consent="' + grant._id + '"]'); assert.ok(consent); await client.onClick({ target: consent.querySelector('[data-revoke-consent]') }); assert.equal(document.querySelector('[data-oauth-consent="' + grant._id + '"]'), null); assert.equal((await Integration.findById(grant._id).lean()).revoked, true); assert.equal(await IntegrationToken.exists({ _id: delegated._id }), null);
		const second = await Integration.create({ account: browser.account, user: user._id, name: storedClient.name, kind: 'oauth', client: storedClient.client_id, resource: Auth.apiResource(), scopes: ['content:read'], expires: new Date(Date.now() + 86400000) }); await client.onClick({ target: clientRow.querySelector('[data-delete-oauth-client]') }); assert.equal(document.querySelector('[data-oauth-client]'), null); assert.equal(await OAuthClient.exists({ _id: storedClient._id }), null); assert.equal((await Integration.findById(second._id).lean()).revoked, true); assert.equal(document.querySelector('#settings-pane-tokens'), pane);
	} finally { dom.window.close(); }
});
test('device rows expose metadata and browser-local times; legacy devices stay unknown', async () => {
	const { browser, user } = await Fixture.account();
	const known = await Device.create({ account: browser.account, user: user._id, name: 'My computer', client_type: 'desktop', os: 'macos', last_active: new Date('2026-09-01T12:00:00Z') });
	const legacy = await Device.create({ account: browser.account, user: user._id, name: 'Legacy desktop' });
	const rows = await browser.json('/api/v2/devices', 'GET', null);
	assert.equal(rows.find(row => row._id === String(known._id)).os, 'macos');
	const dom = new JSDOM(await (await browser.call('/')).text(), { url: Fixture.origin, runScripts: 'outside-only' });
	try {
		dom.window.document.querySelector('#workspace').removeAttribute('data-account');
		dom.window.eval((await BrowserSource.script()).replace('export { client };', 'window.testClient = client;'));
		const client = dom.window.testClient; const pane = dom.window.document.querySelector('#settings-pane-devices');
		client.request = async (path, method = 'GET') => path.startsWith('fragments/') ? (await browser.call('/api/v2/' + path)).text() : browser.json('/api/v2/' + path, method, null);
		await client.devices();
		const row = dom.window.document.querySelector('[data-device="' + known._id + '"]');
		assert.match(row.textContent, /Client: Desktop · OS: macOS/);
		for (const time of row.querySelectorAll('time')) assert.equal(time.textContent, new dom.window.Date(time.dateTime).toLocaleString());
		assert.match(dom.window.document.querySelector('[data-device="' + legacy._id + '"]').textContent, /Client: Unknown · OS: Unknown/);
		client.confirm = async () => true;
		await client.onClick({ target: row.querySelector('button') });
		assert.equal(dom.window.document.querySelector('[data-device="' + known._id + '"]'), null);
		assert.equal(dom.window.document.querySelector('#settings-pane-devices'), pane);
		assert.equal((await browser.call('/api/v2/fragments/device/' + known._id)).status, 404);
	} finally { dom.window.close(); }
});
