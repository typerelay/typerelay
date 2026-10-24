import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { Auth } from '../services/auth.js';
import { Billing } from '../services/billing.js';
import { AdminSettings } from '../services/admin_settings.js';
import { AccountAccess } from '../services/account_access.js';
import { WhiteLabel } from '../services/white_label.js';
import { StorageMigration } from '../services/storage_migration.js';
import { ProductUpdates } from '../services/product_updates.js';
import { PublicApi } from '../api/public.js';
import { SignupNotifications } from '../services/signup_notifications.js';
import { StarterContent } from '../services/starter_content.js';
import { ApiRateLimit } from '../rate_limit.js';
import { mongoose, User, Account, Member, Ticket } from '../model/index.js';

class Fixture {
	static saved = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL, TYPERELAY_HOSTED_EDITION: process.env.TYPERELAY_HOSTED_EDITION, IS_DOCKER: process.env.IS_DOCKER, PORT: process.env.PORT, ENABLE_SIGNUP: process.env.ENABLE_SIGNUP };
	static origin = Auth.origin;
	static user = null;
	static account = null;
	static ticket = null;
	static cookie = '';
	static owner = true;
	static query(value) { const query = { lean: async () => value, session: () => query, select: () => query }; return query; }
	static async http(path, body, csrf, host = 'app.typerelay.com') {
		return new Promise((resolve, reject) => {
			const req = request({ hostname: '127.0.0.1', port: Fixture.server.address().port, path, method: body ? 'POST' : 'GET', headers: { Host: host, 'X-Forwarded-Proto': 'https', Cookie: Fixture.cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } }, res => {
				if (res.headers['set-cookie']) Fixture.cookie = res.headers['set-cookie'][0].split(';')[0];
				let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
			});
			req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
		});
	}
}

before(async () => {
	process.env.NODE_ENV = 'test';
	const { Server } = await import('../app.js');
	process.env.NODE_ENV = 'production'; process.env.APP_URL = Auth.origin = 'https://app.typerelay.com'; process.env.TYPERELAY_HOSTED_EDITION = 'true'; process.env.IS_DOCKER = 'true'; process.env.PORT = '0'; process.env.ENABLE_SIGNUP = 'true';
	mock.method(mongoose, 'connect', async () => {});
	mock.method(mongoose.connection, 'transaction', async callback => callback({}));
	for (const model of Object.values(mongoose.models)) mock.method(model, 'createIndexes', async () => {});
	for (const method of ['code', 'tokens', 'run']) mock.method(StorageMigration, method, async () => {});
	mock.method(ProductUpdates, 'enabled', () => false);
	mock.method(PublicApi, 'mount', async () => {});
	mock.method(ApiRateLimit, 'createLimiter', bucket => Object.assign((req, res, next) => next(), { bucket }));
	mock.method(AccountAccess, 'middleware', (req, res, next) => next());
	mock.method(WhiteLabel, 'resolveRequest', (req, res, next) => { if (req.hostname === 'tenant.example') req.boundAccount = 'tenant'; next(); });
	mock.method(AdminSettings, 'middleware', (req, res, next) => next());
	mock.method(AdminSettings, 'send', async () => {});
	mock.method(Billing, 'initializeAccount', async () => {});
	mock.method(SignupNotifications, 'create', async () => null);
	mock.method(StarterContent, 'create', async () => {});
	mock.method(User, 'updateOne', async () => {});
	mock.method(User, 'findOne', () => Fixture.query(Fixture.user));
	mock.method(User, 'findById', () => Fixture.query(Fixture.user));
	mock.method(User, 'create', async rows => [Fixture.user = { ...rows[0], _id: 'synthetic-user' }]);
	mock.method(Account, 'create', async rows => [Fixture.account = { ...rows[0], _id: 'synthetic-account', is_active: true }]);
	mock.method(Account, 'findOne', () => Fixture.query(Fixture.account));
	mock.method(Account, 'updateOne', async (query, update) => { if (!Fixture.account.acquisition.dispatched_at) Fixture.account.acquisition.dispatched_at = update.$set['acquisition.dispatched_at']; });
	mock.method(Member, 'create', async rows => rows);
	mock.method(Member, 'exists', async () => Fixture.owner);
	mock.method(Ticket, 'create', async rows => { Fixture.ticket = rows[0]; return rows; });
	mock.method(Ticket, 'findOneAndDelete', () => { const ticket = Fixture.ticket; Fixture.ticket = null; return Fixture.query(ticket); });
	const store = new session.MemoryStore(); store.close = () => {};
	mock.method(MongoStore, 'create', () => store);
	Fixture.server = await Server.start();
	if (!Fixture.server.listening) await new Promise(resolve => Fixture.server.once('listening', resolve));
});

