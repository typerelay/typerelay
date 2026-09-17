import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import MongoStore from 'connect-mongo';
import { mongoose, User, Account, Member, Device } from '../model/index.js';
import { Auth } from '../services/auth.js';
import { Support } from '../services/support.js';

class Fixture {
	static server; static store; static collection; static writes; static origin; static user;
	static async call(store, method, ...args) { return new Promise((resolve, reject) => store[method](...args, (error, result) => error ? reject(error) : resolve(result))); }
	static async request(path, cookie = '') { const response = await fetch(Fixture.origin + path, { headers: { Cookie: cookie } }); await response.text(); return response; }
	static async session() {
		const response = await Fixture.request('/__session-test/read');
		const cookie = response.headers.get('set-cookie').split(';')[0];
		const sid = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
		const session = await Fixture.call(Fixture.store, 'get', sid);
		session.user = String(Fixture.user._id); session.auth_version = 0; session.auth_at = Date.now();
		await Fixture.call(Fixture.store, 'set', sid, session);
		Fixture.writes.mock.resetCalls();
		return { cookie, sid, response };
	}
}

before(async () => {
	process.env.NODE_ENV = 'test'; process.env.PORT = '0';
	process.env.MONGO_URI = process.env.MONGO_URI.replace('/typerelay?', '/typerelay_session_test?');
	assert.match(process.env.MONGO_URI, /\/typerelay_session_test\?/);
	Auth.origin = 'http://127.0.0.1';
	const create = MongoStore.create;
	const capture = mock.method(MongoStore, 'create', options => { Fixture.store = create(options); return Fixture.store; });
	const { Server } = await import('../app.js');
	Fixture.server = await Server.start(); capture.mock.restore();
	if (!Fixture.server.listening) await new Promise(resolve => Fixture.server.once('listening', resolve));
	Fixture.origin = `http://127.0.0.1:${Fixture.server.address().port}`; Auth.origin = Fixture.origin;
	Fixture.collection = await Fixture.store.collectionP;
	Fixture.writes = mock.method(Fixture.collection, 'updateOne');
	Fixture.user = await User.create({ email: randomUUID() + '@example.test', name: 'Session regression' });
	const app = Fixture.server.listeners('request')[0];
	app.get('/__session-test/read', (req, res) => res.json({ ok: true }));
	app.get('/__session-test/change', (req, res) => { req.session.preference = 'changed'; res.json({ ok: true }); });
	app.get('/__session-test/save', (req, res, next) => req.session.save(error => error ? next(error) : res.json({ ok: true })));
});
after(async () => {
	Fixture.writes?.mock.restore();
	if (Fixture.server) await new Promise(resolve => Fixture.server.close(resolve));
	if (mongoose.connection.name === 'typerelay_session_test') await mongoose.connection.dropDatabase();
	await mongoose.disconnect(); mock.restoreAll();
});

test('health probes do not create sessions or write cookies', async () => {
	const before = await Fixture.collection.countDocuments(); Fixture.writes.mock.resetCalls();
	for (let index = 0; index < 3; index++) {
		const response = await Fixture.request('/health');
		assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
	}
	assert.equal(Fixture.writes.mock.callCount(), 0); assert.equal(await Fixture.collection.countDocuments(), before);
});

