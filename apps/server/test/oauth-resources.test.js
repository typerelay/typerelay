import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { Auth } from '../services/auth.js';
import { PublicApi } from '../api/public.js';
import { Support } from '../services/support.js';
import { Billing } from '../services/billing.js';
import { mongoose, Integration, IntegrationToken, Ticket, OAuthClient, User } from '../model/index.js';

class ResourceFixture { static server; static url; static tokens = []; static grants = []; static ticket; static secret = process.env.JWT_SECRET; static verifier = 'v'.repeat(43); static pat = 'tr_pat_synthetic-resource-fixture'; static deleting = false; }
before(async () => {
	process.env.JWT_SECRET = 'synthetic-resource-secret';
	mock.method(Support, 'context', async () => ({ user: 'synthetic-user', account: 'synthetic-account' })); mock.method(Billing, 'assertApi', () => {});
	mock.method(User, 'exists', async query => { assert.deepEqual(query, { _id: 'synthetic-user', 'deletion.requested_at': null }); return ResourceFixture.deleting ? null : { _id: query._id }; });
	mock.method(Billing, 'account', async () => ({ _id: 'synthetic-account' }));
	mock.method(mongoose.connection, 'transaction', async callback => callback({}));
	mock.method(OAuthClient, 'findOne', () => { const result = { lean: async () => ({ client_id: 'synthetic-client', redirects: ['https://synthetic.test/callback'], token_endpoint_auth_method: 'none' }), select: () => result }; return result; });
	mock.method(Ticket, 'findOneAndDelete', () => ({ lean: async () => ResourceFixture.ticket })); mock.method(Ticket, 'findOne', () => ({ lean: async () => null })); mock.method(Ticket, 'create', async () => []);
	mock.method(IntegrationToken, 'create', async rows => { ResourceFixture.tokens.push(...(Array.isArray(rows) ? rows : [rows])); return rows; });
	mock.method(IntegrationToken, 'findOne', query => ({ lean: async () => ResourceFixture.tokens.find(row => row.hash === query.hash && row.resource === query.resource) }));
	mock.method(Integration, 'create', async rows => { const grant = { ...rows[0], _id: 'grant-' + ResourceFixture.grants.length }; ResourceFixture.grants.push(grant); return [grant]; });
	mock.method(Integration, 'updateOne', async (query, update) => { const grant = ResourceFixture.grants.find(row => row._id === query._id); if (grant) Object.assign(grant, update.$set); });
	mock.method(Integration, 'findOne', query => { const found = () => ResourceFixture.grants.find(row => query.kind === 'pat' ? row.kind === 'pat' && row.hash === query.hash : query._id ? row._id === query._id && !row.revoked : row.refresh === query.refresh && row.client === query.client && row.resource === query.resource && !row.revoked); const result = { lean: async () => found(), session: () => result }; return result; });
	ResourceFixture.grants.push({ _id: 'pat-grant', kind: 'pat', hash: Support.hash(ResourceFixture.pat), scopes: ['content:read'], user: 'synthetic-user', account: 'synthetic-account' });
	const app = express(); app.use(express.json()); await PublicApi.mount(app, (req, res, next) => next()); app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	ResourceFixture.server = app.listen(0, '127.0.0.1'); await new Promise(resolve => ResourceFixture.server.once('listening', resolve)); ResourceFixture.url = 'http://127.0.0.1:' + ResourceFixture.server.address().port;
});
after(async () => { await new Promise(resolve => ResourceFixture.server.close(resolve)); mock.restoreAll(); ResourceFixture.secret === undefined ? delete process.env.JWT_SECRET : process.env.JWT_SECRET = ResourceFixture.secret; });
test('OAuth code and refresh exchange bind both MCP audiences and REST exactly', async () => {
	for (const resource of [Auth.apiResource(), Auth.mcpResource(), Auth.mcpResource(true)]) {
		await Auth.integrationRequest({ client_id: 'synthetic-client', redirect_uri: 'https://synthetic.test/callback', state: 'synthetic-state-123456789', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(ResourceFixture.verifier).digest('base64url'), resource });
		ResourceFixture.ticket = { account: 'synthetic-account', data: { user: 'synthetic-user', name: 'Synthetic', client: 'synthetic-client', redirect: 'https://synthetic.test/callback', resource, scopes: ['content:read'], challenge: createHash('sha256').update(ResourceFixture.verifier).digest('base64url') } };
		const exchange = { grant_type: 'authorization_code', client_id: 'synthetic-client', redirect_uri: 'https://synthetic.test/callback', code: 'synthetic-code', code_verifier: ResourceFixture.verifier, resource };
		const other = resource === Auth.mcpResource(true) ? Auth.mcpResource() : Auth.mcpResource(true);
		await assert.rejects(Auth.exchangeIntegration({ ...exchange, resource: other }), /Invalid authorization code/);
		const token = await Auth.exchangeIntegration(exchange);
		assert.deepEqual((await Auth.integration('Bearer ' + token.access_token, resource)).scopes, ['content:read']);
		await assert.rejects(Auth.integration('Bearer ' + token.access_token, other), /invalid for this resource/);
		await assert.rejects(Auth.exchangeIntegration({ grant_type: 'refresh_token', client_id: exchange.client_id, refresh_token: token.refresh_token, resource: other }), /Invalid refresh token or resource/);
		const refreshed = await Auth.exchangeIntegration({ grant_type: 'refresh_token', client_id: exchange.client_id, refresh_token: token.refresh_token, resource });
		assert.ok((await Auth.integration('Bearer ' + refreshed.access_token, resource)).credential);
	}
});
test('real delegation route verifies its secret, selected audience and legacy default; app excludes PAT', async () => {
	for (const resource of [Auth.mcpResource(), Auth.mcpResource(true)]) {
		const token = 'synthetic-access-' + resource; const grant = ResourceFixture.grants.find(row => row.resource === resource); ResourceFixture.tokens.push({ hash: Support.hash(token), resource, grant: grant._id });
		const send = (body, secret = process.env.JWT_SECRET, authorization = 'Bearer ' + token) => fetch(ResourceFixture.url + '/integrations/delegate', { method: 'POST', headers: { Authorization: authorization, 'X-MCP-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		assert.equal((await send({ resource }, 'wrong')).status, 401);
		assert.equal((await send({ resource: resource === Auth.mcpResource() ? Auth.mcpResource(true) : Auth.mcpResource() })).status, 401);
		assert.equal((await send({ resource: Auth.apiResource() })).status, 401);
		const delegated = await send({ resource }); assert.equal(delegated.status, 200);
		const bridge = await delegated.json(); assert.equal(bridge.expires_in, 60); assert.deepEqual((await Auth.integration('Bearer ' + bridge.access_token)).scopes, ['content:read']); await assert.rejects(Auth.integration('Bearer ' + bridge.access_token, resource), /invalid/);
		assert.equal((await send({})).status, resource === Auth.mcpResource() ? 200 : 401);
		assert.equal((await send({ resource }, process.env.JWT_SECRET, 'Token ' + ResourceFixture.pat)).status, resource === Auth.mcpResource() ? 200 : 401);
	}
	assert.ok((await Auth.integration('Token ' + ResourceFixture.pat)).credential);
});

test('token exchange rejects operator client_id and resource values before querying', async () => {
	const calls = OAuthClient.findOne.mock.callCount();
	for (const body of [{ client_id: { $gt: '' } }, { client_id: 'synthetic-client', resource: { $ne: null } }]) await assert.rejects(Auth.exchangeIntegration({ grant_type: 'refresh_token', refresh_token: 'x', ...body }), error => error.status === 400);
	await assert.rejects(Auth.integrationRequest({ client_id: { $gt: '' } }), error => error.status === 400);
	assert.equal(OAuthClient.findOne.mock.callCount(), calls);
	const response = await fetch(ResourceFixture.url + '/integrations/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: { $gt: '' } }) });
	assert.equal(response.status, 400);
});
test('MCP delegation is not behind the shared sign-in limiter', async () => {
	const app = express(); app.use(express.json()); await PublicApi.mount(app, (req, res) => res.status(429).json({ error: 'limited' })); app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
	try {
		assert.equal((await fetch(url + '/integrations/token', { method: 'POST' })).status, 429);
		for (let index = 0; index < 40; index++) assert.equal((await fetch(url + '/integrations/delegate', { method: 'POST', headers: { Authorization: 'Token ' + ResourceFixture.pat, 'X-MCP-Secret': process.env.JWT_SECRET } })).status, 200);
	} finally { await new Promise(resolve => server.close(resolve)); }
});
test('delegation and token exchange reject users requesting account deletion', async () => {
	ResourceFixture.deleting = true;
	try {
		await assert.rejects(Auth.integration('Token ' + ResourceFixture.pat), /Account deletion requested/);
		const grant = ResourceFixture.grants.find(row => row.kind === 'oauth');
		const token = 'synthetic-deleting-user';
		ResourceFixture.tokens.push({ hash: Support.hash(token), resource: grant.resource, grant: grant._id });
		await assert.rejects(Auth.integration('Bearer ' + token, grant.resource), /Account deletion requested/);
		await assert.rejects(Auth.exchangeIntegration({ grant_type: 'authorization_code', client_id: 'synthetic-client', redirect_uri: 'https://synthetic.test/callback', code: 'synthetic-code', code_verifier: ResourceFixture.verifier, resource: ResourceFixture.ticket.data.resource }), /Account deletion requested/);
	} finally { ResourceFixture.deleting = false; }
});
