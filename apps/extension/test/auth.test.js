import { test } from 'node:test';
import assert from 'node:assert/strict';

test('browser sign-in opens a regular tab and captures a matching callback after Magic Link', async () => {
	const values = () => {
		const data = {};
		return { get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, data[key]])), set: async entries => Object.assign(data, entries), remove: async keys => { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; } };
	};
	const local = values();
	const session = values();
	const tabs = [];
	const removed = [];
	let messageListener;
	let updateListener;
	const origin = 'https://app.typerelay.com';
	globalThis.chrome = { storage: { local, session }, runtime: { onMessage: { addListener: listener => { messageListener = listener; } }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, getPlatformInfo: async () => ({ os: 'cros' }) }, tabs: { create: async details => { tabs.push({ id: 10, ...details }); return tabs[0]; }, query: async () => tabs.filter(tab => tab.url.startsWith(`${origin}/oauth/browser-callback`)), remove: async id => { removed.push(id); tabs.splice(tabs.findIndex(tab => tab.id === id), 1); }, onUpdated: { addListener: listener => { updateListener = listener; } } }, alarms: { create: () => {}, onAlarm: { addListener: () => {} } } };
	globalThis.caches = { open: async () => ({ keys: async () => [] }), delete: async () => true };
	globalThis.fetch = async url => {
		if (url === `${origin}/oauth/token`) return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 900, account: 'account' });
		if (url === `${origin}/api/v2/sync?cursor=0`) return Response.json({ protocol: 6, cursor: 'snapshot', libraries: [] });
		throw new Error(`Unexpected request: ${url}`);
	};
	await import(`../worker.js?auth-test=${Date.now()}`);
	const send = type => new Promise(resolve => messageListener({ type }, {}, resolve));
	assert.deepEqual((await send('connect')).value, { pending: true });
	assert.equal(tabs.length, 1);
	const authorize = new URL(tabs[0].url);
	assert.equal(authorize.origin, origin);
	assert.equal(authorize.pathname, '/oauth/authorize');
	assert.equal(authorize.searchParams.get('redirect_uri'), `${origin}/oauth/browser-callback`);
	assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
	const state = authorize.searchParams.get('state');
	const callback = `${origin}/oauth/browser-callback?code=one-time-code&state=${state}`;
	updateListener(11, { url: `${origin}/oauth/browser-callback?code=wrong&state=wrong` });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal((await local.get('tokens')).tokens, undefined);
	tabs.push({ id: 11, url: callback });
	updateListener(11, { url: callback });
	assert.equal((await send('status')).value.connected, true);
	assert.equal((await local.get('tokens')).tokens.access_token, 'access');
	assert.deepEqual(removed, [11]);
	assert.equal((await session.get('browserAuth')).browserAuth, undefined);
});
