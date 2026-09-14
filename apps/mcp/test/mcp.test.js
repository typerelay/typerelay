import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TypeRelayMcp } from '../server.js';
import { McpRateLimit } from '../rate_limit.js';
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
	Fixture.server = TypeRelayMcp.app({ apiBase: 'http://127.0.0.1:' + Fixture.upstream.address().port, secret: () => 'fixture-secret', applyRateLimits: false }).listen(0, '127.0.0.1'); await new Promise(resolve => Fixture.server.once('listening', resolve));
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
test('authenticated MCP requests use the configured request limiter', async () => {
	const keys = ['MCP_RATE_LIMIT_ENABLED', 'MCP_RATE_LIMIT_WINDOW_MS', 'MCP_IP_FLOOD_PER_MINUTE', 'MCP_UNAUTH_PER_MINUTE', 'MCP_AUTH_PER_MINUTE', 'MCP_HEAVY_TOOL_PER_MINUTE', 'MCP_TOOL_CONCURRENCY', 'MCP_HEAVY_TOOL_CONCURRENCY'];
	const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	Object.assign(process.env, { MCP_RATE_LIMIT_ENABLED: 'true', MCP_RATE_LIMIT_WINDOW_MS: '60000', MCP_IP_FLOOD_PER_MINUTE: '10', MCP_UNAUTH_PER_MINUTE: '10', MCP_AUTH_PER_MINUTE: '1', MCP_HEAVY_TOOL_PER_MINUTE: '10', MCP_TOOL_CONCURRENCY: '3', MCP_HEAVY_TOOL_CONCURRENCY: '1' });
	McpRateLimit.storeFactory = () => undefined;
	McpRateLimit.requestLimiters.clear();
	Fixture.revoked = false;
	const limited = TypeRelayMcp.app({ apiBase: 'http://127.0.0.1:' + Fixture.upstream.address().port, secret: () => 'fixture-secret' }).listen(0, '127.0.0.1');
	await new Promise(resolve => limited.once('listening', resolve));
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rate-limit-test', version: '1.0' } } });
	try {
		const url = 'http://127.0.0.1:' + limited.address().port + '/mcp';
		assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body })).status, 200);
		const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body });
		assert.equal(response.status, 429);
		assert.ok(response.headers.get('retry-after'));
	} finally {
		await new Promise(resolve => limited.close(resolve));
		McpRateLimit.storeFactory = undefined;
		for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
	}
});
