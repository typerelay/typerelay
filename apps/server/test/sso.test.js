import { TestDatabase } from './database.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import selfsigned from 'selfsigned';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { JSDOM } from 'jsdom';
import { generateSecret, generateSync } from 'otplib';
import { Account, Member, User, Ticket, SsoLog, Device, mongoose } from '../model/index.js';
import { Security } from '../services/security.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Billing } from '../services/billing.js';

class Browser {
	static nextIp = 0;
	ip = '10.0.0.' + (++Browser.nextIp);
	cookie = ''; csrf = ''; account = '';
	async call(path, method = 'GET', body, form = false) {
		const response = await fetch(new URL(path, Fixture.origin), { method, redirect: 'manual', headers: { Cookie: this.cookie, 'X-Forwarded-For': this.ip, 'X-CSRF-Token': this.csrf, 'X-Account-Id': this.account, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: body ? form ? new URLSearchParams(body).toString() : JSON.stringify(body) : undefined });
		const cookie = response.headers.getSetCookie().find(value => value.startsWith('typerelay.sid='));
		if (cookie) this.cookie = cookie.split(';')[0];
		return response;
	}
	async page(path = '/login') {
		const response = await this.call(path);
		const html = await response.text();
		const dom = new JSDOM(html);
		this.csrf = dom.window.document.querySelector('meta[name="csrf-token"]')?.content || this.csrf;
		dom.window.close();
		return { response, html };
	}
	async json(path, method = 'POST', body = {}, status = 200) {
		const response = await this.call(path, method, body);
		const data = await response.json();
		assert.equal(response.status, status, JSON.stringify(data));
		if (data.csrf) this.csrf = data.csrf;
		return data;
	}
	async login(user) { await this.page(); await this.json('/auth/password', 'POST', { email: user.email, password: Fixture.password }); return this; }
}
class Fixture {
	static origin = 'http://127.0.0.1:3157'; static issuer = 'https://idp.example.test'; static password = 'Test-only password 7357'; static server; static certificate; static privateKey;
	static async account(plan = 'team') {
		const user = await User.create({ name: 'SSO Owner', email: randomUUID() + '@example.test', password: (await Security.password(Fixture.password)).hash });
		const account = await Account.create({ name: 'SSO test account', plan, billing: { status: 'active', seat_quantity: 5 } });
		await Member.create({ account: account._id, user: user._id, role: 'owner' });
		const browser = await new Browser().login(user);
		browser.account = String(account._id);
		return { account, user, browser };
	}
	static config(revision = 0, overrides = {}) { return { revision, issuer: Fixture.issuer, login_url: Fixture.issuer + '/sso', certificate: Fixture.certificate, enabled: true, enforce: false, provision: false, ...overrides }; }
	static async configure(fixture) { await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config()); }
	static async begin(browser, account, query = '') {
		await browser.page();
		const response = await browser.call(`/auth/sso/${account._id}/login${query}`);
		assert.equal(response.status, 302, await response.clone().text());
		const url = new URL(response.headers.get('location'));
		const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString();
		return { id: request.match(/ID="([^"]+)"/)[1], state: url.searchParams.get('RelayState'), account };
	}
	static sign(xml, element) {
		const sig = new SignedXml({ privateKey: Fixture.privateKey, publicCert: Fixture.certificate, canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#', signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
		sig.addReference({ xpath: `//*[local-name()='${element}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
		sig.computeSignature(xml, { location: { reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`, action: 'after' } });
		return sig.getSignedXml();
	}
	static response(request, email, overrides = {}) {
		const urls = Security.ssoUrls(request.account);
		const now = new Date().toISOString();
		const expires = overrides.expires || new Date(Date.now() + 240000).toISOString();
		const start = new Date(Date.now() - 1000).toISOString();
		const issuer = overrides.issuer || Fixture.issuer;
		const id = overrides.request || request.id;
		let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}" InResponseTo="${id}" Destination="${overrides.destination || urls.callback}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${id}" Recipient="${overrides.recipient || urls.callback}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${start}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${overrides.audience || urls.metadata}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
		if (overrides.failure) xml = xml.replace('status:Success', 'status:Responder');
		if (!overrides.unsigned) xml = Fixture.sign(overrides.responseOnly ? xml : Fixture.sign(xml, 'Assertion'), 'Response');
		if (overrides.tamper) xml = xml.replace(email, 'attacker@example.test');
		return { SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: request.state };
	}
	static async callback(request, email, overrides = {}) { return new Browser().call(`/auth/sso/${request.account._id}/callback`, 'POST', Fixture.response(request, email, overrides), true); }
	static async complete(browser, account, email, query = '') {
		const request = await Fixture.begin(browser, account, query);
		const callback = await Fixture.callback(request, email);
		assert.equal(callback.status, 303, await callback.clone().text());
		const finish = await browser.call(callback.headers.get('location'));
		browser.account = String(account._id);
		await browser.page('/login');
		return { request, callback, finish };
	}
}
before(async () => {
	const uri = TestDatabase.uri(process.env.MONGO_URI, 'typerelay_sso_test');
	Object.assign(process.env, { NODE_ENV: 'test', IS_DOCKER: 'true', MONGO_URI: uri, PORT: '3157', SESSION_SECRET: Support.token(), TYPERELAY_HOSTED_EDITION: 'true', BILLING_ENABLED: 'true', WHITE_LABEL_ENABLED: 'false', ENABLE_SIGNUP: 'false', API_RATE_LIMIT_ENABLED: 'false' });
	Auth.origin = Fixture.origin;
	const pems = await selfsigned.generate([{ name: 'commonName', value: 'saml-fixture' }], { keySize: 2048, algorithm: 'sha256', notBeforeDate: new Date(Date.now() - 60000), notAfterDate: new Date(Date.now() + 86400000) });
	Fixture.certificate = pems.cert; Fixture.privateKey = pems.private;
	const { Server } = await import('../app.js');
	Fixture.server = await Server.start();
});
after(async () => { if (Fixture.server) await new Promise(resolve => Fixture.server.close(resolve)); await TestDatabase.drop(mongoose.connection, 'typerelay_sso_test'); await mongoose.disconnect(); });

