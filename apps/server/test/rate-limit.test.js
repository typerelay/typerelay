import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { ApiRateLimit } from '../rate_limit.js';

const ENV_KEYS = ['API_RATE_LIMIT_ENABLED', 'API_RATE_LIMIT_WINDOW_MS', 'API_RATE_LIMIT_GENERAL_PER_MINUTE', 'API_RATE_LIMIT_EXPENSIVE_PER_MINUTE', 'API_RATE_LIMIT_UPLOAD_PER_MINUTE'];
const DEFAULTS = { API_RATE_LIMIT_ENABLED: 'true', API_RATE_LIMIT_WINDOW_MS: '60000', API_RATE_LIMIT_GENERAL_PER_MINUTE: '120', API_RATE_LIMIT_EXPENSIVE_PER_MINUTE: '60', API_RATE_LIMIT_UPLOAD_PER_MINUTE: '20' };
let saved = {};

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	ApiRateLimit.storeFactory = () => undefined;
});
afterEach(() => {
	for (const key of ENV_KEYS) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
	ApiRateLimit.storeFactory = undefined;
});

describe('API rate limits', () => {
	it('requires and validates the Compose environment contract', () => {
		assert.throws(() => ApiRateLimit.getConfig(), /missing required env 'API_RATE_LIMIT_ENABLED'/);
		Object.assign(process.env, DEFAULTS);
		assert.deepEqual(ApiRateLimit.getConfig(), { enabled: true, windowMs: 60000, generalPerMinute: 120, expensivePerMinute: 60, uploadPerMinute: 20 });
		process.env.API_RATE_LIMIT_WINDOW_MS = '60000ms';
		assert.throws(() => ApiRateLimit.getConfig(), /must be an integer >= 1/);
	});
	it('hashes credentials, normalizes proxy IPs and classifies TypeRelay workloads', () => {
		const bearer = ApiRateLimit.getRateLimitKey({ headers: { authorization: 'Bearer secret' } });
		const token = ApiRateLimit.getRateLimitKey({ headers: { authorization: 'Token secret' } });
		const ip = ApiRateLimit.getRateLimitKey({ headers: { 'x-forwarded-for': '::ffff:203.0.113.9, 10.0.0.1' } });
		assert.equal(bearer, token);
		assert.match(bearer, /^typerelay-api:bearer:[a-f0-9]{64}$/);
		assert.match(ip, /^typerelay-api:ip:[a-f0-9]{64}$/);
		assert.equal(bearer.includes('secret'), false);
		assert.equal(ApiRateLimit.isUpload({ method: 'POST', originalUrl: '/api/v3/imports/yaml/preview' }), true);
		assert.equal(ApiRateLimit.isUpload({ method: 'POST', originalUrl: '/api/v3/imports/yaml' }), true);
		assert.equal(ApiRateLimit.isUpload({ method: 'POST', originalUrl: '/api/v3/libraries', body: { snippets: [{ id: 'one' }] } }), true);
		assert.equal(ApiRateLimit.isUpload({ method: 'POST', originalUrl: '/api/v3/libraries', body: { name: 'Plain' } }), false);
		assert.equal(ApiRateLimit.isExpensive({ method: 'GET', originalUrl: '/api/v3/libraries/one/export' }), true);
		assert.equal(ApiRateLimit.isExpensive({ method: 'POST', originalUrl: '/api/v3/trash/empty' }), true);
		assert.equal(ApiRateLimit.isExpensive({ method: 'GET', originalUrl: '/api/v3/search' }), false);
	});
	it('enforces general, upload and expensive buckets with standard headers', async () => {
		Object.assign(process.env, DEFAULTS, { API_RATE_LIMIT_GENERAL_PER_MINUTE: '1', API_RATE_LIMIT_EXPENSIVE_PER_MINUTE: '1', API_RATE_LIMIT_UPLOAD_PER_MINUTE: '1' });
		const app = express();
		app.use(express.json());
		app.use('/api/v3', ...ApiRateLimit.createApiLimiters(), (request, response) => response.json({ ok: true }));
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		const base = `http://127.0.0.1:${server.address().port}/api/v3`;
		try {
			const generalHeaders = { Authorization: 'Token general' };
			assert.equal((await fetch(`${base}/libraries`, { headers: generalHeaders })).status, 200);
			const generalLimited = await fetch(`${base}/search`, { headers: generalHeaders });
			assert.equal(generalLimited.status, 429);
			assert.ok(generalLimited.headers.get('ratelimit'));
			assert.ok(generalLimited.headers.get('retry-after'));
			const uploadHeaders = { Authorization: 'Token upload', 'Content-Type': 'application/json' };
			assert.equal((await fetch(`${base}/imports/yaml/preview`, { method: 'POST', headers: uploadHeaders, body: '{}' })).status, 200);
			assert.equal((await fetch(`${base}/imports/yaml`, { method: 'POST', headers: uploadHeaders, body: '{}' })).status, 429);
			const expensiveHeaders = { Authorization: 'Token expensive', 'Content-Type': 'application/json' };
			assert.equal((await fetch(`${base}/trash/action`, { method: 'POST', headers: expensiveHeaders, body: '{}' })).status, 200);
			assert.equal((await fetch(`${base}/trash/empty`, { method: 'POST', headers: expensiveHeaders, body: '{}' })).status, 429);
			assert.equal((await fetch(`${base}/libraries`, { method: 'OPTIONS' })).status, 200);
		} finally { await new Promise(resolve => server.close(resolve)); }
	});
	it('disables every API bucket together', async () => {
		Object.assign(process.env, DEFAULTS, { API_RATE_LIMIT_ENABLED: 'false', API_RATE_LIMIT_GENERAL_PER_MINUTE: '0' });
		const app = express();
		app.use('/api/v3', ...ApiRateLimit.createApiLimiters(), (request, response) => response.json({ ok: true }));
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		try {
			const base = `http://127.0.0.1:${server.address().port}/api/v3/libraries`;
			for (let index = 0; index < 3; index++) assert.equal((await fetch(base)).status, 200);
		} finally { await new Promise(resolve => server.close(resolve)); }
	});
});
