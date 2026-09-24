import { Runtime } from './runtime.js';

const origin = 'https://app.typerelay.com';
const client = 'typerelay-browser';
const callbackPath = '/oauth/browser-callback';
let refreshJob;
let completionJob;
let bridge;
let bridgeVerified = false;
let bridgeSequence = 0;
const bridgeReplies = new Map();

const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

async function clear() {
	await chrome.storage.local.remove(['tokens', 'items', 'cursor', 'account', 'lastSync']);
	await caches.delete('typerelay-assets-v1');
}

async function token(force = false) {
	const { tokens } = await chrome.storage.local.get('tokens');
	if (!tokens) throw new Error('Sign in to TypeRelay');
	if (!force && Date.now() < tokens.obtained_at + (tokens.expires_in - 60) * 1000) return tokens.access_token;
	refreshJob ||= (async () => {
		const response = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: client, refresh_token: tokens.refresh_token }), redirect: 'error' });
		if (!response.ok) { if (response.status === 401) await clear(); throw new Error((await response.json().catch(() => ({}))).error || 'Sign-in expired'); }
		const renewed = { ...await response.json(), obtained_at: Date.now() };
		await chrome.storage.local.set({ tokens: renewed });
		return renewed.access_token;
	})().finally(() => { refreshJob = null; });
	return refreshJob;
}

async function request(path, options = {}) {
	const send = async force => fetch(`${origin}${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await token(force)}`, 'X-TypeRelay-Sync-Protocol': '6' }, redirect: 'error' });
	let response = await send(false);
	if (response.status === 401) response = await send(true);
	if (!response.ok) { if (response.status === 401 || response.status === 403) await clear(); throw new Error((await response.json().catch(() => ({}))).error || `TypeRelay request failed (${response.status})`); }
	return response;
}

async function connect() {
	const { browserAuth } = await chrome.storage.session.get('browserAuth');
	if (browserAuth?.startedAt > Date.now() - 900000) return { pending: true };
	const verifier = base64(crypto.getRandomValues(new Uint8Array(48)));
	const state = base64(crypto.getRandomValues(new Uint8Array(48)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const redirect = `${origin}${callbackPath}`;
	const params = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: base64(new Uint8Array(digest)), state, client_type: 'browser', os: 'web', device_name: 'Type Relay Chrome' });
	await chrome.storage.session.set({ browserAuth: { verifier, state, redirect, startedAt: Date.now() } });
	await chrome.storage.session.remove('browserAuthError');
	try { await chrome.tabs.create({ url: `${origin}/oauth/authorize?${params}` }); }
	catch (error) { await chrome.storage.session.remove('browserAuth'); throw error; }
	return { pending: true };
}

async function finishConnect(tabId, url) {
	const { browserAuth } = await chrome.storage.session.get('browserAuth');
	if (!browserAuth || browserAuth.startedAt <= Date.now() - 900000) return;
	const callback = new URL(url);
	if (callback.origin !== origin || callback.pathname !== callbackPath || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== browserAuth.state) return;
	await chrome.storage.session.remove('browserAuth');
	try {
		if (callback.searchParams.getAll('code').length !== 1) throw new Error('Invalid Type Relay sign-in response');
		const response = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: client, redirect_uri: browserAuth.redirect, code_verifier: browserAuth.verifier, code: callback.searchParams.get('code') }), redirect: 'error' });
		if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Sign-in failed');
		const tokens = { ...await response.json(), obtained_at: Date.now() };
		await clear();
		await chrome.storage.local.set({ tokens, account: tokens.account });
		await chrome.tabs.remove(tabId).catch(() => undefined);
		await sync();
	} catch (error) { await chrome.storage.session.set({ browserAuthError: error.message || String(error) }); }
}

function finishPending(tabId, url) {
	completionJob ||= finishConnect(tabId, url).catch(error => chrome.storage.session.set({ browserAuthError: error.message || String(error) })).finally(() => { completionJob = null; });
	return completionJob;
}

async function sync() {
	const response = await request('/api/v2/sync?cursor=0');
	const snapshot = await response.json();
	if (snapshot.protocol !== 6) throw new Error('TypeRelay sync protocol mismatch');
	const cache = await caches.open('typerelay-assets-v1');
	const ids = new Set(snapshot.libraries.filter(library => library.state === 'active').flatMap(library => library.snippets.flatMap(snippet => snippet.content?.assets || [])));
	for (const id of ids) {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid asset ID');
		const key = chrome.runtime.getURL(`assets/${id}`);
		if (!await cache.match(key)) await cache.put(key, await request(`/api/v2/assets/${id}`));
	}
	const items = snapshot.libraries.filter(library => library.state === 'active').flatMap(library => library.snippets.filter(snippet => snippet.state === 'active').map(snippet => ({ id: snippet.id, trigger: snippet.trigger, title: snippet.title, library: library.name, content: snippet.content })));
	await chrome.storage.local.set({ items, cursor: snapshot.cursor, lastSync: Date.now() });
	for (const key of await cache.keys()) if (!ids.has(key.url.split('/').at(-1))) await cache.delete(key);
	return { count: items.length, cursor: snapshot.cursor };
}

