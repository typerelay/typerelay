import { Capacitor, WebPlugin } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export class Preview extends WebPlugin {
 static enabled = !Capacitor.isNativePlatform() && import.meta.env.VITE_MOBILE_PREVIEW === 'true';
 static origin = import.meta.env.VITE_PREVIEW_API_ORIGIN || '';
 static async request(path: string, method: string, data?: unknown, token?: string) {
  const response = await fetch(import.meta.env.BASE_URL + '__preview/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: response.status, data: await response.json() };
 }
 async execute({ request }: { request: string }) {
  const body = JSON.parse(request);
  const tokens = await SecureStorage.get('tokens') as { access_token?: string } | null;
  const token = body.action === 'bind' ? body.access_token : tokens?.access_token;
  if (body.action === 'suspend') return { data: {} };
  if (!token && body.action === 'state') return { data: { generation: '', libraries: [], pending: 0, conflicts: [] } };
  if (!token) throw new Error('Sign in first');
  let client = localStorage.getItem('typerelay_preview_client');
  if (!client) { client = crypto.randomUUID(); localStorage.setItem('typerelay_preview_client', client); }
  const response = await fetch(import.meta.env.BASE_URL + '__preview/native', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Preview-Client': client }, body: request });
  const result = await response.json();
  if (!response.ok || result.error) throw Object.assign(new Error(result.error || 'Preview request failed'), { code: String(result.status || response.status) });
  return result;
 }
 async copy({ text, html }: { text: string; html?: string }) {
  if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
  else await navigator.clipboard.writeText(text);
 }
 async keyboardSettings(): Promise<void> { throw new Error('Keyboard settings are available in the installed iOS or Android app.'); }
}
