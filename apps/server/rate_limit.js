import cachePackage from '@managani/cache';
import { rateLimit } from 'express-rate-limit';
import { RateLimitLogger, RateLimitSupport } from './rate_limit_support.js';

const { createCache, createRateLimitStore } = cachePackage;

export class ApiRateLimit {
	static cache;
	static storeFactory;
	static getConfig() {
		return {
			enabled: RateLimitSupport.boolean('API_RATE_LIMIT_ENABLED', 'ApiRateLimit'),
			windowMs: RateLimitSupport.integer('API_RATE_LIMIT_WINDOW_MS', 'ApiRateLimit', 1),
			generalPerMinute: RateLimitSupport.integer('API_RATE_LIMIT_GENERAL_PER_MINUTE', 'ApiRateLimit'),
			expensivePerMinute: RateLimitSupport.integer('API_RATE_LIMIT_EXPENSIVE_PER_MINUTE', 'ApiRateLimit'),
			uploadPerMinute: RateLimitSupport.integer('API_RATE_LIMIT_UPLOAD_PER_MINUTE', 'ApiRateLimit'),
		};
	}
	static getRequestPath(request) { return RateLimitSupport.requestPath(request, '/api/v3'); }
	static getRateLimitKey(request) { return RateLimitSupport.credentialOrIpKey('typerelay-api', request); }
	static shouldSkip(request) { return String(request.method || '').toUpperCase() === 'OPTIONS'; }
	static isBulkLibraryCreate(request) {
		if (String(request.method || '').toUpperCase() !== 'POST' || ApiRateLimit.getRequestPath(request) !== '/libraries') return false;
		return (Array.isArray(request.body?.snippets) && request.body.snippets.length > 0) || (typeof request.body?.yaml === 'string' && request.body.yaml.trim() !== '');
	}
	static isUpload(request) {
		if (ApiRateLimit.isBulkLibraryCreate(request)) return true;
		return String(request.method || '').toUpperCase() === 'POST' && /^\/imports\/[^/]+(?:\/preview)?$/.test(ApiRateLimit.getRequestPath(request));
	}
	static isExpensive(request) {
		const method = String(request.method || '').toUpperCase();
		const path = ApiRateLimit.getRequestPath(request);
		return (method === 'GET' && /^\/libraries\/[^/]+\/export$/.test(path)) || (method === 'POST' && ['/snippets/batch', '/trash/action', '/trash/purge', '/trash/empty'].includes(path));
	}
	static getCache() {
		if (!ApiRateLimit.cache) ApiRateLimit.cache = createCache({ servers: RateLimitSupport.cacheServers(), namespace: `${process.env.APP_INSTANCE || 'typerelay'}:v${process.env.APP_VERSION || 1}`, logger: new RateLimitLogger('api'), l1: { maxBytes: 16 * 1024 * 1024, maxTtlMs: 2000 } });
		return ApiRateLimit.cache;
	}
	static getStore(prefix, windowMs) {
		if (ApiRateLimit.storeFactory) return ApiRateLimit.storeFactory(prefix, windowMs);
		try { return createRateLimitStore({ cache: ApiRateLimit.getCache(), prefix: `rl:${prefix}:`, windowMs }); }
		catch (error) { console.warn(JSON.stringify({ event: 'api_rate_limit_store_fallback', prefix, error: error.message })); return undefined; }
	}
	static noop() { return (request, response, next) => next(); }
	static createLimiter(name, limit, skip) {
		const config = ApiRateLimit.getConfig();
		if (!config.enabled) return ApiRateLimit.noop();
		return rateLimit({
			windowMs: config.windowMs,
			limit,
			keyGenerator: request => ApiRateLimit.getRateLimitKey(request),
			store: ApiRateLimit.getStore(name, config.windowMs),
			passOnStoreError: true,
			standardHeaders: 'draft-7',
			legacyHeaders: false,
			skip,
			handler: (request, response) => {
				console.warn(JSON.stringify({ event: 'api_rate_limit_exceeded', key: ApiRateLimit.getRateLimitKey(request), method: request.method, path: ApiRateLimit.getRequestPath(request), bucket: name }));
				return response.status(429).json({ error: 'Rate limit exceeded. Please slow down and try again later.' });
			},
		});
	}
	static createApiLimiters() {
		const config = ApiRateLimit.getConfig();
		return [
			ApiRateLimit.createLimiter('api-expensive', config.expensivePerMinute, request => ApiRateLimit.shouldSkip(request) || !ApiRateLimit.isExpensive(request)),
			ApiRateLimit.createLimiter('api-upload', config.uploadPerMinute, request => ApiRateLimit.shouldSkip(request) || !ApiRateLimit.isUpload(request)),
			ApiRateLimit.createLimiter('api-general', config.generalPerMinute, request => ApiRateLimit.shouldSkip(request)),
		];
	}
}
