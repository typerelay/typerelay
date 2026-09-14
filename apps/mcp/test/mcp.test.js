import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TypeRelayMcp } from '../server.js';
import { operations } from '../../server/api/catalog.js';

class Fixture { static upstream; static server; static url; static calls = []; static revoked = false; }
before(async () => {
	const app = express(); app.use(express.json());
	app.post('/integrations/delegate', (req, res) => {
		assert.equal(req.headers['x-mcp-secret'], 'fixture-secret');
		if (req.headers.authorization !== 'Bearer fixture-token' || Fixture.revoked) return res.status(401).json({ error: 'Revoked' });
		res.json({ access_token: 'delegated-token' });
	});
	app.get('/api/v3/me', (req, res) => { assert.equal(req.headers.authorization, 'Bearer delegated-token'); res.json({ user: 'test', account: 'account', scopes: ['content:read', 'content:write'] }); });
	app.use('/api/v3', (req, res) => { Fixture.calls.push({ method: req.method, path: req.path, body: req.body, query: req.query }); res.json({ items: [{ id: 'test', title: 'Test' }], next_cursor: null }); });
	Fixture.upstream = app.listen(0, '127.0.0.1'); await new Promise(resolve => Fixture.upstream.once('listening', resolve));
	Fixture.server = TypeRelayMcp.app({ apiBase: 'http://127.0.0.1:' + Fixture.upstream.address().port, secret: () => 'fixture-secret' }).listen(0, '127.0.0.1'); await new Promise(resolve => Fixture.server.once('listening', resolve));
	Fixture.url = 'http://127.0.0.1:' + Fixture.server.address().port;
});
after(async () => { await new Promise(resolve => Fixture.server.close(resolve)); await new Promise(resolve => Fixture.upstream.close(resolve)); });
test('SDK client initializes, discovers scoped tools and calls the public API', async () => {
	const client = new Client({ name: 'independent-test-client', version: '1.0' });
	await client.connect(new StreamableHTTPClientTransport(new URL(Fixture.url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer fixture-token' } } }));
	const { tools } = await client.listTools();
	assert.ok(tools.some(tool => tool.name === 'search_snippets'));
	assert.ok(!tools.some(tool => tool.name === 'purge_item' || tool.name === 'get_team'));
	const result = await client.callTool({ name: 'search_snippets', arguments: { q: 'hello', limit: 10 } });
	assert.equal(result.structuredContent.items[0].id, 'test');
	assert.equal(Fixture.calls.at(-1).path, '/search');
	const args = { path: { id: 'library' }, operation_id: 'persisted-operation-123', base_revision: 3, id: 'snippet-id-123456', value: { trigger: 'hello', content: { version: 1, type: 'plain_text', text: 'Hello' } } };
	await client.callTool({ name: 'create_snippet', arguments: args });
	assert.equal(Fixture.calls.at(-1).body.id, args.id);
	assert.equal(Fixture.calls.at(-1).body.operation_id, args.operation_id);
	assert.equal(Fixture.calls.at(-1).path, '/libraries/library/snippets');
	assert.equal((await client.callTool({ name: 'purge_item', arguments: {} })).isError, true);
	await client.close();
});
test('authentication challenges, untrusted origins and unsupported methods', async () => {
	const response = await fetch(Fixture.url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /resource_metadata/);
	assert.equal((await fetch(Fixture.url + '/mcp', { method: 'POST', headers: { Origin: 'https://untrusted.test' } })).status, 403);
	assert.equal((await fetch(Fixture.url + '/mcp')).status, 405);
	assert.equal((await fetch(Fixture.url + '/.well-known/oauth-protected-resource/mcp')).status, 200);
	Fixture.revoked = true;
	assert.equal((await fetch(Fixture.url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});
test('tools and schemas derive from the public operation catalog', () => {
	assert.deepEqual(TypeRelayMcp.catalog.map(row => row.id), operations.filter(row => row.mcp).map(row => row.id));
	for (const operation of TypeRelayMcp.catalog) { const tool = TypeRelayMcp.tool(operation); assert.equal(tool.annotations.readOnlyHint, !operation.mutation); if (operation.mutation) assert.ok(tool.inputSchema.required.includes('operation_id')); }
});