test('bearer API and token requests stay stateless while browser CSRF remains required', async () => {
	const account = await Account.create({ name: 'Bearer session account' });
	await Member.create({ account: account._id, user: Fixture.user._id, role: 'owner' });
	const token = Support.token();
	await Device.create({ account: account._id, user: Fixture.user._id, name: 'Session regression', access: Support.hash(token), access_expires: new Date(Date.now() + 900000), refresh: Support.hash(Support.token()), refresh_expires: new Date(Date.now() + 86400000) });
	const before = await Fixture.collection.countDocuments(); Fixture.writes.mock.resetCalls();
	for (const value of [token, 'invalid']) {
		const response = await fetch(Fixture.origin + '/api/v2/libraries', { headers: { Authorization: `Bearer ${value}`, 'X-Typerelay-Sync-Protocol': '6' } });
		await response.text(); assert.equal(response.status, value === token ? 200 : 401); assert.equal(response.headers.get('set-cookie'), null);
	}
	const publicApi = await fetch(Fixture.origin + '/api/v3/libraries', { headers: { Authorization: 'Bearer invalid' } });
	await publicApi.text(); assert.equal(publicApi.status, 401); assert.equal(publicApi.headers.get('set-cookie'), null);
	for (const path of ['/oauth/token', '/integrations/token', '/integrations/register']) {
		const response = await fetch(Fixture.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		await response.text(); assert.ok(response.status >= 400 && response.status < 500); assert.equal(response.headers.get('set-cookie'), null);
	}
	assert.equal(Fixture.writes.mock.callCount(), 0); assert.equal(await Fixture.collection.countDocuments(), before);
	const { cookie } = await Fixture.session();
	const forbidden = await fetch(Fixture.origin + '/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
	await forbidden.text(); assert.equal(forbidden.status, 403);
});

test('unchanged authenticated requests avoid writes on either replica and retain non-rolling browser expiry', async () => {
	const { cookie, sid, response } = await Fixture.session();
	assert.equal(Fixture.store.options.touchAfter, 60);
	assert.match(response.headers.get('set-cookie'), /HttpOnly/);
	assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
	const before = await Fixture.collection.findOne({ _id: sid });
	assert.ok(Math.abs(before.expires.getTime() - Date.now() - 7 * 86400000) < 5000);
	for (const result of await Promise.all(Array.from({ length: 8 }, () => Fixture.request('/__session-test/read', cookie)))) {
		assert.equal(result.status, 200); assert.equal(result.headers.get('set-cookie'), null);
	}
	const replica = MongoStore.create({ client: await Fixture.store.clientP, collectionName: 'web_sessions', touchAfter: 60, autoRemove: 'disabled' });
	const replicaWrites = mock.method(await replica.collectionP, 'updateOne');
	await Fixture.call(replica, 'touch', sid, await Fixture.call(replica, 'get', sid));
	assert.equal(replicaWrites.mock.callCount(), 0); replicaWrites.mock.restore();
	assert.equal(Fixture.writes.mock.callCount(), 0);
	assert.deepEqual(await Fixture.collection.findOne({ _id: sid }), before);
});

test('due requests refresh metadata only; migration sessions acquire a throttle timestamp', async () => {
	const { cookie, sid } = await Fixture.session();
	await Fixture.collection.updateOne({ _id: sid }, { $unset: { lastModified: '' }, $set: { expires: new Date(Date.now() + 3600000) } });
	const before = await Fixture.collection.findOne({ _id: sid }); Fixture.writes.mock.resetCalls();
	assert.equal((await Fixture.request('/__session-test/read', cookie)).headers.get('set-cookie'), null);
	const refreshed = await Fixture.collection.findOne({ _id: sid });
	assert.equal(refreshed.session, before.session);
	assert.ok(refreshed.expires > before.expires); assert.ok(refreshed.lastModified instanceof Date);
	assert.equal(Fixture.writes.mock.callCount(), 1);
	await Fixture.request('/__session-test/read', cookie); assert.equal(Fixture.writes.mock.callCount(), 1);
	await Fixture.collection.updateOne({ _id: sid }, { $set: { lastModified: new Date(Date.now() - 61000) } });
	Fixture.writes.mock.resetCalls(); await Fixture.request('/__session-test/read', cookie);
	assert.equal(Fixture.writes.mock.callCount(), 1);
	assert.deepEqual(Object.keys(Fixture.writes.mock.calls[0].arguments[1]), ['$max']);
});

test('switching account context preserves authentication without session writes', async () => {
	const { cookie, sid } = await Fixture.session();
	const accounts = await Account.create([{ name: 'First session account' }, { name: 'Second session account' }]);
	await Member.create(accounts.map(account => ({ account: account._id, user: Fixture.user._id, role: 'owner' })));
	for (const account of [...accounts, accounts[0]]) {
		const response = await fetch(Fixture.origin + '/api/v2/libraries', { headers: { Cookie: cookie, 'X-Account-Id': String(account._id) } });
		await response.text(); assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
	}
	assert.equal(Fixture.writes.mock.callCount(), 0);
	assert.equal((await Fixture.call(Fixture.store, 'get', sid)).user, String(Fixture.user._id));
});

test('actual changes and explicit saves persist immediately without duplicate full saves', async () => {
	const { cookie, sid } = await Fixture.session();
	const changed = await Fixture.request('/__session-test/change', cookie);
	assert.equal(changed.status, 200); assert.ok(changed.headers.get('set-cookie'));
	assert.equal(Fixture.writes.mock.callCount(), 1);
	assert.equal((await Fixture.call(Fixture.store, 'get', sid)).preference, 'changed');
	Fixture.writes.mock.resetCalls();
	const saved = await Fixture.request('/__session-test/save', cookie);
	assert.equal(saved.status, 200); assert.equal(saved.headers.get('set-cookie'), null);
	assert.equal(Fixture.writes.mock.callCount(), 1);
	assert.equal(JSON.parse((await Fixture.collection.findOne({ _id: sid })).session).lastModified, undefined);
});

test('out-of-order replica touches preserve newer expiry and authentication data', async () => {
	const { sid } = await Fixture.session();
	const replica = MongoStore.create({ client: await Fixture.store.clientP, collectionName: 'web_sessions', touchAfter: 60, autoRemove: 'disabled' });
	const stale = await Fixture.call(replica, 'get', sid);
	stale.lastModified = new Date(Date.now() - 61000); stale.cookie.expires = new Date(Date.now() + 3600000);
	const fresh = await Fixture.call(Fixture.store, 'get', sid);
	fresh.auth_version = 7; fresh.permissions = ['updated']; fresh.cookie.expires = new Date(Date.now() + 8 * 86400000);
	await Fixture.call(Fixture.store, 'set', sid, fresh);
	const before = await Fixture.collection.findOne({ _id: sid });
	await Promise.all(Array.from({ length: 8 }, () => Fixture.call(replica, 'touch', sid, structuredClone(stale))));
	const after = await Fixture.collection.findOne({ _id: sid });
	assert.equal(after.session, before.session); assert.deepEqual(after.expires, before.expires);
	assert.ok(after.lastModified >= before.lastModified);
	await Fixture.call(replica, 'touch', sid, await Fixture.call(replica, 'get', sid));
	assert.deepEqual(await Fixture.collection.findOne({ _id: sid }), after);
});

test('logout deletes the session and a delayed touch cannot recreate it', async () => {
	const { cookie, sid } = await Fixture.session();
	const stale = await Fixture.call(Fixture.store, 'get', sid); stale.lastModified = new Date(Date.now() - 61000);
	const response = await fetch(Fixture.origin + '/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': stale.csrf } });
	await response.text(); assert.equal(response.status, 200);
	await assert.rejects(Fixture.call(Fixture.store, 'touch', sid, stale), /Unable to find the session/);
	assert.equal(await Fixture.collection.findOne({ _id: sid }), null);
});

