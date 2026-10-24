import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { ApiRateLimit } from '../rate_limit.js';
import { RateLimitSupport } from '../rate_limit_support.js';

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
	it('trusts Cloudflare client IP only behind a Cloudflare peer resolved by Express', () => {
		const headers = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.8', 'x-real-ip': '198.51.100.7' };
		assert.equal(RateLimitSupport.clientIp({ ip: '192.0.2.1', headers }), '192.0.2.1');
		assert.equal(RateLimitSupport.clientIp({ ip: '::ffff:173.245.48.1', headers }), '203.0.113.9');
		assert.equal(RateLimitSupport.clientIp({ ip: '2606:4700::1', headers }), '203.0.113.9');
		assert.equal(RateLimitSupport.clientIp({ ip: '173.245.48.1', headers: { 'cf-connecting-ip': 'invalid' } }), '173.245.48.1');
		assert.equal(RateLimitSupport.clientIp({ ip: '2001:db8:abcd:1200::1' }), RateLimitSupport.clientIp({ ip: '2001:db8:abcd:1200::2' }));
	});
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
	it('limits token refreshes per refresh token, separately from the sign-in limiter', async () => {
		let signIns = 0;
		const app = express();
		app.use(express.json());
		app.post('/oauth/token', ApiRateLimit.tokenLimiter((request, response, next) => ++signIns > 30 ? response.status(429).json({ error: 'limited' }) : next()), (request, response) => response.json({ ok: true }));
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		const post = body => fetch(`http://127.0.0.1:${server.address().port}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		try {
			for (let index = 0; index < 40; index++) assert.equal((await post({ grant_type: 'refresh_token', refresh_token: 'token-' + index })).status, 200);
			assert.equal(signIns, 0);
			for (let index = 0; index < 300; index++) assert.equal((await post({ grant_type: 'refresh_token', refresh_token: 'shared' })).status, 200);
			const limited = await post({ grant_type: 'refresh_token', refresh_token: 'shared' });
			assert.equal(limited.status, 429);
			assert.deepEqual(await limited.json(), { error: 'Too many token refreshes; try again later.' });
			assert.equal((await post({ grant_type: 'refresh_token', refresh_token: 'other' })).status, 200);
			for (let index = 0; index < 30; index++) assert.equal((await post({ grant_type: 'authorization_code' })).status, 200);
			assert.equal((await post({ grant_type: 'authorization_code' })).status, 429);
		} finally { await new Promise(resolve => server.close(resolve)); }
	});
	it('caps token refreshes per client IP even when every request carries a new refresh token', async () => {
		const app = express();
		app.use(express.json());
		app.post('/oauth/token', ApiRateLimit.tokenLimiter((request, response, next) => next()), (request, response) => response.json({ ok: true }));
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		const post = body => fetch(`http://127.0.0.1:${server.address().port}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		try {
			for (let index = 0; index < 600; index++) assert.equal((await post({ grant_type: 'refresh_token', refresh_token: 'random-' + index })).status, 200);
			const limited = await post({ grant_type: 'refresh_token', refresh_token: 'random-600' });
			assert.equal(limited.status, 429);
			assert.deepEqual(await limited.json(), { error: 'Too many token refreshes; try again later.' });
			assert.equal((await post({ grant_type: 'authorization_code' })).status, 200);
		} finally { await new Promise(resolve => server.close(resolve)); }
	});
	it('keys the v2 upload bucket on the authenticated user, then credential, then IP', async () => {
		Object.assign(process.env, DEFAULTS, { API_RATE_LIMIT_UPLOAD_PER_MINUTE: '1' });
		const user = request => ApiRateLimit.getUserKey({ headers: {}, ip: '203.0.113.9', ...request });
		assert.notEqual(user({ ctx: { user: 'one' } }), user({ ctx: { user: 'two' } }));
		assert.equal(user({ ctx: { user: 'one' } }), user({ ctx: { user: 'one' }, ip: '198.51.100.1', headers: { authorization: 'Bearer secret' } }));
		assert.equal(user({ headers: { authorization: 'Bearer secret' } }), ApiRateLimit.getRateLimitKey({ headers: { authorization: 'Bearer secret' } }));
		assert.match(user({}), /^typerelay-api:ip:/);
		const app = express();
		app.use(express.json());
		app.use((request, response, next) => { request.ctx = { user: request.headers['x-user'] }; next(); });
		app.post('/api/v2/libraries', ApiRateLimit.createLimiter('api-upload', 1, request => !ApiRateLimit.isBulkLibraryCreate(request), ApiRateLimit.getUserKey), (request, response) => response.json({ ok: true }));
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		const post = (name, body) => fetch(`http://127.0.0.1:${server.address().port}/api/v2/libraries`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': name }, body: JSON.stringify(body) });
		try {
			const bulk = { snippets: [{ id: 'one' }] };
			assert.equal((await post('one', bulk)).status, 200);
			assert.equal((await post('one', bulk)).status, 429);
			assert.equal((await post('two', bulk)).status, 200);
			for (let index = 0; index < 3; index++) assert.equal((await post('one', { name: 'Plain' })).status, 200);
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
