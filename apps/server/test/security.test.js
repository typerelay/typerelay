import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encoder } from 'cbor-x';
const cbor = new Encoder({ useRecords: false, useTag259ForMaps: false, tagUint8Array: false });
import { generateSync } from 'otplib';
import { JSDOM } from 'jsdom';
import { mongoose, User, Ticket, Member, Passkey } from '../model/index.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';

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
}
class Fixture {
	static origin = 'http://127.0.0.1:3150'; static server; static root; static mails = [];
	static async account() {
		const browser = new Browser();
		await browser.page();
		const email = randomUUID() + '@example.test';
		await browser.json('/auth/signup', 'POST', { name: 'Original Name', email });
		const mail = Fixture.mails.findLast(mail => mail.to === email);
		await browser.call(new URL(mail.text).pathname + new URL(mail.text).search);
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
	process.env.MONGODB_URI = process.env.MONGODB_URI.replace('/typerelay?', '/typerelay_security?');
	Fixture.root = await mkdtemp(join(tmpdir(), 'typerelay-security-'));
	process.env.SESSION_SECRET_FILE = join(Fixture.root, 'session');
	Auth.origin = Fixture.origin;
	Auth.mail.sendMail = async mail => { Fixture.mails.push(mail); return { accepted: [mail.to] }; };
	const { Server } = await import('../app.js');
	Fixture.server = await Server.start();
});
after(async () => {
	await new Promise(resolve => Fixture.server.close(resolve));
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
	await rm(Fixture.root, { recursive: true, force: true });
});
test('signup, generated password, password login, OAuth continuation and recovery', async () => {
	const { browser, email, user } = await Fixture.account();
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
	await login.json('/auth/forgot-password', 'POST', { email });
	const reset = new URL(Fixture.mails.findLast(mail => mail.subject.startsWith('Reset')).text);
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
	const confirm = new URL(Fixture.mails.findLast(mail => mail.to === replacement).text);
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
	dom.window.eval((await readFile('./public/app.js', 'utf8')).replace('new TypeRelay();', 'window.client = new TypeRelay();').replace('export { client };', ''));
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
