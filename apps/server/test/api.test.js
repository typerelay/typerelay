import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import { mongoose, Account, User, Member, Integration, ApiAudit, OAuthClient } from '../model/index.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Libraries } from '../services/libraries.js';
import { PublicApi } from '../api/public.js';
import { AdminAccounts } from '../services/admin_accounts.js';
import { operations } from '../api/catalog.js';
import spec, { ApiSchema } from '../api/openapi.js';

class ApiFixture {
	static server; static base; static owner; static outsider; static token; static reader; static library;
	static async request(path, method = 'GET', body, token = ApiFixture.token) {
		const response = await fetch(ApiFixture.base + '/api/v3' + path, { method, headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
		return { status: response.status, value: await response.json() };
	}
	static async user(account, role = 'owner') { const user = await User.create({ email: randomUUID() + '@example.test' }); await Member.create({ user: user._id, account, role }); return Support.context(String(user._id), String(account)); }
}
before(async () => {
	process.env.JWT_SECRET = Support.token();
	await mongoose.connect(process.env.MONGO_URI.replace('/typerelay?', '/typerelay_api_test?'));
	await mongoose.connection.dropDatabase(); await Promise.all(Object.values(mongoose.models).map(model => model.init()));
	const account = await Account.create({ name: 'API test' });
	ApiFixture.owner = await ApiFixture.user(account._id);
	ApiFixture.outsider = await ApiFixture.user((await Account.create({ name: 'Other' }))._id);
	ApiFixture.token = (await Auth.createIntegration(ApiFixture.owner, { name: 'Tests', scopes: Auth.scopes })).token;
	ApiFixture.reader = (await Auth.createIntegration(ApiFixture.owner, { name: 'Read only', scopes: ['content:read'] })).token;
	const app = express(); app.use(express.json()); await PublicApi.mount(app, (req, res, next) => next());
	app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	ApiFixture.server = app.listen(0, '127.0.0.1'); await new Promise(resolve => ApiFixture.server.once('listening', resolve)); ApiFixture.base = 'http://127.0.0.1:' + ApiFixture.server.address().port;
});
after(async () => { await new Promise(resolve => ApiFixture.server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('public authentication is separate from desktop and scope-limited; no token hashes returned', async () => {
	assert.equal((await ApiFixture.request('/me')).status, 200);
	assert.equal((await ApiFixture.request('/me', 'GET', null, 'bad')).status, 401);
	assert.equal((await ApiFixture.request('/libraries', 'POST', { operation_id: randomUUID(), name: 'No' }, ApiFixture.reader)).status, 403);
	const grant = await Integration.findOne({ name: 'Tests' }).lean(); assert.equal(grant.hash, undefined);
});
test('unlimited personal tokens support reads and writes, counts, validation and revocation', async () => {
	const before = (await AdminAccounts.counts([new mongoose.Types.ObjectId(ApiFixture.owner.account)])).get(ApiFixture.owner.account).integrations;
	const { token, grant } = await Auth.createIntegration(ApiFixture.owner, { name: 'Unlimited', days: 0, scopes: Auth.scopes });
	assert.equal(grant.expires, null);
	assert.equal((await ApiFixture.request('/me', 'GET', null, token)).status, 200);
	assert.equal((await ApiFixture.request('/libraries', 'POST', { operation_id: randomUUID(), name: 'Unlimited token write' }, token)).status, 200);
	assert.equal((await AdminAccounts.counts([new mongoose.Types.ObjectId(ApiFixture.owner.account)])).get(ApiFixture.owner.account).integrations, before + 1);
	for (const days of [-1, 366, 1.5, null, '', false, '0']) await assert.rejects(Auth.createIntegration(ApiFixture.owner, { name: 'Invalid', days, scopes: ['content:read'] }), /Expiry/);
	const finite = await Auth.createIntegration(ApiFixture.owner, { name: 'Finite', days: 365, scopes: ['content:read'] });
	assert.ok(finite.grant.expires > new Date(Date.now() + 364 * 86400000));
	const standard = await Auth.createIntegration(ApiFixture.owner, { name: 'Default', scopes: ['content:read'] });
	assert.ok(Math.abs(+standard.grant.expires - Date.now() - 90 * 86400000) < 5000);
	await Integration.updateOne({ _id: finite.grant._id }, { $set: { expires: new Date(Date.now() - 1000) } });
	assert.equal((await ApiFixture.request('/me', 'GET', null, finite.token)).status, 401);
	await Integration.updateOne({ _id: grant._id }, { $set: { revoked: true } });
	assert.equal((await ApiFixture.request('/me', 'GET', null, token)).status, 401);
	await Integration.updateOne({ _id: standard.grant._id }, { $unset: { expires: 1 } });
	assert.equal((await ApiFixture.request('/me', 'GET', null, standard.token)).status, 401, 'Only explicit null is unlimited');
});
test('private CRUD, metadata, retries and search use the shared sync data', async () => {
	const body = { operation_id: randomUUID(), name: 'Code', snippets: [{ id: randomUUID(), title: 'Tabs', trigger: null, content: { version: 1, type: 'code', language: 'rust', text: '\t  fn main() {}\n\n' } }] };
	const created = await ApiFixture.request('/libraries', 'POST', body); assert.equal(created.status, 200);
	ApiFixture.library = created.value.library;
	assert.equal(created.value.library.records, undefined); assert.equal(created.value.library.snippets, undefined);
	assert.equal((await ApiFixture.request('/libraries', 'POST', body)).value.library.id, created.value.library.id);
	assert.equal((await ApiFixture.request('/libraries', 'POST', { ...body, name: 'Different' })).status, 409);
	const rows = (await ApiFixture.request('/libraries/' + ApiFixture.library.id + '/snippets')).value.items;
	assert.equal(rows[0].content.text, body.snippets[0].content.text);
	assert.equal(rows[0].trigger, null);
	assert.equal((await ApiFixture.request('/search?q=main')).value.items.length, 1);
	const sync = await Libraries.download(ApiFixture.owner, 0); assert.ok(sync.libraries.some(library => library._id === ApiFixture.library.id));
	const outsider = (await Auth.createIntegration(ApiFixture.outsider, { name: 'Other', scopes: Auth.scopes })).token;
	assert.equal((await ApiFixture.request('/libraries/' + ApiFixture.library.id, 'GET', null, outsider)).status, 404);
	assert.equal((await ApiFixture.request('/libraries', 'GET', null, outsider)).value.items.length, 0);
});
test('pagination, atomic stale moves, Trash and restore preserve IDs', async () => {
	const library = ApiFixture.library;
	const rows = (await ApiFixture.request('/libraries/' + library.id + '/snippets')).value.items;
	const other = (await ApiFixture.request('/libraries', 'POST', { operation_id: randomUUID(), name: 'Destination' })).value.library;
	const batch = { operation_id: randomUUID(), action: 'move', source_library: library.id, destination_library: other.id, items: [{ id: rows[0].id, base_revision: 999 }] };
	assert.equal((await ApiFixture.request('/snippets/batch', 'POST', batch)).status, 409);
	batch.items[0].base_revision = rows[0].revision;
	assert.equal((await ApiFixture.request('/snippets/batch', 'POST', batch)).status, 200);
	assert.equal((await ApiFixture.request('/libraries/' + library.id + '/snippets')).value.items.length, 0);
	const moved = (await ApiFixture.request('/libraries/' + other.id + '/snippets')).value.items[0];
	const trashed = await ApiFixture.request('/trash/action', 'POST', { operation_id: randomUUID(), action: 'trash', target: { type: 'snippet', id: moved.id, library: other.id, revision: moved.revision } }); assert.equal(trashed.status, 200);
	const trash = (await ApiFixture.request('/trash')).value.items[0];
	assert.equal((await ApiFixture.request('/trash/action', 'POST', { operation_id: randomUUID(), action: 'restore', target: trash })).status, 200);
	assert.equal((await ApiFixture.request('/trash/purge', 'POST', { operation_id: randomUUID(), target: trash })).status, 409);
	const page = (await ApiFixture.request('/libraries?limit=1')).value; assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
	assert.equal((await ApiFixture.request('/libraries?limit=1&cursor=' + page.next_cursor)).value.items.length, 1);
});
test('OAuth registration, account/resource binding, PKCE and refresh replay revocation', async () => {
	const client = await Auth.registerIntegration({ client_name: 'Test MCP', redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'none' });
	const verifier = Support.token();
	const request = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', state: Support.token(), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: Auth.apiResource(), scope: 'content:read', account: ApiFixture.owner.account };
	const redirect = new URL(await Auth.approveIntegration(ApiFixture.owner.user, request));
	const exchange = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: request.redirect_uri, resource: request.resource };
	await assert.rejects(Auth.exchangeIntegration({ ...exchange, resource: Auth.mcpResource() }), /Invalid/);
	const token = await Auth.exchangeIntegration(exchange);
	await assert.rejects(Auth.exchangeIntegration(exchange), /Invalid/);
	const ctx = await Auth.integration('Bearer ' + token.access_token); assert.equal(ctx.account, ApiFixture.owner.account);
	await assert.rejects(Auth.integration('Bearer ' + token.access_token, Auth.mcpResource()), /invalid/);
	const refreshed = await Auth.exchangeIntegration({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id, resource: request.resource });
	assert.ok(refreshed.access_token);
	await assert.rejects(Auth.exchangeIntegration({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id, resource: request.resource }), /replay/);
	await assert.rejects(Auth.integration('Bearer ' + refreshed.access_token), /revoked/);
});
test('revocation and member removal invalidate integrations', async () => {
	const { token, grant } = await Auth.createIntegration(ApiFixture.outsider, { name: 'Revoke', scopes: ['content:read'] });
	await Integration.updateOne({ _id: grant._id }, { $set: { revoked: true } });
	await assert.rejects(Auth.integration('Token ' + token), /revoked/);
	const fresh = (await Auth.createIntegration(ApiFixture.outsider, { name: 'Removed', scopes: ['content:read'] })).token;
	await Member.deleteOne({ account: ApiFixture.outsider.account, user: ApiFixture.outsider.user });
	await assert.rejects(Auth.integration('Token ' + fresh), /denied/);
});
test('OpenAPI catalog covers every route and mutation has operation ID', () => {
	const docs = Object.values(spec.paths).flatMap(path => Object.values(path));
	const direct = ['upload_asset', 'asset_presence', 'download_asset', 'cache_remote_asset', 'refresh_remote_asset', 'export_library_bundle', 'import_library_bundle'];
	assert.deepEqual(docs.map(doc => doc.operationId).sort(), [...operations.map(operation => operation.id), ...direct].sort());
	for (const operation of operations.filter(operation => operation.mutation)) assert.ok(ApiSchema.body(operation).required.includes('operation_id'));
});

test('MCP delegation enforces its secret and audience and follows grant revocation', async () => {
	const client = await Auth.registerIntegration({ client_name: 'Delegate', redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'none' });
	const verifier = Support.token();
	const request = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', state: Support.token(), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: Auth.mcpResource(), scope: 'content:read', account: ApiFixture.owner.account };
	const approval = new URL(await Auth.approveIntegration(ApiFixture.owner.user, request));
	const access = await Auth.exchangeIntegration({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: request.redirect_uri, resource: request.resource, code_verifier: verifier, code: approval.searchParams.get('code') });
	await assert.rejects(Auth.integration('Bearer ' + access.access_token), /invalid/);
	const url = ApiFixture.base + '/integrations/delegate';
	assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + access.access_token, 'X-MCP-Secret': 'wrong' } })).status, 401);
	const delegated = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + access.access_token, 'X-MCP-Secret': process.env.JWT_SECRET } });
	assert.equal(delegated.status, 200);
	const bridge = await delegated.json(); const ctx = await Auth.integration('Bearer ' + bridge.access_token); assert.deepEqual(ctx.scopes, ['content:read']);
	assert.equal(bridge.expires_in, 60);
	await Integration.updateOne({ _id: ctx.credential }, { $set: { revoked: true } });
	await assert.rejects(Auth.integration('Bearer ' + bridge.access_token), /revoked/);
});