test('Pro and Team allow configuration while Free is gated', async () => {
	for (const plan of ['free', 'pro', 'team']) {
		const fixture = await Fixture.account(plan);
		const settings = await fixture.browser.json('/api/v2/sso', 'GET', null);
		assert.match(settings.html, plan === 'free' ? /SSO requires Pro or Team/ : /Identity provider/);
		await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(), plan === 'free' ? 403 : 200);
		if (plan !== 'free') {
			const metadata = await new Browser().call(`/auth/sso/${fixture.account._id}/metadata`);
			assert.equal(metadata.status, 200); assert.match(await metadata.text(), /AssertionConsumerService/);
		}
	}
});
test('signed login restores the initiating browser, consumes state and binds the session to its account', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const other = await Account.create({ name: 'Other account', plan: 'team', billing: { status: 'active' } });
	await Member.create({ account: other._id, user: fixture.user._id, role: 'owner' });
	const browser = new Browser(); const request = await Fixture.begin(browser, fixture.account);
	const callback = await Fixture.callback(request, fixture.user.email); assert.equal(callback.status, 303);
	const stolen = await new Browser().call(callback.headers.get('location')); assert.equal(stolen.status, 401);
	const finish = await browser.call(callback.headers.get('location')); assert.equal(finish.status, 302);
	assert.match(finish.headers.get('location'), new RegExp(String(fixture.account._id)));
	assert.equal((await browser.call(callback.headers.get('location'))).status, 401);
	assert.equal((await Fixture.callback(request, fixture.user.email)).status, 401);
	browser.account = String(fixture.account._id); await browser.page();
	await browser.json('/api/v2/security', 'GET', null);
	await browser.json('/api/v2/security/password', 'POST', {}, 403);
	await browser.json('/api/v2/profile', 'PATCH', { name: 'Stolen' }, 403);
	await browser.json('/auth/email', 'POST', { token: 'unused' }, 403);
	const invite = Support.token(); await Ticket.create({ hash: Support.hash(invite), kind: 'invite', email: fixture.user.email, account: other._id, expires: new Date(Date.now() + 60000) });
	await browser.json('/api/v2/team/accept', 'POST', { token: invite, operation_id: Support.token() }, 403);
	assert.ok(await Ticket.exists({ hash: Support.hash(invite) }));
	browser.account = String(other._id); await browser.json('/api/v2/security', 'GET', null, 403);
	assert.equal((await browser.call(`/snippet-assets/${other._id}/anything`)).status, 403);
});
test('invalid signatures, issuers, audiences, destinations, recipients, time windows and request IDs fail', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	for (const overrides of [{ unsigned: true }, { tamper: true }, { failure: true }, { issuer: 'https://evil.test' }, { audience: 'https://evil.test' }, { destination: 'https://evil.test' }, { recipient: 'https://evil.test' }, { expires: new Date(Date.now() - 120000).toISOString() }, { request: '_unrequested' }]) {
		const request = await Fixture.begin(new Browser(), fixture.account);
		assert.equal((await Fixture.callback(request, fixture.user.email, overrides)).status, 401, JSON.stringify(overrides));
	}
	const request = await Fixture.begin(new Browser(), fixture.account);
	const body = Fixture.response(request, fixture.user.email);
	body.RelayState = Support.token();
	assert.equal((await new Browser().call(`/auth/sso/${fixture.account._id}/callback`, 'POST', body, true)).status, 401);
});
test('a complete signed response covers an unsigned assertion', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const browser = new Browser(); const request = await Fixture.begin(browser, fixture.account);
	const response = await Fixture.callback(request, fixture.user.email, { responseOnly: true });
	assert.equal(response.status, 303); assert.equal((await browser.call(response.headers.get('location'))).status, 302);
});
test('concurrent deliveries accept only one signed response', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const request = await Fixture.begin(new Browser(), fixture.account);
	const body = Fixture.response(request, fixture.user.email);
	const results = await Promise.all([new Browser(), new Browser()].map(browser => browser.call(`/auth/sso/${fixture.account._id}/callback`, 'POST', body, true)));
	assert.deepEqual(results.map(response => response.status).sort(), [303, 401]);
});
test('test login is bound to the admin identity and enables enforcement with owner recovery', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(1, { enforce: true }), 400);
	const tested = await Fixture.complete(fixture.browser, fixture.account, fixture.user.email, '?test=true'); assert.equal(tested.finish.status, 200);
	const recovery = await fixture.browser.json('/api/v2/sso/recovery-code');
	const dom = new JSDOM(recovery.secret_html); const code = dom.window.document.querySelector('input').value; dom.window.close();
	await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(1, { enforce: true }));
	await fixture.browser.json('/api/v2/security', 'GET', null, 403);
	const sso = new Browser(); assert.equal((await Fixture.complete(sso, fixture.account, fixture.user.email)).finish.status, 302);
	await sso.json('/api/v2/security', 'GET', null);
	await fixture.browser.json(`/auth/sso/${fixture.account._id}/recovery`, 'POST', { code });
	await fixture.browser.json(`/auth/sso/${fixture.account._id}/recovery`, 'POST', { code }, 401);
	await fixture.browser.json('/api/v2/security', 'GET', null);
	await sso.json('/api/v2/security', 'GET', null, 401);
	assert.equal((await Account.findById(fixture.account._id).lean()).sso.enforce, false);
});
test('a settings save preserves a recovery code rotated after its initial read', async t => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const req = { session: { user: String(fixture.user._id) }, ctx: await Support.context(String(fixture.user._id), String(fixture.account._id)), body: Fixture.config(1) };
	await Security.ssoRecoveryCode(req);
	const original = Security.ssoAdmin; let rotated; let first = true;
	t.mock.method(Security, 'ssoAdmin', async (...args) => {
		const account = await original(...args);
		if (first) { first = false; rotated = await Security.ssoRecoveryCode(req); }
		return account;
	});
	await Security.saveSso(req);
	const dom = new JSDOM(rotated.secret_html); const code = dom.window.document.querySelector('input').value; dom.window.close();
	const account = await Account.findById(fixture.account._id).select('+sso.recovery_hash').lean();
	assert.equal(account.sso.recovery_hash, Support.hash(code));
	assert.equal(account.sso.revision, 2);
});
test('provisioning is opt-in, creates members only and respects available seats', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const denied = await Fixture.complete(new Browser(), fixture.account, 'new-' + randomUUID() + '@example.test'); assert.equal(denied.finish.status, 403);
	await Fixture.complete(fixture.browser, fixture.account, fixture.user.email, '?test=true');
	await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(1, { provision: true }));
	const email = 'new-' + randomUUID() + '@example.test'; const browser = new Browser();
	assert.equal((await Fixture.complete(browser, fixture.account, email)).finish.status, 302);
	const user = await User.findOne({ email }).lean(); const member = await Member.findOne({ user: user._id, account: fixture.account._id }).lean(); assert.equal(member.role, 'member');
	assert.equal(await Member.countDocuments({ user: user._id }), 1);
	await browser.json('/api/v2/sso', 'GET', null, 403);
	await Account.updateOne({ _id: fixture.account._id }, { $set: { 'admin_override.limits.people': 2 } });
	assert.equal((await Fixture.complete(new Browser(), fixture.account, 'full-' + randomUUID() + '@example.test')).finish.status, 409);
});
test('provisioning never claims an existing TypeRelay user without an accepted invitation', async t => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	await Fixture.complete(fixture.browser, fixture.account, fixture.user.email, '?test=true');
	await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(1, { provision: true }));
	const existing = await User.create({ name: 'Existing elsewhere', email: 'existing-' + randomUUID() + '@example.test' });
	assert.equal((await Fixture.complete(new Browser(), fixture.account, existing.email)).finish.status, 403);
	assert.equal(await Member.exists({ account: fixture.account._id, user: existing._id }), null);
	assert.ok(await SsoLog.exists({ account: fixture.account._id, event: 'invite_required' }));
	const log = t.mock.method(Security, 'ssoLog', async () => { throw new Error('Synthetic log failure'); });
	try { assert.equal((await Fixture.complete(new Browser(), fixture.account, existing.email)).finish.status, 403); } finally { log.mock.restore(); }
	// The IdP administrator can also send invitations, so a pending invite alone must not let the IdP claim the user.
	await Ticket.create({ hash: Support.hash(randomUUID()), kind: 'invite', email: existing.email, account: fixture.account._id, expires: new Date(Date.now() + 86400000) });
	const pending = (await Fixture.complete(new Browser(), fixture.account, existing.email)).finish;
	assert.equal(pending.status, 403);
	assert.match(await pending.text(), /Accept the team invitation from your email first/);
	assert.equal(await Member.exists({ account: fixture.account._id, user: existing._id }), null);
	assert.ok(await Ticket.exists({ account: fixture.account._id, kind: 'invite', email: existing.email }));
	// Accepting the invitation through the team flow creates the membership; SSO then signs the user in.
	await Member.create({ account: fixture.account._id, user: existing._id, role: 'member' });
	assert.equal((await Fixture.complete(new Browser(), fixture.account, existing.email)).finish.status, 302);
	assert.equal(await Member.countDocuments({ account: fixture.account._id, user: existing._id }), 1);
});
test('SSO retains local two-factor authentication and account binding through the second factor', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const secret = generateSecret(); await User.updateOne({ _id: fixture.user._id }, { $set: { totp_enabled: true, totp_secret: secret } });
	const browser = new Browser(); const result = await Fixture.complete(browser, fixture.account, fixture.user.email);
	assert.equal(result.finish.headers.get('location'), '/auth/two-factor');
	await browser.json('/auth/two-factor', 'POST', { code: generateSync({ secret }) });
	await browser.json('/api/v2/security', 'GET', null);
	await browser.json('/api/v2/security/password', 'POST', {}, 403);
});
test('native OAuth retains state and issues SSO-bound device credentials; changing settings invalidates them', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const verifier = Support.token(); const state = Support.token();
	const body = { client_id: 'typerelay-desktop', redirect_uri: 'http://127.0.0.1:12345/callback', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, account: String(fixture.account._id) };
	const browser = new Browser(); await browser.page('/oauth/authorize?' + new URLSearchParams(body));
	const result = await Fixture.complete(browser, fixture.account, fixture.user.email);
	assert.match(result.finish.headers.get('location'), /^\/oauth\/authorize\?/);
	const approval = await browser.call('/oauth/authorize', 'POST', body); assert.equal(approval.status, 302);
	const redirect = new URL(approval.headers.get('location')); assert.equal(redirect.searchParams.get('state'), state);
	const tokens = await new Browser().json('/oauth/token', 'POST', { client_id: body.client_id, redirect_uri: body.redirect_uri, code_verifier: verifier, code: redirect.searchParams.get('code'), grant_type: 'authorization_code' });
	assert.equal((await Device.findById(tokens.device).lean()).sso_revision, 1);
	assert.equal((await Auth.bearer(tokens.access_token)).account, String(fixture.account._id));
	const profile = await fetch(Fixture.origin + '/api/v2/profile', { method: 'PATCH', headers: { Authorization: 'Bearer ' + tokens.access_token, 'X-TypeRelay-Sync-Protocol': '6', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Changed by SSO device' }) }); assert.equal(profile.status, 403);
	const settings = await fetch(Fixture.origin + '/api/v2/sso', { headers: { Authorization: 'Bearer ' + tokens.access_token, 'X-TypeRelay-Sync-Protocol': '6' } }); assert.equal(settings.status, 403);
	await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(1));
	await assert.rejects(Auth.bearer(tokens.access_token), /SSO configuration changed/);
});
test('enforcement blocks ordinary API tokens and SSO tokens inherit settings revocation', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const local = await Auth.createIntegration(await Support.context(String(fixture.user._id), String(fixture.account._id)), { name: 'Local token' });
	await Fixture.complete(fixture.browser, fixture.account, fixture.user.email, '?test=true');
	await fixture.browser.json('/api/v2/sso/recovery-code');
	await fixture.browser.json('/api/v2/sso', 'PUT', Fixture.config(1, { enforce: true }));
	await assert.rejects(Auth.integration('Bearer ' + local.token), /Sign in with SSO/);
	const browser = new Browser(); await Fixture.complete(browser, fixture.account, fixture.user.email);
	const created = await browser.json('/api/v2/access-tokens', 'POST', { name: 'SSO token' });
	const dom = new JSDOM(created.secret_html); const token = dom.window.document.querySelector('input').value; dom.window.close();
	assert.equal((await Auth.integration('Bearer ' + token)).grant.sso_revision, 2);
	await browser.json('/api/v2/sso', 'PUT', Fixture.config(2, { enforce: true }));
	await assert.rejects(Auth.integration('Bearer ' + token), /SSO configuration changed/);
});
test('an active Team custom hostname supplies metadata and preserves OAuth continuation on redirects', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	process.env.WHITE_LABEL_ENABLED = 'true';
	try {
		await Account.updateOne({ _id: fixture.account._id }, { $set: { 'white_label.state': 'active', 'white_label.hostname': 'sso.example.test' } });
		const account = await Account.findById(fixture.account._id).lean();
		assert.equal(Security.ssoUrls(account).origin, 'https://sso.example.test');
		const continuation = '/oauth/authorize?state=retained';
		const response = await new Browser().call(`/auth/sso/${account._id}/login?return_to=${encodeURIComponent(continuation)}`);
		const target = new URL(response.headers.get('location')); assert.equal(target.hostname, 'sso.example.test'); assert.equal(target.searchParams.get('return_to'), continuation);
		const metadata = await new Browser().call(`/auth/sso/${account._id}/metadata`); assert.match(await metadata.text(), /https:\/\/sso.example.test\/auth\/sso\//);
	} finally { process.env.WHITE_LABEL_ENABLED = 'false'; }
});
test('plan downgrade blocks pending callbacks and existing SSO sessions without locking out the owner', async () => {
	const fixture = await Fixture.account(); await Fixture.configure(fixture);
	const browser = new Browser(); await Fixture.complete(browser, fixture.account, fixture.user.email);
	const pending = await Fixture.begin(new Browser(), fixture.account);
	await Account.updateOne({ _id: fixture.account._id }, { $set: { plan: 'free', 'billing.status': 'canceled', 'sso.enforce': true } });
	assert.equal((await Fixture.callback(pending, fixture.user.email)).status, 403);
	await browser.json('/api/v2/security', 'GET', null, 401);
	await fixture.browser.json('/api/v2/security', 'GET', null);
	const saved = await fixture.browser.json('/api/v2/sso', 'GET', null); assert.match(saved.html, /Saved configuration is retained/);
	assert.equal((await new Browser().call(`/auth/sso/${fixture.account._id}/metadata`)).status, 403);
});
test('logs contain outcomes without SAML assertions, certificates or recovery codes', async () => {
	const logs = await SsoLog.find().lean(); assert.ok(logs.some(log => log.event === 'login_failed'));
	const serialized = JSON.stringify(logs);
	assert.doesNotMatch(serialized, /SAMLResponse|Assertion>|BEGIN CERTIFICATE|recovery_hash|@example.test/);
});


