import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import { mongoose, Account, User, Member, Integration, ApiAudit, OAuthClient, Migration } from '../model/index.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Libraries } from '../services/libraries.js';
import { PublicApi } from '../api/public.js';
import { AdminAccounts } from '../services/admin_accounts.js';
import { operations } from '../api/catalog.js';
import spec, { ApiSchema } from '../api/openapi.js';
import { StorageMigration } from '../services/storage_migration.js';

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
	ApiFixture.token = (await Auth.createIntegration(ApiFixture.owner, { name: 'Tests' })).token;
	ApiFixture.reader = 'tr_pat_' + Support.token(); await Integration.create({ account: ApiFixture.owner.account, user: ApiFixture.owner.user, name: 'Legacy read only', kind: 'pat', scopes: ['content:read'], hash: Support.hash(ApiFixture.reader), expires: null });
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
	const metadata = await (await fetch(ApiFixture.base + '/.well-known/oauth-authorization-server')).json(); assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none', 'client_secret_post']);
	assert.equal(Auth.oauthConfig().resource_metadata_url, new URL(Auth.mcpResource()).origin + '/.well-known/oauth-protected-resource/mcp');
});
test('public API advertises and accepts Raycast imports', async () => {
	const format = spec.paths['/imports/{format}/preview'].post.parameters.find(parameter => parameter.name === 'format');
	assert.ok(format.schema.enum.includes('raycast'));
	const source = [{ name: 'API Raycast', text: 'Hello from Raycast', keyword: ';raycast-api' }];
	const preview = await ApiFixture.request('/imports/raycast/preview', 'POST', { source });
	assert.equal(preview.status, 200);
	assert.equal(preview.value.entries[0].trigger, 'raycast-api');
	const imported = await ApiFixture.request('/imports/raycast', 'POST', { operation_id: randomUUID(), source, filename: 'API Raycast.json', selected: [{ key: '0:0' }] });
	assert.equal(imported.status, 200);
});

test('personal tokens are full access, non-expiring, hashed and revocable', async () => {
	const before = (await AdminAccounts.counts([new mongoose.Types.ObjectId(ApiFixture.owner.account)])).get(ApiFixture.owner.account).integrations;
	const { token, grant } = await Auth.createIntegration(ApiFixture.owner, { name: 'Mailtwine parity', days: 1, scopes: ['content:read'] });
	assert.equal(grant.expires, null);
	assert.deepEqual(grant.scopes, Auth.scopes);
	assert.equal((await ApiFixture.request('/me', 'GET', null, token)).status, 200);
	assert.equal((await ApiFixture.request('/libraries', 'POST', { operation_id: randomUUID(), name: 'Unlimited token write' }, token)).status, 200);
	assert.equal((await AdminAccounts.counts([new mongoose.Types.ObjectId(ApiFixture.owner.account)])).get(ApiFixture.owner.account).integrations, before + 1);
	assert.equal((await Integration.findById(grant._id).lean()).hash, undefined);
	await assert.rejects(Auth.createIntegration(ApiFixture.owner, { name: '' }), /Invalid text/);
	await Integration.updateOne({ _id: grant._id }, { $set: { revoked: true } });
	assert.equal((await ApiFixture.request('/me', 'GET', null, token)).status, 401);
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
test('confidential manual OAuth clients require their one-time secret and stay account-bound', async () => {
	const client = await Auth.createOAuthClient(ApiFixture.owner, { client_name: 'Confidential client', client_uri: 'https://example.test/', redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'client_secret_post' });
	assert.ok(client.client_secret); assert.equal((await OAuthClient.findById(client.id).lean()).secret_hash, undefined);
	const verifier = Support.token(); const request = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', state: Support.token(), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: Auth.apiResource(), scope: 'content:read', account: ApiFixture.owner.account };
	const redirect = new URL(await Auth.approveIntegration(ApiFixture.owner.user, request)); const exchange = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: request.redirect_uri, resource: request.resource };
	await assert.rejects(Auth.exchangeIntegration(exchange), /client secret/i); await assert.rejects(Auth.exchangeIntegration({ ...exchange, client_secret: 'wrong' }), /client secret/i);
	assert.ok((await Auth.exchangeIntegration({ ...exchange, client_secret: client.client_secret })).access_token);
	await assert.rejects(Auth.approveIntegration(ApiFixture.outsider.user, { ...request, account: ApiFixture.outsider.account }), /another account/);
	const member = await ApiFixture.user(ApiFixture.owner.account, 'member'); await assert.rejects(Auth.createOAuthClient(member, { client_name: 'Denied', redirect_uris: ['https://example.test/member'], token_endpoint_auth_method: 'none' }), /admin access/i);
});
test('personal-token migration is repeatable and normalizes legacy grants', async () => {
	const legacy = await Integration.create({ account: ApiFixture.owner.account, user: ApiFixture.owner.user, name: 'Legacy', kind: 'pat', scopes: ['content:read'], hash: Support.hash(Support.token()), expires: new Date(Date.now() + 86400000) });
	await Migration.deleteOne({ key: 'mailtwine-tokens-v1' }); await StorageMigration.tokens(); await StorageMigration.tokens();
	const migrated = await Integration.findById(legacy._id).lean(); assert.deepEqual(migrated.scopes, Auth.scopes); assert.equal(migrated.expires, null);
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
