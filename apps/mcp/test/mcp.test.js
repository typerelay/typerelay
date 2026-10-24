import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TypeRelayMcp } from '../server.js';
import { McpRateLimit } from '../rate_limit.js';
import { operations } from '../../server/api/catalog.js';

class Fixture { static upstream; static server; static url; static calls = []; static revoked = false; static toolExpired = false; static delegations = 0; }
before(async () => {
	const app = express(); app.use(express.json());
	app.post('/integrations/delegate', (req, res) => {
		assert.equal(req.headers['x-mcp-secret'], 'fixture-secret');
		Fixture.delegations++;
		if (req.headers.authorization !== 'Bearer fixture-token' || Fixture.revoked) return res.status(401).json({ error: 'Revoked' });
		res.json({ access_token: 'delegated-token' });
	});
	app.get('/api/v3/me', (req, res) => { assert.equal(req.headers.authorization, 'Bearer delegated-token'); res.json({ user: 'test', account: 'account', scopes: ['content:read', 'content:write'] }); });
	app.use('/api/v3', (req, res) => { if (Fixture.toolExpired) return res.status(401).json({ error: 'Token expired' }); Fixture.calls.push({ method: req.method, path: req.path, body: req.body, query: req.query }); res.json({ items: [{ id: 'test', title: 'Test', account: 'private-account', creator: 'private-creator', createdAt: 'private-timestamp', rich_html: '<img>', content: { version: 1, type: 'plain_text', text: 'Saved greeting' } }], next_cursor: null }); });
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
	assert.deepEqual(result.structuredContent.items[0], { id: 'test', title: 'Test', content: { version: 1, type: 'plain_text', text: 'Saved greeting' } });
	assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
	assert.equal(Fixture.calls.at(-1).path, '/search');
	const args = { path: { id: 'library' }, operation_id: 'persisted-operation-123', base_revision: 3, id: 'snippet-id-123456', value: { trigger: 'hello', content: { version: 1, type: 'plain_text', text: 'Hello' } } };
	await client.callTool({ name: 'create_snippet', arguments: args });
	assert.equal(Fixture.calls.at(-1).body.id, args.id);
	assert.equal(Fixture.calls.at(-1).body.operation_id, args.operation_id);
	assert.equal(Fixture.calls.at(-1).path, '/libraries/library/snippets');
	assert.equal((await client.callTool({ name: 'purge_item', arguments: {} })).isError, true);
	Fixture.toolExpired = true;
	const expired = await client.callTool({ name: 'search_snippets', arguments: { q: 'hello' } });
	assert.equal(expired.isError, true); assert.match(expired._meta['mcp/www_authenticate'][0], /invalid_token/);
	Fixture.toolExpired = false;
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
		const delegations = Fixture.delegations;
		assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body })).status, 200);
		const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }, body });
		assert.equal(response.status, 429);
		assert.ok(response.headers.get('retry-after'));
		assert.equal(Fixture.delegations, delegations + 1, 'over-limit requests must not mint delegated tokens');
	} finally {
		await new Promise(resolve => limited.close(resolve));
		McpRateLimit.storeFactory = undefined;
		for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
	}
});