test('store failures reach callbacks and do not advance the retry throttle', async () => {
	const { sid } = await Fixture.session();
	const stale = await Fixture.call(Fixture.store, 'get', sid); stale.lastModified = new Date(Date.now() - 61000);
	const before = await Fixture.collection.findOne({ _id: sid });
	Fixture.writes.mock.mockImplementationOnce(async () => { throw new Error('database unavailable'); });
	await assert.rejects(Fixture.call(Fixture.store, 'touch', sid, stale), /database unavailable/);
	assert.deepEqual(await Fixture.collection.findOne({ _id: sid }), before);
	Fixture.writes.mock.mockImplementationOnce(async () => { throw new Error('database unavailable'); });
	await assert.rejects(Fixture.call(Fixture.store, 'set', sid, stale), /database unavailable/);
	const reads = mock.method(Fixture.collection, 'findOne');
	reads.mock.mockImplementationOnce(async () => { throw new Error('database unavailable'); });
	await assert.rejects(Fixture.call(Fixture.store, 'get', sid), /database unavailable/);
	reads.mock.restore();
	await Fixture.call(Fixture.store, 'touch', sid, stale);
	assert.ok((await Fixture.collection.findOne({ _id: sid })).lastModified > before.lastModified);
});

test('expired sessions are rejected and security deadlines do not renew on a touch', async () => {
	const { cookie, sid } = await Fixture.session();
	const data = await Fixture.call(Fixture.store, 'get', sid);
	data.admin = { expires: Date.now() - 1000, fingerprint: 'expired' }; data.auth_at = Date.now() - 16 * 60000;
	await Fixture.call(Fixture.store, 'set', sid, data);
	await Fixture.collection.updateOne({ _id: sid }, { $set: { lastModified: new Date(Date.now() - 61000) } });
	assert.equal((await Fixture.request('/__session-test/read', cookie)).status, 200);
	const after = await Fixture.call(Fixture.store, 'get', sid);
	assert.deepEqual(after.admin, data.admin); assert.equal(after.auth_at, data.auth_at);
	assert.equal((await Fixture.request('/admin/api/accounts', cookie)).status, 401);
	await Fixture.collection.updateOne({ _id: sid }, { $set: { expires: new Date(Date.now() - 1000) } });
	assert.equal(await Fixture.call(Fixture.store, 'get', sid), null);
});

test('CommonJS dependency entry point has the same migration and monotonic-touch fixes', async () => {
	const CommonStore = createRequire(import.meta.url)('connect-mongo').default;
	const replica = CommonStore.create({ client: await Fixture.store.clientP, collectionName: 'web_sessions', touchAfter: 60, autoRemove: 'disabled' });
	const { sid } = await Fixture.session();
	const session = await Fixture.call(replica, 'get', sid); const modified = session.lastModified;
	await Fixture.call(replica, 'set', sid, session); assert.deepEqual(session.lastModified, modified);
	const before = await Fixture.collection.findOne({ _id: sid });
	delete session.lastModified; session.cookie.expires = new Date(Date.now() + 1000);
	await Fixture.collection.updateOne({ _id: sid }, { $unset: { lastModified: '' } });
	await Fixture.call(replica, 'touch', sid, session);
	const after = await Fixture.collection.findOne({ _id: sid });
	assert.deepEqual(after.expires, before.expires); assert.ok(after.lastModified instanceof Date);
});
