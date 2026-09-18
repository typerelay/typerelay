import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { McpCache } from '../cache.js';
import { McpRateLimit } from '../rate_limit.js';

const ENV_KEYS = ['MCP_RATE_LIMIT_ENABLED', 'MCP_RATE_LIMIT_WINDOW_MS', 'MCP_IP_FLOOD_PER_MINUTE', 'MCP_UNAUTH_PER_MINUTE', 'MCP_AUTH_PER_MINUTE', 'MCP_HEAVY_TOOL_PER_MINUTE', 'MCP_TOOL_CONCURRENCY', 'MCP_HEAVY_TOOL_CONCURRENCY'];
const DEFAULTS = { MCP_RATE_LIMIT_ENABLED: 'true', MCP_RATE_LIMIT_WINDOW_MS: '60000', MCP_IP_FLOOD_PER_MINUTE: '300', MCP_UNAUTH_PER_MINUTE: '30', MCP_AUTH_PER_MINUTE: '120', MCP_HEAVY_TOOL_PER_MINUTE: '30', MCP_TOOL_CONCURRENCY: '3', MCP_HEAVY_TOOL_CONCURRENCY: '1' };
let saved = {};
let savedCache;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	savedCache = McpCache.cache;
	McpCache.cache = { increment: async () => 1 };
	McpRateLimit.storeFactory = () => undefined;
	McpRateLimit.requestLimiters.clear();
	McpRateLimit.memoryCounters.clear();
	McpRateLimit.memoryConcurrency.clear();
});
afterEach(() => {
	for (const key of ENV_KEYS) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
	McpCache.cache = savedCache;
	McpRateLimit.storeFactory = undefined;
});

class Coordinator {
	constructor() { this.active = new Map(); this.sequence = 0; }
	async acquireSemaphore(key, limit) {
		const slots = this.active.get(key) || new Map();
		for (let slot = 0; slot < limit; slot++) if (!slots.has(slot)) { const lease = { semaphoreKey: key, slot, token: String(++this.sequence) }; slots.set(slot, lease.token); this.active.set(key, slots); return lease; }
		return null;
	}
	async releaseSemaphore(lease) { const slots = this.active.get(lease.semaphoreKey); if (!slots || slots.get(lease.slot) !== lease.token) return false; slots.delete(lease.slot); if (!slots.size) this.active.delete(lease.semaphoreKey); return true; }
}

