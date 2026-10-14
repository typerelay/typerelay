import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { Auth } from '../services/auth.js';
import { Security } from '../services/security.js';
import { PublicApi } from '../api/public.js';
import { Support } from '../services/support.js';
import { Billing } from '../services/billing.js';
import { OAuthClient, Member, Account, Ticket, User } from '../model/index.js';

class StateFixture {
	static server; static base; static session; static tickets = [];
	static client = { client_id: 'synthetic-openai-client', name: 'Synthetic OpenAI', redirects: ['https://example.test/callback'] };
	static state = 'openai_platform_oauth_relay__' + Buffer.from(JSON.stringify({ nonce: 'synthetic-review-only', relay: 'opaque'.repeat(160) })).toString('base64');
	static request(state = StateFixture.state) { return { client_id: StateFixture.client.client_id, redirect_uri: StateFixture.client.redirects[0], response_type: 'code', state, code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), resource: Auth.mcpResource(), scope: 'content:read', account: 'account' }; }
	static async get(body) { return fetch(StateFixture.base + '/integrations/authorize?' + new URLSearchParams(body)); }
	static async post(body) { return fetch(StateFixture.base + '/integrations/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }); }
}
before(async () => {
	mock.method(OAuthClient, 'findOne', query => ({ lean: async () => query.client_id === StateFixture.client.client_id ? StateFixture.client : null }));
	mock.method(Member, 'find', () => ({ lean: async () => [{ account: 'account' }] }));
	mock.method(Account, 'find', () => ({ lean: async () => [{ _id: 'account', name: 'Synthetic account' }] }));
	mock.method(User, 'findById', () => ({ lean: async () => ({ _id: 'user' }) }));
	mock.method(User, 'updateOne', async () => ({ modifiedCount: 1 }));
	mock.method(Support, 'context', async () => ({ user: 'user', account: 'account' }));
	mock.method(Billing, 'entitlements', () => ({ capabilities: { api: true } }));
	mock.method(Billing, 'account', async () => ({ _id: 'account' }));
	mock.method(Billing, 'assertApi', () => {});
	mock.method(Billing, 'assertDeviceEnrollment', async () => {});
	mock.method(Ticket, 'create', async ticket => { StateFixture.tickets.push(ticket); return ticket; });
	const app = express(); app.set('view engine', 'pug'); app.set('views', fileURLToPath(new URL('../views', import.meta.url))); app.use(express.urlencoded({ extended: false, limit: '32kb' }));
	app.use((req, res, next) => { req.session = StateFixture.session; Object.assign(res.locals, { csrf: 'synthetic-csrf', assetVersion: 'test', authBackgroundUrl: '', passkeysAvailable: false, signupEnabled: false }); next(); });
	await PublicApi.mount(app, (req, res, next) => next());
	app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	StateFixture.server = app.listen(0, '127.0.0.1'); await new Promise(resolve => StateFixture.server.once('listening', resolve)); StateFixture.base = 'http://127.0.0.1:' + StateFixture.server.address().port;
});
after(async () => { await new Promise(resolve => StateFixture.server.close(resolve)); mock.restoreAll(); });
test('long opaque integration state survives login continuation, consent form and approval/denial callbacks', async () => {
	assert.ok(StateFixture.state.length > 1000 && StateFixture.state.length < 4096);
	StateFixture.session = { regenerate: callback => callback(), save: callback => callback() };
	const request = StateFixture.request();
	const login = await StateFixture.get(request); assert.equal(login.status, 200); assert.match(await login.text(), /password-login-form/);
	const continuation = StateFixture.session.return_to; assert.equal(new URL(continuation, StateFixture.base).searchParams.get('state'), request.state);
	const signedIn = await Security.establish({ session: StateFixture.session }, 'user'); assert.equal(signedIn.redirect, continuation);
	const consent = await StateFixture.get(request); assert.equal(consent.status, 200);
	const dom = new JSDOM(await consent.text());
	const form = Object.fromEntries([...dom.window.document.querySelectorAll('form input, form select')].map(input => [input.name, input.value]));
	assert.equal(form.state, request.state); assert.equal(form._csrf, 'synthetic-csrf'); dom.window.close();
	const approved = await StateFixture.post({ ...form, decision: 'approve' }); assert.equal(approved.status, 302);
	const callback = new URL(approved.headers.get('location')); assert.equal(callback.searchParams.get('state'), request.state); assert.ok(callback.searchParams.get('code'));
	assert.equal(StateFixture.tickets.at(-1).data.challenge, request.code_challenge); assert.equal(StateFixture.tickets.at(-1).data.resource, request.resource); assert.equal(StateFixture.tickets.at(-1).data.redirect, request.redirect_uri);
	const denied = await StateFixture.post({ ...form, decision: 'deny' }); assert.equal(denied.status, 302);
	const denial = new URL(denied.headers.get('location')); assert.equal(denial.searchParams.get('state'), request.state); assert.equal(denial.searchParams.get('error'), 'access_denied'); assert.equal(denial.searchParams.get('code'), null);
});
test('integration state bounds reject invalid types, duplicate parameters and oversized UTF-8 values', async () => {
	for (const state of [undefined, null, [], {}, '', 'a'.repeat(19), 'a'.repeat(4097), 'é'.repeat(2049)]) await assert.rejects(Auth.integrationRequest({ ...StateFixture.request(), state }), /Invalid state/);
	for (const state of ['a'.repeat(20), 'a'.repeat(4096), 'é'.repeat(2048)]) await Auth.integrationRequest(StateFixture.request(state));
	const params = new URLSearchParams(StateFixture.request()); params.append('state', StateFixture.state);
	assert.equal((await fetch(StateFixture.base + '/integrations/authorize?' + params)).status, 400);
	assert.equal((await StateFixture.get(StateFixture.request('a'.repeat(4097)))).status, 400);
	assert.equal((await StateFixture.post({ ...StateFixture.request('a'.repeat(4097)), decision: 'approve' })).status, 400);
});
test('long state does not bypass integration PKCE, redirect, resource or first-party state policy', async () => {
	for (const [fields, message] of [[{ code_challenge_method: 'plain' }, /S256 PKCE/], [{ code_challenge: 'short' }, /S256 PKCE/], [{ redirect_uri: 'https://unregistered.example/callback' }, /Unregistered client or redirect/], [{ resource: 'https://other.example/mcp' }, /Invalid resource/]]) await assert.rejects(Auth.integrationRequest({ ...StateFixture.request(), ...fields }), message);
	await assert.rejects(Auth.authorize('user', { ...StateFixture.request(), client_id: 'typerelay-desktop', redirect_uri: 'http://127.0.0.1:34000/callback' }), /Invalid state/);
});