after(async () => {
	if (Fixture.server) await new Promise(resolve => Fixture.server.close(resolve));
	mock.restoreAll(); Auth.origin = Fixture.origin;
	for (const [key, value] of Object.entries(Fixture.saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

test('application startup rejects either missing security secret', async () => {
	const { Server } = await import('../app.js');
	for (const name of ['SESSION_SECRET', 'JWT_SECRET']) {
		const saved = process.env[name];
		try { delete process.env[name]; await assert.rejects(Server.start(), new RegExp(name + ' is required')); }
		finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
	}
});

test('API v2 upload and import routes use the API upload limiter', () => {
	const routes = Fixture.server.listeners('request')[0].router.stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods), buckets: layer.route.stack.map(entry => entry.handle.bucket).filter(Boolean) }));
	const limited = ['/api/v2/assets', '/api/v2/assets/remote', '/api/v2/assets/:id/refresh', '/api/v2/import/bundle', '/api/v2/import/:format/preview', '/api/v2/import/preview', '/api/v2/import/:format'];
	for (const path of limited) assert.deepEqual(routes.find(route => route.path === path && route.methods.includes('post'))?.buckets, ['api-upload'], path);
	assert.deepEqual(routes.find(route => route.path === '/api/v2/libraries' && route.methods.includes('get')).buckets, []);
	assert.deepEqual(routes.find(route => route.path === '/api/v2/libraries' && route.methods.includes('post')).buckets, ['api-upload']);
	assert.deepEqual(routes.find(route => route.path === '/api/v2/assets/:id' && route.methods.includes('put')).buckets, ['api-asset-put']);
	for (const path of ['/api/v2/sync', '/api/v2/library-view/:id', '/api/v2/assets/presence', '/api/v2/snippets/batch', '/api/v2/libraries/:id/snippets', '/api/v2/statistics/events']) assert.deepEqual(routes.find(route => route.path === path)?.buckets, [], path);
});

test('Ads are restricted to canonical hosted production and attribution is allowlisted', () => {
	assert.equal(Auth.adsEnabled({ hostname: 'app.typerelay.com' }), true);
	for (const req of [{ hostname: 'tenant.example' }, { hostname: 'app.typerelay.com', boundAccount: 'tenant' }]) assert.equal(Auth.adsEnabled(req), false);
	process.env.NODE_ENV = 'development'; assert.equal(Auth.adsEnabled(), false); process.env.NODE_ENV = 'production';
	Auth.origin = 'https://selfhost.example'; assert.equal(Auth.adsEnabled(), false); Auth.origin = 'https://app.typerelay.com';
	assert.deepEqual(Auth.attribution({ gclid: 'synthetic-click', email: 'private@example.test', token: 'secret', gbraid: ['array'], wbraid: 'bad&value', utm_source: '  google\n', matchtype: 'e', device: 'c', landing_path: '/pricing/?token=secret#hash' }), { gclid: 'synthetic-click', utm_source: 'google', matchtype: 'e', device: 'c', landing_path: '/pricing/' });
	assert.equal(Account.schema.path('acquisition').options.select, false);
});

