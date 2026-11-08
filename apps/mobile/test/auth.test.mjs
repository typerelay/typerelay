import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export class Auth', 'globalThis.Auth = class Auth').replaceAll('import.meta.env.BASE_URL', "'/'"));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
 const storage = new Map([['pending', { server: 'https://old.test', state: 'expected', verifier: 'verifier', created: Date.now() }]]);
 const requests = []; const actions = []; const events = []; const revocations = []; const opened = [];
 const context = { Preview: { enabled: false }, SecureStorage: { get: async key => storage.get(key) ?? null, set: async (key, value) => storage.set(key, value), remove: async key => storage.delete(key) }, Native: { call: async action => { events.push(action); actions.push(action); }, plugin: { authenticate: async options => { opened.push(options); return {}; }, cancelAuthentication: async () => { events.push('cancel'); } } }, Capacitor: { getPlatform: () => 'android' }, Browser: { open: async options => { opened.push(options); }, close: async () => { events.push('close'); } }, CapacitorHttp: { post: () => new Promise(resolve => requests.push(resolve)), delete: async request => { revocations.push(request); return { status: 200 }; } }, URL, Date, console };
 vm.createContext(context); vm.runInContext(source, context);
 return Object.assign(context, { storage, requests, actions, events, revocations, opened });
}
const tokens = { access_token: 'access', refresh_token: 'refresh', account: 'old', expires_in: 900, obtained_at: 0 };
const callback = 'com.typerelay.mobile://oauth/callback?state=expected&code=code';

test('a delayed mobile sign-in cannot bind or restore credentials after sign-out', async () => {
 const f = fixture(); const pending = assert.rejects(f.Auth.complete(callback), /Connection changed/); await tick();
 await f.Auth.clear(); await f.Native.call('reset');
 f.requests[0]({ status: 200, data: tokens }); await pending;
 assert.equal(f.Auth.tokens, null); assert.equal(f.storage.has('tokens'), false); assert.deepEqual(f.actions, ['reset']); assert.equal(f.revocations.length, 1); assert.deepEqual(f.events, ['close', 'reset']);
});

for (const boundary of ['bind', 'tokens']) test('sign-out drains an in-flight ' + boundary + ' write before native reset', async () => {
 const f = fixture(); let release; const paused = new Promise(resolve => { release = resolve; });
 if (boundary === 'bind') f.Native.call = async action => { f.actions.push(action); if (action === 'bind') await paused; };
 else { const set = f.SecureStorage.set; f.SecureStorage.set = async (key, value) => { if (key === 'tokens') await paused; return set(key, value); }; }
 const pending = assert.rejects(f.Auth.complete(callback), /Connection changed/); await tick(); f.requests[0]({ status: 200, data: tokens }); await tick();
 let finished = false; const clear = f.Auth.clear().then(async () => { await f.Native.call('reset'); finished = true; }); await tick(); assert.equal(finished, false);
 release(); await pending; await clear;
 assert.equal(f.Auth.tokens, null); assert.equal(f.storage.has('tokens'), false); assert.equal(f.storage.has('server'), false); assert.equal(f.actions.at(-1), 'reset');
});

for (const status of [200, 401]) test('stale refresh ' + status + ' cannot modify the next mobile account', async () => {
 const f = fixture(); f.Auth.tokens = tokens; f.Auth.server = 'https://old.test';
 const pending = assert.rejects(f.Auth.access(), /Connection changed/); await tick(); await f.Auth.clear();
 await f.Auth.save({ ...tokens, account: 'new' }); f.Auth.server = 'https://new.test';
 f.requests[0]({ status, data: tokens }); await pending;
 assert.equal(f.Auth.tokens.account, 'new'); assert.equal(f.storage.get('tokens').account, 'new'); assert.deepEqual(f.actions, []);
});

test('ordinary sign-in still binds and persists credentials', async () => {
 const f = fixture(); const pending = f.Auth.complete(callback); await tick(); f.requests[0]({ status: 200, data: tokens }); await pending;
 assert.equal(f.Auth.tokens.account, 'old'); assert.equal(f.Auth.server, 'https://old.test'); assert.equal(f.storage.has('pending'), false); assert.deepEqual(f.actions, ['bind']); assert.deepEqual(f.events, ['close', 'bind']);
});

