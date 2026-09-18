import cachePackage from '@managani/cache';
import mongoose from 'mongoose';
import { RateLimitLogger, RateLimitSupport } from '../server/rate_limit_support.js';

const { createCache, createMongoCoordinator, createRateLimitStore } = cachePackage;

export class McpCache {
	static cache;
	static coordinator;
	static getCache() {
		if (!McpCache.cache) McpCache.cache = createCache({ servers: RateLimitSupport.cacheServers(), namespace: `${process.env.APP_INSTANCE || 'typerelay'}:v${process.env.APP_VERSION || 1}`, logger: new RateLimitLogger('mcp'), l1: { maxBytes: 4 * 1024 * 1024, maxTtlMs: 2000 } });
		return McpCache.cache;
	}
	static getRateLimitStore(prefix, windowMs) { return createRateLimitStore({ cache: McpCache.getCache(), prefix: `rl:${prefix}:`, windowMs }); }
	static getCoordinator() {
		if (!McpCache.coordinator) {
			if (!mongoose.connection.db) throw new Error('MCP MongoDB coordination is not connected');
			McpCache.coordinator = createMongoCoordinator({ db: mongoose.connection.db, namespace: `${process.env.APP_INSTANCE || 'typerelay'}:v${process.env.APP_VERSION || 1}`, logger: new RateLimitLogger('mcp') });
		}
		return McpCache.coordinator;
	}
	static async connect() {
		if (mongoose.connection.readyState === 1) return;
		await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
	}
}
