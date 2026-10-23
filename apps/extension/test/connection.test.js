import { test } from 'node:test';
import assert from 'node:assert/strict';

class Fixture {
	static sequence = 0;
	static deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
	static async start() {
		const fixture = new Fixture();
		fixture.data = { tokens: { access_token: 'access', refresh_token: 'refresh', expires_in: 900, obtained_at: Date.now() } };
		fixture.session = {}; fixture.cache = new Map(); fixture.requests = [];
		fixture.snapshot = { protocol: 6, cursor: 1, libraries: [{ _id: 'library', name: 'Private', state: 'active', snippets: [{ id: 'snippet', state: 'active', title: 'Private', content: { type: 'plain_text', text: 'Private text' } }] }] };
		const storage = data => ({ get: async keys => keys === null ? { ...data } : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, data[key]])), set: async values => { if (values.items) await fixture.beforeItems?.(); if (values.tokens) await fixture.beforeTokens?.(); if (Object.keys(values).some(key => key.startsWith('usage-'))) await fixture.beforeUsage?.(); Object.assign(data, values); }, remove: async keys => { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; } });
		globalThis.chrome = { storage: { local: storage(fixture.data), session: storage(fixture.session) }, runtime: { onMessage: { addListener: listener => { fixture.listener = listener; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, getPlatformInfo: async () => ({ os: 'cros' }) }, tabs: { onUpdated: { addListener: listener => { fixture.update = listener; } }, remove: async () => {}, query: async () => [] }, alarms: { onAlarm: { addListener() {} } } };
		globalThis.caches = { delete: async () => { fixture.cache.clear(); }, open: async () => ({ match: async key => fixture.cache.get(key), put: async (key, value) => { await fixture.beforeCache?.(); fixture.cache.set(key, value); }, keys: async () => [...fixture.cache.keys()].map(url => ({ url })), delete: async key => fixture.cache.delete(key) }) };
		globalThis.fetch = async url => {
			fixture.requests.push(url);
			if (url.endsWith('/oauth/token')) return fixture.tokens ? fixture.tokens() : Response.json({ access_token: 'renewed', refresh_token: 'renewed-refresh', expires_in: 900 });
			if (url.endsWith('/connection')) return Response.json({ disconnected: true });
			if (url.includes('/sync?')) return fixture.response ? fixture.response() : Response.json(fixture.snapshot);
			if (url.includes('/assets/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
			throw new Error(url);
		};
		await import(`../worker.js?connection-test=${++Fixture.sequence}`);
		return fixture;
	}
	send(type, data = {}) { return new Promise(resolve => this.listener({ type, ...data }, {}, resolve)); }
	async signedOut() {
		assert.equal(this.data.tokens, undefined);
		assert.equal(this.data.items, undefined);
		assert.equal(this.cache.size, 0);
		assert.deepEqual((await this.send('snapshot')).value.items, []);
		assert.equal((await this.send('prepare', { id: 'snippet' })).ok, false);
	}
}

for (const stage of ['response', 'storage', 'cache']) test(`disconnect invalidates a sync delayed at ${stage}`, async () => {
	const fixture = await Fixture.start();
	const reached = Fixture.deferred(); const release = Fixture.deferred();
	const pause = async () => { reached.resolve(); await release.promise; };
	if (stage === 'response') fixture.response = async () => { await pause(); return Response.json(fixture.snapshot); };
	if (stage === 'storage') fixture.beforeItems = pause;
	if (stage === 'cache') { fixture.snapshot.libraries[0].snippets[0].content.assets = ['a'.repeat(64)]; fixture.beforeCache = pause; }
	const syncing = fixture.send('sync');
	await reached.promise;
	const disconnecting = fixture.send('disconnect');
	if (stage === 'response') { assert.equal((await disconnecting).ok, true); await fixture.signedOut(); }
	else await new Promise(resolve => setImmediate(resolve));
	release.resolve();
	assert.equal((await disconnecting).ok, true);
	await syncing;
	await fixture.signedOut();
});

test('concurrent sync requests share one snapshot instead of overwriting newer data', async () => {
	const fixture = await Fixture.start(); const reached = Fixture.deferred(); const release = Fixture.deferred();
	fixture.response = async () => { reached.resolve(); await release.promise; return Response.json(fixture.snapshot); };
	const first = fixture.send('sync'); await reached.promise; const second = fixture.send('sync');
	release.resolve();
	assert.equal((await first).ok, true); assert.equal((await second).ok, true);
	assert.equal(fixture.requests.filter(url => url.includes('/sync?')).length, 1);
});

for (const status of [200, 401]) test(`old token refresh (${status}) cannot restore or clear a later connection`, async () => {
	const fixture = await Fixture.start(); const reached = Fixture.deferred(); const release = Fixture.deferred();
	fixture.data.tokens.obtained_at = 0;
	let calls = 0;
	fixture.tokens = async () => { if (++calls === 1) { reached.resolve(); await release.promise; return Response.json(status === 200 ? { access_token: 'old', refresh_token: 'old', expires_in: 900 } : { error: 'Expired' }, { status }); } return Response.json({ access_token: 'logout', refresh_token: 'logout', expires_in: 900 }); };
	const syncing = fixture.send('sync'); await reached.promise;
	assert.equal((await fixture.send('disconnect')).ok, true);
	fixture.data.tokens = { access_token: 'new-account', expires_in: 900, obtained_at: Date.now() };
	fixture.data.items = [{ id: 'new-account-snippet' }];
	release.resolve(); await syncing;
	assert.equal(fixture.data.tokens.access_token, 'new-account');
	assert.deepEqual(fixture.data.items, [{ id: 'new-account-snippet' }]);
});

test('disconnect cancels an OAuth exchange already in flight', async () => {
	const fixture = await Fixture.start(); const reached = Fixture.deferred(); const release = Fixture.deferred();
	delete fixture.data.tokens;
	fixture.session.browserAuth = { startedAt: Date.now(), state: 'state', verifier: 'verifier', redirect: 'https://app.typerelay.com/oauth/browser-callback' };
	fixture.tokens = async () => { reached.resolve(); await release.promise; return Response.json({ access_token: 'late-login', expires_in: 900 }); };
	fixture.update(1, { url: 'https://app.typerelay.com/oauth/browser-callback?state=state&code=code' });
	await reached.promise;
	assert.equal((await fixture.send('disconnect')).ok, true);
	release.resolve();
	await new Promise(resolve => setImmediate(resolve));
	await fixture.signedOut();
});

for (const action of ['disconnect', 'cancel-connect']) test(`${action} waits for an already-started OAuth credential write before clearing it`, async () => {
	const fixture = await Fixture.start(); const reached = Fixture.deferred(); const release = Fixture.deferred();
	delete fixture.data.tokens;
	fixture.session.browserAuth = { startedAt: Date.now(), state: 'state', verifier: 'verifier', redirect: 'https://app.typerelay.com/oauth/browser-callback' };
	fixture.beforeTokens = async () => { reached.resolve(); await release.promise; };
	fixture.update(1, { url: 'https://app.typerelay.com/oauth/browser-callback?state=state&code=code' });
	await reached.promise;
	const cancelling = fixture.send(action);
	await new Promise(resolve => setImmediate(resolve));
	release.resolve();
	assert.equal((await cancelling).ok, true);
	await new Promise(resolve => setImmediate(resolve));
	await fixture.signedOut();
});

test('an old denied sync does not clear a new connection', async () => {
	const fixture = await Fixture.start(); const reached = Fixture.deferred(); const release = Fixture.deferred();
	fixture.response = async () => { reached.resolve(); await release.promise; return Response.json({ error: 'Access denied' }, { status: 403 }); };
	const syncing = fixture.send('sync'); await reached.promise;
	await fixture.send('disconnect');
	fixture.data.tokens = { access_token: 'new-account', expires_in: 900, obtained_at: Date.now() };
	release.resolve(); await syncing;
	assert.equal(fixture.data.tokens.access_token, 'new-account');
});

for (const status of [401, 403]) test(`sync ${status} clears credentials only when unauthorized`, async () => {
 const f = await Fixture.start();
 f.data.items = [{id:'cached'}]; f.data['usage-old'] = {identity:{account:'old'}};
 f.response = async () => Response.json({error:'Denied'}, {status});
 assert.equal((await f.send('sync')).ok, false);
 if (status === 401) { await f.signedOut(); assert.equal(f.data['usage-old'], undefined); }
 else { assert.equal(f.data.tokens.access_token,'access'); assert.deepEqual(f.data.items,[{id:'cached'}]); }
});

test('sync removes usage from previous identities and disconnect removes all queued usage', async () => {
 const f = await Fixture.start();
 f.snapshot.statistics_identity = {account:'new',user:'user'};
 f.data['usage-old'] = {identity:{server:'https://app.typerelay.com',account:'old',user:'user'}};
 assert.equal((await f.send('sync')).ok,true); assert.equal(f.data['usage-old'],undefined);
 f.data['usage-new'] = {identity:f.data.statisticsIdentity};
 assert.equal((await f.send('disconnect')).ok,true); assert.equal(f.data['usage-new'],undefined);
});

test('disconnect drains an in-flight usage write before deleting the old queue', async () => {
 const f=await Fixture.start(); const reached=Fixture.deferred(); const release=Fixture.deferred();
 const identity={server:'https://app.typerelay.com',account:'old',user:'user'};f.data.statisticsIdentity=identity;
 f.beforeUsage=async()=>{reached.resolve();await release.promise;};
 const recording=f.send('usage',{event:{event_id:'late',identity,library:'library'}});await reached.promise;
 const disconnecting=f.send('disconnect');await new Promise(resolve=>setImmediate(resolve));release.resolve();
 await recording;assert.equal((await disconnecting).ok,true);assert.equal(f.data['usage-late'],undefined);
});
