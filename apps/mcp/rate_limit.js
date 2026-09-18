import { rateLimit } from 'express-rate-limit';
import { RateLimitSupport } from '../server/rate_limit_support.js';
import { McpCache } from './cache.js';

export class McpRateLimit {
	static concurrencyTtlMs = 5 * 60 * 1000;
	static requestLimiters = new Map();
	static memoryCounters = new Map();
	static memoryConcurrency = new Map();
	static memoryFallbackLogged = false;
	static storeFactory;
	static heavyTools = new Set(['preview_import', 'commit_import', 'export_library', 'batch_snippets', 'change_trash', 'purge_item', 'empty_trash']);
	static getConfig() {
		return {
			enabled: RateLimitSupport.boolean('MCP_RATE_LIMIT_ENABLED', 'McpRateLimit'),
			windowMs: RateLimitSupport.integer('MCP_RATE_LIMIT_WINDOW_MS', 'McpRateLimit', 1),
			ipFloodPerMinute: RateLimitSupport.integer('MCP_IP_FLOOD_PER_MINUTE', 'McpRateLimit'),
			unauthPerMinute: RateLimitSupport.integer('MCP_UNAUTH_PER_MINUTE', 'McpRateLimit'),
			authPerMinute: RateLimitSupport.integer('MCP_AUTH_PER_MINUTE', 'McpRateLimit'),
			heavyToolPerMinute: RateLimitSupport.integer('MCP_HEAVY_TOOL_PER_MINUTE', 'McpRateLimit'),
			toolConcurrency: RateLimitSupport.integer('MCP_TOOL_CONCURRENCY', 'McpRateLimit'),
			heavyToolConcurrency: RateLimitSupport.integer('MCP_HEAVY_TOOL_CONCURRENCY', 'McpRateLimit'),
		};
	}
	static getRequestPath(request) { return RateLimitSupport.requestPath(request); }
	static getCredentialOrIpKey(request) { return RateLimitSupport.credentialOrIpKey('typerelay', request); }
	static shouldSkip(request) {
		const path = McpRateLimit.getRequestPath(request);
		return String(request.method || '').toUpperCase() === 'OPTIONS' || path === '/health' || path === '/info' || path.startsWith('/.well-known/');
	}
	static setResponseHeaders(response) { response.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, RateLimit, RateLimit-Policy, Retry-After'); }
	static getStore(prefix, windowMs) {
		if (McpRateLimit.storeFactory) return McpRateLimit.storeFactory(prefix, windowMs);
		try { return McpCache.getRateLimitStore(prefix, windowMs); }
		catch (error) { McpRateLimit.logFallback('mcp_rate_limit_store_fallback', error); return undefined; }
	}
	static logFallback(event, error) {
		if (McpRateLimit.memoryFallbackLogged) return;
		McpRateLimit.memoryFallbackLogged = true;
		console.warn(JSON.stringify({ event, error: error.message }));
	}
	static noop() { return (request, response, next) => next(); }
	static createRequestLimiter(name, limit, keyGenerator, skip) {
		const config = McpRateLimit.getConfig();
		if (!config.enabled) return McpRateLimit.noop();
		const cacheKey = `${name}:${limit}:${config.windowMs}`;
		if (McpRateLimit.requestLimiters.has(cacheKey)) return McpRateLimit.requestLimiters.get(cacheKey);
		const limiter = rateLimit({
			windowMs: config.windowMs,
			limit,
			keyGenerator,
			store: McpRateLimit.getStore(`mcp:typerelay:${name}`, config.windowMs),
			passOnStoreError: true,
			standardHeaders: 'draft-7',
			legacyHeaders: false,
			skip,
			handler: (request, response) => {
				McpRateLimit.setResponseHeaders(response);
				console.warn(JSON.stringify({ event: 'mcp_rate_limit_exceeded', bucket: name, method: request.method, path: McpRateLimit.getRequestPath(request) }));
				return response.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down and try again later.' });
			},
		});
		McpRateLimit.requestLimiters.set(cacheKey, limiter);
		return limiter;
	}
	static createIpFloodLimiter() {
		return McpRateLimit.createRequestLimiter('ip-flood', McpRateLimit.getConfig().ipFloodPerMinute, request => RateLimitSupport.key('typerelay', 'ip', RateLimitSupport.clientIp(request)), request => McpRateLimit.shouldSkip(request));
	}
	static createUnauthLimiter() {
		return McpRateLimit.createRequestLimiter('unauth', McpRateLimit.getConfig().unauthPerMinute, request => RateLimitSupport.key('typerelay', 'ip', RateLimitSupport.clientIp(request)), request => McpRateLimit.shouldSkip(request) || !!RateLimitSupport.credential(request));
	}
	static createAuthenticatedRequestLimiter() {
		return McpRateLimit.createRequestLimiter('auth', McpRateLimit.getConfig().authPerMinute, request => request.mcpRateLimitKey || McpRateLimit.getCredentialOrIpKey(request), request => McpRateLimit.shouldSkip(request));
	}
	static async consumeAuthenticatedRequest(limiter, request, response) {
		if (!McpRateLimit.getConfig().enabled) return true;
		request.mcpRateLimitKey = McpRateLimit.getCredentialOrIpKey(request);
		return new Promise((resolve, reject) => limiter(request, response, error => error ? reject(error) : resolve(!response.headersSent)));
	}
	static counter(key, windowMs) {
		const now = Date.now();
		let counter = McpRateLimit.memoryCounters.get(key);
		if (!counter || counter.resetAt <= now) { counter = { count: 0, resetAt: now + windowMs }; McpRateLimit.memoryCounters.set(key, counter); }
		return counter;
	}
	static async consumeCounter(key, limit, windowMs) {
		if (limit <= 0) return false;
		try {
			const count = await McpCache.getCache().increment(key, { ttlMs: windowMs });
			if (Number.isFinite(count)) return count <= limit;
		} catch (error) { McpRateLimit.logFallback('mcp_tool_rate_limit_memory_fallback', error); }
		const counter = McpRateLimit.counter(key, windowMs);
		counter.count++;
		return counter.count <= limit;
	}
	static async acquireConcurrency(key, limit, heavy, coordinator) {
		if (limit <= 0) return { allowed: false };
		try {
			const lease = await (coordinator || McpCache.getCoordinator()).acquireSemaphore(key, limit, { ttlMs: McpRateLimit.concurrencyTtlMs });
			return lease ? { allowed: true, lease } : { allowed: false };
		} catch (error) {
			if (heavy) { console.warn(JSON.stringify({ event: 'mcp_heavy_concurrency_unavailable', error: error.message })); return { allowed: false, unavailable: true }; }
			McpRateLimit.logFallback('mcp_concurrency_memory_fallback', error);
		}
		const count = McpRateLimit.memoryConcurrency.get(key) || 0;
		if (count >= limit) return { allowed: false, key, memory: true };
		McpRateLimit.memoryConcurrency.set(key, count + 1);
		return { allowed: true, key, memory: true };
	}
	static async releaseConcurrency(lock, coordinator) {
		if (!lock) return;
		if (lock.memory) {
			const count = McpRateLimit.memoryConcurrency.get(lock.key) || 0;
			if (count <= 1) McpRateLimit.memoryConcurrency.delete(lock.key); else McpRateLimit.memoryConcurrency.set(lock.key, count - 1);
			return;
		}
		if (!lock.lease) return;
		try { await (coordinator || McpCache.getCoordinator()).releaseSemaphore(lock.lease); }
		catch (error) { console.warn(JSON.stringify({ event: 'mcp_concurrency_release_failed', error: error.message })); }
	}
	static isHeavyTool(name, args = {}) {
		if (name === 'create_library') return (Array.isArray(args.snippets) && args.snippets.length > 0) || (typeof args.yaml === 'string' && args.yaml.trim() !== '');
		return McpRateLimit.heavyTools.has(name);
	}
	static errorResult(tool, error) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error, tool }, null, 2) }], isError: true }; }
	static async runToolWithLimits({ toolName, args = {}, rateLimitKey, run, coordinator }) {
		const config = McpRateLimit.getConfig();
		if (!config.enabled) return run();
		const key = rateLimitKey || RateLimitSupport.key('typerelay', 'process', process.pid);
		const heavy = McpRateLimit.isHeavyTool(toolName, args);
		if (heavy && !await McpRateLimit.consumeCounter(`rl:mcp:typerelay:heavy-tool:${key}`, config.heavyToolPerMinute, config.windowMs)) {
			console.warn(JSON.stringify({ event: 'mcp_heavy_tool_rate_limit_exceeded', tool: toolName }));
			return McpRateLimit.errorResult(toolName, 'Rate limit exceeded. Please slow down and try again later.');
		}
		const name = heavy ? 'heavy-tool' : 'tool';
		const limit = heavy ? config.heavyToolConcurrency : config.toolConcurrency;
		const lock = await McpRateLimit.acquireConcurrency(`rl:mcp:typerelay:concurrency:${name}:${key}`, limit, heavy, coordinator);
		if (!lock.allowed) return McpRateLimit.errorResult(toolName, lock.unavailable ? 'MCP concurrency service unavailable. Please try again later.' : 'Too many concurrent MCP tool calls. Please wait and try again.');
		try { return await run(); }
		finally { await McpRateLimit.releaseConcurrency(lock, coordinator); }
	}
}