test('signup carries attribution through confirmation, strips tokens, and acknowledges only the owner once', async () => {
	const signup = await Fixture.http('/signup?gclid=synthetic-click&utm_source=google&email=private%40example.test');
	assert.equal(signup.status, 200);
	const csrf = signup.text.match(/name="csrf-token" content="([^"]+)"/)[1];
	assert.doesNotMatch(signup.text, /googletagmanager|signup-conversion\.js/);
	const submitted = await Fixture.http('/auth/signup', { email: 'synthetic@example.test', name: 'Synthetic' }, csrf);
	assert.equal(submitted.status, 200, submitted.text);
	assert.equal(Fixture.account, null, 'submitting signup must not create a conversion');
	assert.deepEqual(Fixture.ticket.data.acquisition, { gclid: 'synthetic-click', utm_source: 'google' });
	const callback = await Fixture.http('/auth/callback?token=synthetic-email-token');
	assert.equal(callback.headers.location, '/auth/confirmed');
	assert.equal(callback.headers['referrer-policy'], 'no-referrer');
	const id = Fixture.account.acquisition.transaction_id;
	assert.match(id, /^typerelay-signup-[a-f0-9-]+$/);
	assert.ok(Fixture.account.acquisition.confirmed_at instanceof Date);
	const clean = await Fixture.http('/auth/confirmed?token=synthetic-email-token&email=private%40example.test');
	assert.equal(clean.headers.location, '/auth/confirmed?gclid=synthetic-click');
	const confirmed = await Fixture.http(clean.headers.location);
	assert.equal(confirmed.status, 200);
	assert.match(confirmed.text, /signup-conversion\.js/);
	assert.match(confirmed.text, new RegExp(id));
	assert.doesNotMatch(confirmed.text, /synthetic-email-token|private@example|synthetic@example/);
	assert.equal(confirmed.headers['cache-control'], 'no-store');
	assert.match(confirmed.headers['content-security-policy'], /connect-src[^;]*https:\/\/ad\.doubleclick\.net/);
	const confirmedCsrf = confirmed.text.match(/name="csrf-token" content="([^"]+)"/)[1];
	assert.equal((await Fixture.http('/auth/confirmed', { transaction_id: id })).status, 403);
	assert.equal((await Fixture.http('/auth/confirmed', { transaction_id: 'wrong' }, confirmedCsrf)).status, 403);
	Fixture.owner = false; assert.equal((await Fixture.http('/auth/confirmed', { transaction_id: id }, confirmedCsrf)).status, 403); Fixture.owner = true;
	assert.equal((await Fixture.http('/auth/confirmed', { transaction_id: id }, confirmedCsrf, 'tenant.example')).status, 403);
	assert.equal((await Fixture.http('/auth/confirmed', { transaction_id: id }, confirmedCsrf)).status, 200);
	const dispatched = Fixture.account.acquisition.dispatched_at;
	assert.equal((await Fixture.http('/auth/confirmed', { transaction_id: id }, confirmedCsrf)).status, 200);
	assert.equal(Fixture.account.acquisition.dispatched_at, dispatched);
	assert.equal((await Fixture.http(clean.headers.location)).headers.location, '/');
	Fixture.cookie = ''; assert.equal((await Fixture.http(clean.headers.location)).headers.location, '/');
	await Auth.login('synthetic@example.test');
	const repeat = await Fixture.http('/auth/callback?token=repeat-login-token');
	assert.equal(repeat.headers.location, '/', 'existing-user login must not emit another signup');
	assert.equal(Fixture.account.acquisition.transaction_id, id);
});

test('self-hosted account creation has no Ads metadata', async () => {
	Fixture.user = null; Fixture.account = null; Auth.origin = 'https://selfhost.example';
	try {
		await Auth.login('selfhost@example.test', 'Self host', { acquisition: { gclid: 'synthetic-click' } });
		assert.equal(Fixture.ticket.data.acquisition, undefined);
		const result = await Auth.consume('synthetic-token', true);
		assert.equal(Fixture.account.acquisition, undefined); assert.equal(result.signup_account, undefined);
	} finally { Auth.origin = 'https://app.typerelay.com'; }
});

test('conversion script dispatches an opaque ID and never blocks navigation on Google or acknowledgement failure', async () => {
	const source = await readFile(new URL('../public/signup-conversion.js', import.meta.url), 'utf8');
	for (const outcome of ['success', 'blocked', 'timeout', 'ack-failure', 'development']) {
		const tags = []; const scripts = []; const calls = []; const redirects = [];
		const link = { href: 'https://app.typerelay.com/', dataset: { transactionId: 'synthetic-transaction', sendTo: Auth.adsDestination } };
		let timer;
		const context = { window: { dataLayer: tags }, location: { origin: outcome === 'development' ? 'https://tr.n.lan' : 'https://app.typerelay.com', pathname: '/auth/confirmed', replace: url => redirects.push(url) }, document: { querySelector: selector => selector === '#signup-continue' ? link : { content: 'synthetic-csrf' }, createElement: () => ({}), head: { appendChild: script => scripts.push(script) } }, setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => {}, fetch: async (url, options) => { calls.push({ url, options }); if (outcome === 'ack-failure') throw new Error('offline'); } };
		runInNewContext(source, context);
		if (outcome === 'development') { assert.equal(tags.length, 0); assert.equal(scripts.length, 0); continue; }
		const event = tags.find(args => args[0] === 'event');
		assert.equal(event[2].transaction_id, 'synthetic-transaction'); assert.equal(event[2].send_to, Auth.adsDestination); assert.equal(event[2].page_referrer, '');
		if (outcome === 'blocked') scripts[0].onerror();
		else if (outcome === 'timeout') timer();
		else { event[2].event_callback(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls[0].options.headers['X-CSRF-Token'], 'synthetic-csrf'); assert.equal(calls[0].options.body, '{"transaction_id":"synthetic-transaction"}'); }
		assert.deepEqual(redirects, [link.href]);
		timer(); event[2].event_callback(); assert.equal(redirects.length, 1);
	}
});