test('tool annotations distinguish additive writes and destructive edits without public-world access', () => {
	const additive = ['create_library', 'create_snippet', 'commit_import'];
	for (const operation of TypeRelayMcp.catalog) {
		const tool = TypeRelayMcp.tool(operation);
		assert.equal(tool.annotations.destructiveHint, operation.mutation && !additive.includes(operation.id), operation.id);
		assert.equal(tool.annotations.openWorldHint, false, operation.id);
		assert.equal(tool.annotations.idempotentHint, true, operation.id);
		assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: [operation.scope] }]);
		assert.deepEqual(tool.securitySchemes, tool._meta.securitySchemes);
		assert.ok(TypeRelayMcp.descriptions[operation.id]?.length > 80, operation.id);
	}
});
test('MCP projects explicit result fields while preserving revisions, conflicts and user content', async () => {
	const content = { version: 1, type: 'template', text: 'Hello {{account}}', variables: { account: { label: 'Account', default: 'Friend', required: true } } };
	const snippet = { id: 'snippet', library: 'library', library_name: 'Private', revision: 4, trigger: 'hello', content, account: 'secret', _id: 'database-id', createdAt: 'timestamp', rich_html: 'rendered HTML' };
	const library = { id: 'library', name: 'Private', revision: 5, members: ['member'], groups: ['group'], permissions: { read: true, edit: true, manage: true, internal: true }, account: 'secret', creator: 'secret', members: ['member'], groups: ['group'], snippets: [snippet], records: [snippet] };
	const projected = await TypeRelayMcp.call({ request: async () => ({ library, conflicts: ['conflict'], api_scope: 'content:write', library_id: 'internal', html: 'rendered' }) }, 'update_snippet', { path: { id: 'library', snippet: 'snippet' } });
	assert.deepEqual(projected, { library: { id: 'library', name: 'Private', revision: 5, members: ['member'], groups: ['group'], permissions: { read: true, edit: true, manage: true }, snippets: [{ id: 'snippet', library: 'library', library_name: 'Private', trigger: 'hello', content, revision: 4 }] }, conflicts: ['conflict'] });
	assert.deepEqual(TypeRelayMcp.response('list_libraries', { items: [library], next_cursor: 'library', internal: 'secret' }), { items: [{ id: 'library', name: 'Private', revision: 5, members: ['member'], groups: ['group'], permissions: { read: true, edit: true, manage: true } }], next_cursor: 'library' });
	assert.deepEqual(TypeRelayMcp.response('list_conflicts', { items: [{ id: 'conflict', library: 'library', snippet: 'snippet', local: { content }, base: null, server: snippet, user: 'secret', account: 'secret' }], next_cursor: null }).items[0], { id: 'conflict', library: 'library', snippet: 'snippet', local: { content }, base: null, server: { id: 'snippet', library: 'library', library_name: 'Private', trigger: 'hello', content, revision: 4 } });
	assert.deepEqual(TypeRelayMcp.response('get_operation', { found: true, library, library_id: 'secret', api_scope: 'content:write', resolved: 'conflict' }).resolved, 'conflict');
	assert.deepEqual(TypeRelayMcp.response('preview_import', { entries: [{ key: '0:0', title: 'Greeting', content, warnings: ['Review'], account: 'secret' }], warnings: [], internal: 'secret' }), { entries: [{ key: '0:0', title: 'Greeting', content, warnings: ['Review'] }], warnings: [] });
	assert.deepEqual(TypeRelayMcp.response('get_asset_metadata', { id: 'asset', mime_type: 'image/png', size: 25, width: 1, height: 1, source_urls: ['https://private.example/image'], account: 'secret' }), { id: 'asset', mime_type: 'image/png', size: 25, width: 1, height: 1 });
	assert.deepEqual(TypeRelayMcp.response('empty_trash', { affected: [{ id: 'snippet', type: 'snippet', library: 'library', revision: 4, account: 'secret' }], api_scope: 'trash:purge' }), { affected: [{ type: 'snippet', id: 'snippet', library: 'library', revision: 4 }] });
});

test('recovery, import and rich-text result contracts preserve only task fields', () => {
	const content = { version: 2, type: 'rich_text', markdown: '![Logo](asset:abc)', text: 'Logo', assets: ['abc'], variables: { account: { label: 'Account' } }, internal: 'secret' };
	assert.deepEqual(TypeRelayMcp.response('get_snippet', { id: 'rich', revision: 2, content, account: 'secret' }), { id: 'rich', revision: 2, content: { version: 2, type: 'rich_text', markdown: '![Logo](asset:abc)', text: 'Logo', assets: ['abc'], variables: { account: { label: 'Account' } } } });
	assert.deepEqual(TypeRelayMcp.response('list_trash', { items: [{ type: 'snippet', id: 'one', library: 'lib', revision: 3, expires_at: '2026-11-01', can_restore: true, can_purge: false, account: 'secret', trashed_by: 'secret' }], next_cursor: null }), { items: [{ type: 'snippet', id: 'one', library: 'lib', revision: 3, expires_at: '2026-11-01', can_restore: true, can_purge: false }], next_cursor: null });
	assert.deepEqual(TypeRelayMcp.response('commit_import', { libraries: [{ id: 'lib', revision: 1 }], import_summary: { imported: 1, skipped: ['Unsupported command'], renamed: [{ key: '0:0', title: 'Greeting', original: 'hello', trigger: 'hello-2', account: 'secret' }], internal: 'secret' } }), { libraries: [{ id: 'lib', revision: 1 }], import_summary: { imported: 1, skipped: ['Unsupported command'], renamed: [{ key: '0:0', title: 'Greeting', original: 'hello', trigger: 'hello-2' }] } });
	assert.deepEqual(TypeRelayMcp.response('get_operation', { found: false, account: 'secret' }), { found: false });
	assert.deepEqual(TypeRelayMcp.response('export_library', { yaml: 'matches: []', internal: 'secret' }), { yaml: 'matches: []' });
});
