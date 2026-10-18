import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { Tokens } from './types';
import { Native } from './native';
import { Preview } from './preview';
export class Auth {
 static callback = Preview.enabled ? `${location.origin}${import.meta.env.BASE_URL}oauth/callback` : 'com.typerelay.mobile://oauth/callback';
 static client = 'typerelay-mobile';
 static server = '';
 static tokens: Tokens | null = null;
 static refresh: Promise<Tokens> | null = null;
 static completing: Promise<void> | null = null;
 static completed = new Set<string>();
 static version = 0;
 static writes: Promise<unknown> = Promise.resolve();
 static assert(version: number) { if (version !== Auth.version) throw new Error('Connection changed; sign in again'); }
 static write<T>(version: number, action: () => Promise<T>): Promise<T> { const result = Auth.writes.then(() => { Auth.assert(version); return action(); }); Auth.writes = result.catch(() => undefined); return result; }
 static async revoke(server: string, tokens: Tokens) { return Preview.enabled ? Preview.request('/api/v2/connection', 'DELETE', undefined, tokens.access_token) : CapacitorHttp.delete({ url: `${server}/api/v2/connection`, headers: { Authorization: `Bearer ${tokens.access_token}`, 'X-TypeRelay-Sync-Protocol': '6' }, disableRedirects: true }); }
 static async initialize(onLogin: () => Promise<void>) {
  await SecureStorage.setKeyPrefix('typerelay_mobile_');
  Auth.server = await SecureStorage.get('server') as string || '';
  Auth.tokens = await SecureStorage.get('tokens') as Tokens | null;
  const handle = async (url: string) => { if (!Auth.isCallback(url) || Auth.completed.has(url)) return; if (!Auth.completing) { const version = Auth.version; Auth.completing = Auth.complete(url).then(async () => { Auth.assert(version); Auth.completed.add(url); await onLogin(); }).finally(() => { if (version === Auth.version) Auth.completing = null; }); } return Auth.completing; };
  if (Preview.enabled) { if (Auth.tokens) await Auth.access().catch(async error => { Auth.onError(error); await Auth.clear(); }); if (Auth.isCallback(location.href)) { await handle(location.href).catch(Auth.onError); history.replaceState(null, '', import.meta.env.BASE_URL); } return; }
  await App.addListener('appUrlOpen', event => { void handle(event.url).catch(Auth.onError); });
  const launch = await App.getLaunchUrl();
  if (launch?.url) await handle(launch.url).catch(Auth.onError);
 }
 static onError: (error: unknown) => void = console.error;
 static isCallback(value: string) { try { const url = new URL(value); if (Preview.enabled) return url.origin === location.origin && url.pathname === new URL(Auth.callback).pathname && !url.username && !url.password && !url.hash; return url.protocol === 'com.typerelay.mobile:' && url.hostname === 'oauth' && url.pathname === '/callback' && !url.port && !url.username && !url.password && !url.hash; } catch { return false; } }
 static normalize(value: string) { const url = new URL(value); if ((url.protocol !== 'https:' && !(Preview.enabled && url.protocol === 'http:' && url.origin === Preview.origin)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter an HTTPS server origin without a path.'); return url.origin; }
 static random() { return Auth.base64(crypto.getRandomValues(new Uint8Array(48))); }
 static base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
 static async begin(value: string) {
  const version = Auth.version; const server = Auth.normalize(value); if (Preview.enabled && server !== Preview.origin) throw new Error('Use the configured development server.'); const verifier = Auth.random(); const state = Auth.random();
  const challenge = Auth.base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await Auth.write(version, () => SecureStorage.set('pending', { server, verifier, state, created: Date.now() }));
  const params = new URLSearchParams({ client_id: Auth.client, redirect_uri: Auth.callback, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state, client_type: 'mobile', os: Capacitor.getPlatform(), device_name: `TypeRelay ${Capacitor.getPlatform()}` });
  if (Preview.enabled) location.assign(`${server}/oauth/authorize?${params}`); else await Browser.open({ url: `${server}/oauth/authorize?${params}` });
 }
 static async complete(value: string) {
  const version = Auth.version;
  if (!Auth.isCallback(value)) throw new Error('Invalid sign-in callback');
  const url = new URL(value); const pending = await SecureStorage.get('pending') as any;
  if (!pending || Date.now() - pending.created > 300000 || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state) throw new Error('Sign-in expired or state mismatch. Sign in again.');
  if (url.searchParams.has('error')) throw new Error('Sign-in was cancelled.');
  if (url.searchParams.getAll('code').length !== 1) throw new Error('Missing sign-in code');
  const tokens = await Auth.tokenRequest(pending.server, { grant_type: 'authorization_code', client_id: Auth.client, redirect_uri: Auth.callback, code_verifier: pending.verifier, code: url.searchParams.get('code')! }, version);
  try { await Auth.write(version, async () => {
   await Native.call('bind', { server: pending.server, account: tokens.account, ...(Preview.enabled ? { access_token: tokens.access_token } : {}) });
   Auth.assert(version); await SecureStorage.set('server', pending.server); Auth.assert(version);
   await SecureStorage.set('tokens', tokens as any); Auth.assert(version); Auth.tokens = tokens; Auth.server = pending.server;
   await SecureStorage.remove('pending');
  }); } catch (error) { await Auth.revoke(pending.server, tokens).catch(() => undefined); throw error; }
  Auth.assert(version); await Browser.close().catch(() => undefined);
 }
 static async tokenRequest(server: string, body: Record<string,string>, version = Auth.version) { const result = await (Preview.enabled ? Preview.request('/oauth/token', 'POST', body) : CapacitorHttp.post({ url: `${server}/oauth/token`, headers: { 'Content-Type': 'application/json' }, data: body, disableRedirects: true })); Auth.assert(version); if (result.status !== 200) { if (result.status === 401 && body.grant_type === 'refresh_token') await Auth.write(version, () => Native.call('suspend')); throw new Error(result.data?.error || 'Sign-in failed'); } return { ...result.data, obtained_at: Date.now() } as Tokens; }
 static async save(tokens: Tokens, version = Auth.version) { await Auth.write(version, async () => { await SecureStorage.set('tokens', tokens as any); Auth.assert(version); Auth.tokens = tokens; }); }

 static async access(force = false) {
  const version = Auth.version;
  if (!Auth.tokens) throw new Error('Sign in first');
  if (!force && Date.now() < Auth.tokens.obtained_at + (Auth.tokens.expires_in - 60) * 1000) return Auth.tokens.access_token;
  if (!Auth.refresh) Auth.refresh = Auth.tokenRequest(Auth.server, { grant_type: 'refresh_token', client_id: Auth.client, refresh_token: Auth.tokens.refresh_token }, version).then(async tokens => { await Auth.save(tokens, version); return tokens; }).finally(() => { if (version === Auth.version) Auth.refresh = null; });
  return (await Auth.refresh).access_token;
 }
 static async request(path: string, method: string, data?: unknown) {
  const version = Auth.version; const server = Auth.server;
  const send = async (force: boolean) => { const token = await Auth.access(force); Auth.assert(version); return Preview.enabled ? Preview.request(`/api/v2/${path}`, method, data, token) : CapacitorHttp.request({ url: `${server}/api/v2/${path}`, method, headers: { Authorization: `Bearer ${token}`, 'X-TypeRelay-Sync-Protocol': '6', 'Content-Type': 'application/json' }, data, disableRedirects: true }); };
  let response = await send(false); Auth.assert(version); if (response.status === 401) response = await send(true); Auth.assert(version);
  if (response.status < 200 || response.status >= 300) throw new Error(response.data?.error || 'Request failed'); return response.data;
 }
 static async clear() { const version = ++Auth.version; Auth.tokens = null; Auth.server = ''; Auth.refresh = null; Auth.completing = null; await Auth.write(version, async () => { await SecureStorage.remove('tokens'); await SecureStorage.remove('pending'); await SecureStorage.remove('server'); }); }
}
