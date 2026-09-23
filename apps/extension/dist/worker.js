import { Runtime } from './runtime.js';

const origin = 'https://app.typerelay.com';
const client = 'typerelay-browser';
let refreshJob;
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
	const verifier = base64(crypto.getRandomValues(new Uint8Array(48)));
	const state = base64(crypto.getRandomValues(new Uint8Array(48)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const redirect = chrome.identity.getRedirectURL('callback');
	const params = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: base64(new Uint8Array(digest)), state, client_type: 'browser', os: 'web', device_name: 'TypeRelay Chrome' });
	const callback = new URL(await chrome.identity.launchWebAuthFlow({ url: `${origin}/oauth/authorize?${params}`, interactive: true }));
	if (callback.origin !== new URL(redirect).origin || callback.pathname !== new URL(redirect).pathname || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state || callback.searchParams.getAll('code').length !== 1) throw new Error('Invalid TypeRelay sign-in response');
	const response = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: client, redirect_uri: redirect, code_verifier: verifier, code: callback.searchParams.get('code') }), redirect: 'error' });
	if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Sign-in failed');
	const tokens = { ...await response.json(), obtained_at: Date.now() };
	await clear();
	await chrome.storage.local.set({ tokens, account: tokens.account });
	await sync();
	return { account: tokens.account };
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

async function claim() {
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
	return new Promise(resolve => { bridgeReplies.set(sequence, resolve); bridge.postMessage({ sequence, active: true }); setTimeout(() => { if (bridgeReplies.has(sequence)) { bridgeReplies.delete(sequence); resolve(false); } }, 600); });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
	(async () => {
		switch (message.type) {
			case 'connect': return connect();
			case 'disconnect': { await request('/api/v2/connection', { method: 'DELETE' }).catch(() => undefined); await clear(); return { disconnected: true }; }
			case 'sync': return sync();
			case 'status': { const data = await chrome.storage.local.get(['tokens', 'items', 'lastSync', 'prefix']); return { connected: !!data.tokens, count: data.items?.length || 0, lastSync: data.lastSync, bridgeVerified, prefix: data.prefix || ';', origin }; }
			case 'snapshot': { const data = await chrome.storage.local.get(['items', 'prefix']); return { items: data.items || [], prefix: data.prefix || ';' }; }
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
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'sync') void chrome.storage.local.get('tokens').then(data => data.tokens && sync()).catch(() => undefined); });