async function assetUrl(id) {
	const response = await (await caches.open('typerelay-assets-v1')).match(chrome.runtime.getURL(`assets/${id}`));
	if (!response) throw new Error('Image unavailable offline; sync TypeRelay');
	const bytes = new Uint8Array(await response.arrayBuffer());
	let encoded = '';
	for (let offset = 0; offset < bytes.length; offset += 32768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	return `data:${response.headers.get('Content-Type') || 'application/octet-stream'};base64,${btoa(encoded)}`;
}

async function render(item, values = {}, preview = false) {
	const content = item.content;
	if (content.type === 'plain_text' || content.type === 'code') return { text: content.text, fields: [], enter_actions: 0 };
	if (content.type === 'template') return Runtime.template(content, values, preview);
	if (content.type === 'rich_text') {
		const assets = Object.fromEntries(await Promise.all((content.assets || []).map(async id => [id, await assetUrl(id)])));
		return Runtime.rich(content, values, preview, assets);
	}
	throw new Error('Unsupported snippet format');
}

async function prepared(id, values, preview) {
	const { items = [] } = await chrome.storage.local.get('items');
	const item = items.find(row => row.id === id);
	if (!item) throw new Error('Snippet no longer available');
	return { item, rendered: await render(item, values, preview) };
}

async function claim(active = true) {
	const platform = await chrome.runtime.getPlatformInfo();
	if (platform.os === 'cros') return true;
	if (!bridge) {
		try {
			bridge = chrome.runtime.connectNative('com.typerelay.bridge');
			bridge.onMessage.addListener(message => { if (message?.sequence && bridgeReplies.has(message.sequence)) { bridgeReplies.get(message.sequence)(message.ok === true); bridgeReplies.delete(message.sequence); bridgeVerified = message.ok === true; } });
			bridge.onDisconnect.addListener(() => { bridge = null; bridgeVerified = false; for (const resolve of bridgeReplies.values()) resolve(false); bridgeReplies.clear(); });
		} catch { return false; }
	}
	const sequence = ++bridgeSequence;
	return new Promise(resolve => { bridgeReplies.set(sequence, resolve); bridge.postMessage({ sequence, active }); setTimeout(() => { if (bridgeReplies.has(sequence)) { bridgeReplies.delete(sequence); resolve(false); } }, 600); });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
	(async () => {
		switch (message.type) {
			case 'connect': return connect();
			case 'disconnect': { await request('/api/v2/connection', { method: 'DELETE' }).catch(() => undefined); await clear(); await chrome.storage.session.remove(['browserAuth', 'browserAuthError']); return { disconnected: true }; }
			case 'sync': return sync();
			case 'status': {
				let auth = await chrome.storage.session.get(['browserAuth', 'browserAuthError']);
				if (auth.browserAuth) {
					const callbacks = await chrome.tabs.query({ url: `${origin}/*` });
					for (const tab of callbacks) if (tab.url?.startsWith(`${origin}${callbackPath}`)) await finishPending(tab.id, tab.url);
					auth = await chrome.storage.session.get(['browserAuth', 'browserAuthError']);
				}
				const data = await chrome.storage.local.get(['tokens', 'items', 'lastSync', 'prefix']);
				const platform = await chrome.runtime.getPlatformInfo();
				return { connected: !!data.tokens, count: data.items?.length || 0, lastSync: data.lastSync, bridgeVerified: platform.os === 'cros' || await claim(false), prefix: data.prefix || ';', origin, platform: platform.os, authPending: auth.browserAuth?.startedAt > Date.now() - 900000, authError: auth.browserAuthError };
			}
			case 'cancel-connect': { await chrome.storage.session.remove(['browserAuth', 'browserAuthError']); return { cancelled: true }; }
			case 'snapshot': { const data = await chrome.storage.local.get(['items', 'prefix']); return { items: data.items || [], prefix: data.prefix || ';' }; }
			case 'focus': { if (sender.tab?.id == null || sender.frameId == null) return {}; await chrome.storage.session.set({ [`frame-${sender.tab.id}`]: sender.frameId }); return {}; }
			case 'insert': { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error('No active Chrome tab'); const state = await chrome.storage.session.get(`frame-${tab.id}`); const response = await chrome.tabs.sendMessage(tab.id, { type: 'insert', id: message.id }, { frameId: state[`frame-${tab.id}`] ?? 0 }); if (!response?.ok) throw new Error(response?.error || 'Focus an editable field first'); return {}; }
			case 'prefix': { if (!",;./'[]\\`=".includes(message.value) || message.value.length !== 1) throw new Error('Invalid prefix'); await chrome.storage.local.set({ prefix: message.value }); return { prefix: message.value }; }
			case 'match': return Runtime.match(message.before, message.prefix, message.triggers);
			case 'prepare': return prepared(message.id, message.values || {}, !!message.preview);
			case 'claim': return { verified: await claim() };
			default: throw new Error('Unknown request');
		}
	})().then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error.message || String(error) }));
	return true;
});

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 2 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 2 }));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { if (changeInfo.url?.startsWith(`${origin}${callbackPath}`)) void finishPending(tabId, changeInfo.url); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'sync') void chrome.storage.local.get('tokens').then(data => data.tokens && sync()).catch(() => undefined); });