test('preview reset uses the captured credential after storage is cleared', async () => {
 const code = stripTypeScriptTypes(readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export class Preview', 'globalThis.Preview = class Preview').replaceAll('import.meta.env.BASE_URL', "'/'").replaceAll('import.meta.env.VITE_MOBILE_PREVIEW', "'true'").replaceAll('import.meta.env.VITE_PREVIEW_API_ORIGIN', "'https://server.test'"));
 const requests = []; const context = { WebPlugin: class {}, Capacitor: { isNativePlatform: () => false }, SecureStorage: { get: async () => null }, localStorage: { getItem: () => 'test-client' }, fetch: async (url, options) => { requests.push(options); return { ok: true, json: async () => ({}) }; } };
 vm.createContext(context); vm.runInContext(code, context);
 await new context.Preview().execute({ request: JSON.stringify({ action: 'reset', access_token: 'captured' }) });
 assert.equal(requests[0].headers.Authorization, 'Bearer captured');
});

for (const status of [200, 401]) test('same-account reconnect rejects an earlier refresh ' + status, async () => {
 const f = fixture(); f.Auth.tokens = tokens; f.Auth.server = 'https://old.test';
 const old = assert.rejects(f.Auth.access(), /Connection changed/); await tick();
 const login = f.Auth.complete(callback); await tick();
 f.requests[1]({ status: 200, data: { ...tokens, access_token: 'new-access' } }); await login;
 f.requests[0]({ status, data: tokens }); await old;
 assert.equal(f.Auth.tokens.access_token, 'new-access'); assert.equal(f.storage.get('tokens').access_token, 'new-access'); assert.deepEqual(f.actions, ['bind']);
});

test('reconnect waits for an earlier credential write and prevents it replacing the new login', async () => {
 const f = fixture(); f.Auth.tokens = tokens; let release; const paused = new Promise(resolve => { release = resolve; }); const set = f.SecureStorage.set;
 f.SecureStorage.set = async (key, value) => { if (key === 'tokens' && value.access_token === 'access') await paused; return set(key, value); };
 const old = f.Auth.access(); await tick(); f.requests[0]({ status: 200, data: tokens }); await tick();
 const login = f.Auth.complete(callback); await tick(); f.requests[1]({ status: 200, data: { ...tokens, access_token: 'new-access' } }); await tick();
 assert.deepEqual(f.actions, []); release(); await old; await login;
 assert.equal(f.storage.get('tokens').access_token, 'new-access'); assert.equal(f.Auth.tokens.access_token, 'new-access');
});

test('successful callback invokes onLogin and releases the completion job after generation changes', async () => {
 const f = fixture(); let handle; let logins = 0;
 f.App = { addListener: async (event, listener) => { handle = listener; }, getLaunchUrl: async () => null }; f.SecureStorage.setKeyPrefix = async () => {};
 await f.Auth.initialize(async () => { logins++; }); handle({ url: callback }); await tick(); f.requests[0]({ status: 200, data: tokens }); await f.Auth.completing;
 assert.equal(logins, 1); assert.equal(f.Auth.completing, null); assert.equal(f.Auth.completed.has(callback), true);
});

for (const boundary of ['server', 'tokens']) for (const status of [200, 401]) test('refresh started during reconnect ' + boundary + ' write cannot change the new session: ' + status, async () => {
 const f = fixture(); f.Auth.tokens = tokens; f.Auth.server = 'https://old.test'; let release; const paused = new Promise(resolve => { release = resolve; }); const set = f.SecureStorage.set;
 f.SecureStorage.set = async (key, value) => { if (key === boundary) await paused; return set(key, value); };
 const login = f.Auth.complete(callback); await tick(); f.requests[0]({ status: 200, data: { ...tokens, access_token: 'new-access' } }); await tick();
 const old = assert.rejects(f.Auth.access(), /Connection changed/); await tick(); release(); await login;
 f.requests[1]({ status, data: tokens }); await old;
 assert.equal(f.Auth.tokens.access_token, 'new-access'); assert.equal(f.storage.get('tokens').access_token, 'new-access'); assert.deepEqual(f.actions, ['bind']);
});

for (const value of [
 'https://unrelated.test/oauth/callback?state=expected&code=code',
 callback.replace('state=expected', 'state=wrong'),
 callback + '&state=expected', callback + '&code=other',
 callback.replace('&code=code', ''), callback + '&error=access_denied',
 callback + '#fragment'
]) test('invalid callback leaves the browser and pending sign-in untouched: ' + value, async () => {
 const f = fixture(); await assert.rejects(f.Auth.complete(value));
 assert.deepEqual(f.events, []); assert.equal(f.requests.length, 0); assert.equal(f.storage.has('pending'), true);
});

test('native bind failure is visible after browser dismissal and a fresh sign-in can retry', async () => {
 const f = fixture(); let handle; const errors = []; let logins = 0;
 f.App = { addListener: async (_, listener) => { handle = listener; }, getLaunchUrl: async () => null }; f.SecureStorage.setKeyPrefix = async () => {};
 f.Auth.onError = error => { f.events.push('error'); errors.push(error); };
 const call = f.Native.call; f.Native.call = async action => { await call(action); throw new Error('Storage permission denied'); };
 await f.Auth.initialize(async () => { logins++; }); handle({ url: callback }); await tick();
 f.requests[0]({ status: 200, data: tokens }); await tick();
 assert.deepEqual(f.events, ['close', 'bind', 'error']); assert.match(errors[0].message, /Storage permission/);
 assert.equal(f.Auth.completing, null); assert.equal(f.Auth.completed.has(callback), false); assert.equal(logins, 0);
 assert.equal(f.storage.has('pending'), false); assert.equal(f.storage.has('server'), false); assert.equal(f.storage.has('tokens'), false); assert.equal(f.Auth.tokens, null);
 assert.equal(f.revocations.length, 1); assert.equal(f.revocations[0].headers.Authorization, 'Bearer access');
 f.Native.call = call;
 f.crypto = globalThis.crypto; f.btoa = btoa; f.Uint8Array = Uint8Array; f.TextEncoder = TextEncoder; f.URLSearchParams = URLSearchParams; f.Capacitor = { getPlatform: () => 'ios' }; f.Browser.open = async () => {};
 await f.Auth.begin('https://old.test'); const pending = f.storage.get('pending'); assert.notEqual(pending.state, 'expected');
 const retry = 'com.typerelay.mobile://oauth/callback?state=' + pending.state + '&code=fresh';
 handle({ url: retry }); await tick(); f.requests[1]({ status: 200, data: tokens }); await f.Auth.completing;
 assert.equal(logins, 1); assert.equal(f.Auth.tokens.account, 'old'); assert.equal(f.storage.has('pending'), false);
});

for (const boundary of ['server', 'tokens', 'pending']) for (const reconnect of [false, true]) test('failed finalization restores credentials at ' + boundary + ', reconnect=' + reconnect, async () => {
 const f = fixture(); if (reconnect) { f.Auth.server = 'https://old.test'; f.Auth.tokens = tokens; f.storage.set('server', f.Auth.server); f.storage.set('tokens', tokens); }
 const method = boundary === 'pending' ? 'remove' : 'set'; const original = f.SecureStorage[method]; let fail = true;
 f.SecureStorage[method] = async (key, value) => { await original(key, value); if (key === boundary && fail) { fail = false; throw new Error('Secure storage failure'); } };
 const login = assert.rejects(f.Auth.complete(callback), /Secure storage failure/); await tick(); f.requests[0]({ status: 200, data: { ...tokens, access_token: 'new-access' } }); await login;
 assert.deepEqual(f.events, ['close', 'bind']); assert.equal(f.storage.has('pending'), false); assert.equal(f.revocations.length, 1);
 assert.equal(f.storage.get('tokens')?.access_token, reconnect ? 'access' : undefined); assert.equal(f.storage.get('server'), reconnect ? 'https://old.test' : undefined);
 assert.equal(f.Auth.tokens?.access_token, reconnect ? 'access' : undefined);
});

test('sign-out while reading pending authorization does not dismiss another browser session', async () => {
 const f = fixture(); let release; const pending = f.storage.get('pending'); f.SecureStorage.get = () => new Promise(resolve => { release = () => resolve(pending); });
 const login = assert.rejects(f.Auth.complete(callback), /Connection changed/); await tick(); await f.Auth.clear(); release(); await login;
 assert.deepEqual(f.events, []); assert.equal(f.requests.length, 0);
});

test('preview sign-in never closes a native browser', async () => {
 const f = fixture(); f.Preview.enabled = true; f.location = { origin: 'https://preview.test' }; f.Auth.callback = 'https://preview.test/oauth/callback'; f.Preview.request = async () => ({ status: 200, data: tokens });
 await f.Auth.complete('https://preview.test/oauth/callback?state=expected&code=code'); assert.deepEqual(f.events, ['bind']);
});

test('duplicate accepted callbacks finalize and dismiss the browser only once', async () => {
 const f = fixture(); let handle; let logins = 0;
 f.App = { addListener: async (_, listener) => { handle = listener; }, getLaunchUrl: async () => null }; f.SecureStorage.setKeyPrefix = async () => {};
 await f.Auth.initialize(async () => { logins++; }); handle({ url: callback }); handle({ url: callback }); await tick();
 assert.equal(f.requests.length, 1); f.requests[0]({ status: 200, data: tokens }); await f.Auth.completing; handle({ url: callback }); await tick();
 assert.equal(logins, 1); assert.deepEqual(f.events, ['close', 'bind']);
});

test('expired authorization leaves the browser open', async () => {
 const f = fixture(); f.storage.get('pending').created -= 900001;
 await assert.rejects(f.Auth.complete(callback), /expired/); assert.deepEqual(f.events, []); assert.equal(f.requests.length, 0);
});

test('sign-out during browser dismissal prevents token exchange and binding', async () => {
 const f = fixture(); let release; f.Browser.close = () => new Promise(resolve => { f.events.push('close'); release = resolve; });
 const login = assert.rejects(f.Auth.complete(callback), /Connection changed/); await tick(); await f.Auth.clear(); release(); await login;
 assert.deepEqual(f.events, ['close']); assert.equal(f.requests.length, 0); assert.equal(f.storage.has('tokens'), false);
});

test('iOS sign-in uses the authentication session and completes its callback', async () => {
 const f = fixture(); Object.assign(f, { crypto: globalThis.crypto, btoa, Uint8Array, TextEncoder, URLSearchParams, Capacitor: { getPlatform: () => 'ios' } }); const handled = [];
 f.Auth.handle = async url => { handled.push(url); }; f.Native.plugin.authenticate = async options => { f.opened.push(options); return { url: callback }; };
 await f.Auth.begin('https://old.test');
 assert.equal(f.opened[0].scheme, 'com.typerelay.mobile'); assert.match(f.opened[0].url, /^https:\/\/old\.test\/oauth\/authorize\?/); assert.deepEqual(handled, [callback]);
});

test('create account opens signup with the authorization continuation', async () => {
 const f = fixture(); Object.assign(f, { crypto: globalThis.crypto, btoa, Uint8Array, TextEncoder, URLSearchParams });
 await f.Auth.begin('https://old.test', true);
 const url = new URL(f.opened[0].url); assert.equal(url.pathname, '/signup'); assert.match(url.searchParams.get('return_to'), /^\/oauth\/authorize\?.*client_id=typerelay-mobile/);
});

test('iOS completion dismisses the authentication session', async () => {
 const f = fixture(); f.Capacitor.getPlatform = () => 'ios'; const pending = f.Auth.complete(callback); await tick(); f.requests[0]({ status: 200, data: tokens }); await pending;
 assert.deepEqual(f.events, ['cancel', 'bind']);
});