test('white-label navigation and pane follow the feature flag independently of billing and preserve role access', async () => {
	const fixture = await Fixture.account();
	try {
		for (const billing of ['false', 'true']) for (const enabled of ['false', 'true']) for (const role of ['owner', 'admin', 'member']) {
			Object.assign(process.env, { BILLING_ENABLED: billing, WHITE_LABEL_ENABLED: enabled });
			await Member.updateOne({ account: fixture.account._id, user: fixture.user._id }, { $set: { role } });
			const { response, html } = await fixture.browser.page('/?account=' + fixture.account._id);
			assert.equal(response.status, 200);
			const dom = new JSDOM(html);
			try {
				const allowed = enabled === 'true' && role !== 'member';
				assert.equal(Boolean(dom.window.document.querySelector('#settings-tab-whiteLabel')), allowed, `${billing}/${enabled}/${role} navigation`);
				assert.equal(Boolean(dom.window.document.querySelector('#settings-pane-whiteLabel')), allowed, `${billing}/${enabled}/${role} pane`);
				assert.equal(Boolean(dom.window.document.querySelector('#settings-pane-subscription')), billing === 'true');
				assert.equal(Boolean(dom.window.document.querySelector('#settings-pane-sso')), role !== 'member');
			} finally { dom.window.close(); }
			if (role === 'member') await fixture.browser.json('/api/v2/white-label', 'GET', null, 403);
		}
	} finally { Object.assign(process.env, { BILLING_ENABLED: 'true', WHITE_LABEL_ENABLED: 'false' }); }
});