describe('MCP rate limits', () => {
	it('requires and validates the Compose environment contract', () => {
		assert.throws(() => McpRateLimit.getConfig(), /missing required env 'MCP_RATE_LIMIT_ENABLED'/);
		Object.assign(process.env, DEFAULTS);
		assert.deepEqual(McpRateLimit.getConfig(), { enabled: true, windowMs: 60000, ipFloodPerMinute: 300, unauthPerMinute: 30, authPerMinute: 120, heavyToolPerMinute: 30, toolConcurrency: 3, heavyToolConcurrency: 1 });
		process.env.MCP_TOOL_CONCURRENCY = '3x';
		assert.throws(() => McpRateLimit.getConfig(), /must be an integer >= 0/);
	});
	it('classifies dynamic bulk creation and explicit heavy workflows', () => {
		assert.equal(McpRateLimit.isHeavyTool('create_library', { name: 'Plain' }), false);
		assert.equal(McpRateLimit.isHeavyTool('create_library', { yaml: 'matches: []' }), true);
		assert.equal(McpRateLimit.isHeavyTool('search_snippets'), false);
		for (const name of ['preview_import', 'commit_import', 'export_library', 'batch_snippets', 'change_trash', 'purge_item', 'empty_trash']) assert.equal(McpRateLimit.isHeavyTool(name), true);
	});
	it('separates missing-credential and authenticated request limits', async () => {
		Object.assign(process.env, DEFAULTS, { MCP_IP_FLOOD_PER_MINUTE: '10', MCP_UNAUTH_PER_MINUTE: '1', MCP_AUTH_PER_MINUTE: '1' });
		const app = express();
		app.use(McpRateLimit.createIpFloodLimiter());
		app.use(McpRateLimit.createUnauthLimiter());
		const authenticated = McpRateLimit.createAuthenticatedRequestLimiter();
		app.post('/mcp', async (request, response) => {
			if (!request.headers.authorization) return response.status(401).json({ error: 'Authentication required' });
			if (!await McpRateLimit.consumeAuthenticatedRequest(authenticated, request, response)) return;
			return response.json({ ok: true });
		});
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		const url = `http://127.0.0.1:${server.address().port}/mcp`;
		try {
			assert.equal((await fetch(url, { method: 'POST' })).status, 401);
			assert.equal((await fetch(url, { method: 'POST' })).status, 429);
			assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer valid' } })).status, 200);
			assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer valid' } })).status, 429);
		} finally { await new Promise(resolve => server.close(resolve)); }
	});
	it('limits overlapping heavy tools and releases leases', async () => {
		Object.assign(process.env, DEFAULTS);
		const coordinator = new Coordinator();
		let release;
		let started;
		const startedPromise = new Promise(resolve => { started = resolve; });
		const releasePromise = new Promise(resolve => { release = resolve; });
		const first = McpRateLimit.runToolWithLimits({ toolName: 'commit_import', rateLimitKey: 'credential', coordinator, run: async () => { started(); await releasePromise; return { content: [] }; } });
		await startedPromise;
		const second = await McpRateLimit.runToolWithLimits({ toolName: 'commit_import', rateLimitKey: 'credential', coordinator, run: async () => ({ content: [] }) });
		assert.equal(second.isError, true);
		assert.match(JSON.parse(second.content[0].text).error, /Too many concurrent/);
		release();
		await first;
		assert.equal(coordinator.active.size, 0);
		await assert.rejects(McpRateLimit.runToolWithLimits({ toolName: 'get_library', rateLimitKey: 'credential', coordinator, run: async () => { throw new Error('tool failed'); } }), /tool failed/);
		assert.equal(coordinator.active.size, 0);
	});
	it('fails closed for unavailable heavy coordination and enforces a zero heavy rate', async () => {
		Object.assign(process.env, DEFAULTS);
		let ran = false;
		const unavailable = await McpRateLimit.runToolWithLimits({ toolName: 'empty_trash', rateLimitKey: 'credential', coordinator: { acquireSemaphore: async () => { throw new Error('MongoDB unavailable'); } }, run: async () => { ran = true; } });
		assert.equal(ran, false);
		assert.match(JSON.parse(unavailable.content[0].text).error, /service unavailable/);
		process.env.MCP_HEAVY_TOOL_PER_MINUTE = '0';
		const limited = await McpRateLimit.runToolWithLimits({ toolName: 'export_library', rateLimitKey: 'other', coordinator: new Coordinator(), run: async () => { ran = true; } });
		assert.equal(limited.isError, true);
		assert.match(JSON.parse(limited.content[0].text).error, /Rate limit exceeded/);
	});
	it('falls back to memory for tool counters and ordinary concurrency', async () => {
		Object.assign(process.env, DEFAULTS, { MCP_HEAVY_TOOL_PER_MINUTE: '1' });
		McpCache.cache = { increment: async () => { throw new Error('Memcached unavailable'); } };
		const coordinator = new Coordinator();
		const first = await McpRateLimit.runToolWithLimits({ toolName: 'export_library', rateLimitKey: 'fallback-rate', coordinator, run: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
		assert.equal(first.isError, undefined);
		const second = await McpRateLimit.runToolWithLimits({ toolName: 'export_library', rateLimitKey: 'fallback-rate', coordinator, run: async () => ({ content: [] }) });
		assert.equal(second.isError, true);
		let ran = false;
		const ordinary = await McpRateLimit.runToolWithLimits({ toolName: 'get_library', rateLimitKey: 'fallback-concurrency', coordinator: { acquireSemaphore: async () => { throw new Error('MongoDB unavailable'); } }, run: async () => { ran = true; return { content: [] }; } });
		assert.equal(ran, true);
		assert.equal(ordinary.isError, undefined);
		assert.equal(McpRateLimit.memoryConcurrency.size, 0);
	});
});
