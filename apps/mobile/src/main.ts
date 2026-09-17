import { createElement, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from 'bootstrap';
import Swal from 'sweetalert2';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { RichEditor } from '@server/browser/rich-editor.js';
import { TemplateEditor } from '@server/public/template-editor.js';
import { Auth } from './auth';
import { Native } from './native';
import { Preview } from './preview';
import { Items } from './items';
import type { Library, Snippet, State } from './types';
import shell from '../views/ajax/shell.pug';
import row from '../views/ajax/row.pug';
import edit from '../views/ajax/edit.pug';
import fill from '../views/ajax/fill.pug';
import settings from '../views/ajax/settings.pug';
import review from '../views/ajax/review.pug';
import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';

class MobileApp {
 static state: State = { generation: '', libraries: [], pending: 0, conflicts: [] };
 static listeners = new Set<() => void>();
 static syncJob: Promise<void> | null = null;
 static active = true;
 static draftTimer: ReturnType<typeof setTimeout>;
 static draftJob: Promise<unknown> = Promise.resolve();
 static editing: { library: string; id?: string; revision: number; record_revision?: number; operation_id: string } | null = null;
 static richView: any;
 static template: any;
 static codeReadonly = false;
 static assetURLs = new Map<string, string>();
 static observer: MutationObserver;
 static $(id: string) { return document.getElementById(id)!; }
 static input(id: string) { return MobileApp.$(id) as HTMLInputElement; }
 static fragment(html: string) { return new DOMParser().parseFromString(html, 'text/html').body.firstElementChild!; }
 static toast(message: string, icon: 'success' | 'error' = 'success') { void Swal.fire({ toast: true, position: 'top-end', icon, title: message, timer: 4000, showConfirmButton: false }); }
 static error(error: unknown) { MobileApp.toast(error instanceof Error ? error.message : String(error), 'error'); }
 static async busy(control: HTMLButtonElement, operation: () => Promise<void>) { control.disabled = true; try { await operation(); } catch (error) { MobileApp.error(error); } finally { control.disabled = false; } }
 static subscribe = (listener: () => void) => { MobileApp.listeners.add(listener); return () => MobileApp.listeners.delete(listener); };
 static snapshot = () => MobileApp.state;
 static async load() { MobileApp.state = await Native.call('state'); for (const listener of MobileApp.listeners) listener(); }
 static async sync() {
  if (!Auth.tokens || !MobileApp.active) return;
  if (!MobileApp.syncJob) MobileApp.syncJob = (async () => {
   MobileApp.$('sync-status').textContent = 'Syncing…';
   try {
    try { await Native.call('sync', { server: Auth.server, access_token: await Auth.access() }); }
    catch (error: any) { if (String(error.code) !== '401') throw error; await Native.call('sync', { server: Auth.server, access_token: await Auth.access(true) }); }
    await MobileApp.load();
   } catch (error) { await MobileApp.load(); MobileApp.$('sync-status').textContent = `${MobileApp.state.pending} pending · Sync unavailable`; throw error; }
  })().finally(() => { MobileApp.syncJob = null; });
  return MobileApp.syncJob;
 }
 static reconcile(state: State) {
  MobileApp.$('login').hidden = !!Auth.tokens; MobileApp.$('signed-in').hidden = !Auth.tokens;
  MobileApp.$('sync-status').textContent = `${state.pending} pending · ${state.conflicts.length} conflicts`;
  MobileApp.$('restore-draft').hidden = !state.draft;
  MobileApp.$('conflicts').hidden = !state.conflicts.length;
  const select = MobileApp.$('library') as HTMLSelectElement;
  for (const option of [...select.options]) if (option.value && !state.libraries.some(library => library._id === option.value)) option.remove();
  for (const library of state.libraries) { let option = [...select.options].find(option => option.value === library._id); if (!option) { option = new Option(library.name, library._id); select.add(option); } option.textContent = library.name; }
  Items.update(MobileApp.$('snippets'), state.libraries, row);
  MobileApp.filter();
 }
 static filter() { const query = MobileApp.input('search').value.toLocaleLowerCase(); const library = MobileApp.input('library').value; let count = 0; for (const element of [...MobileApp.$('snippets').children] as HTMLElement[]) { element.hidden = (!!library && element.dataset.library !== library) || !(element.dataset.search || '').includes(query); if (!element.hidden) count++; } MobileApp.$('empty').hidden = count > 0; }
 static library(id: string) { const library = MobileApp.state.libraries.find(library => library._id === id); if (!library) throw new Error('Library is no longer available'); return library; }
 static async openEditor(library: Library, snippet?: Snippet, draft?: any) {
  if (!library.permissions.edit) throw new Error('Library is read-only');
  if (MobileApp.state.draft && !draft) { const answer = await Swal.fire({ title: 'Replace the saved draft?', text: 'Resume the existing draft from the snippet list to keep editing it.', showCancelButton: true, confirmButtonText: 'Replace draft' }); if (!answer.isConfirmed) return; }
  MobileApp.richView?.destroy(); MobileApp.richView = null;
  MobileApp.$('editor-content').replaceChildren(MobileApp.fragment(edit({ libraries: MobileApp.state.libraries, library, snippet })));
  MobileApp.editing = draft?.editing || { library: library._id, id: snippet?.id, revision: library.editor_revision, record_revision: snippet?.revision, operation_id: crypto.randomUUID() };
  if (draft) { for (const [id, value] of Object.entries(draft.fields)) MobileApp.input(id).value = String(value); MobileApp.$('template-options').dataset.variables = JSON.stringify(draft.variables || {}); }
  MobileApp.template = new TemplateEditor(MobileApp);
  MobileApp.configureEditor();
  MobileApp.input('snippet-type').onchange = () => { MobileApp.configureEditor(); MobileApp.scheduleDraft(); };
  MobileApp.input('edit-library').onchange = () => { const selected = MobileApp.library(MobileApp.input('edit-library').value); MobileApp.editing = { library: selected._id, revision: selected.editor_revision, operation_id: crypto.randomUUID() }; MobileApp.scheduleDraft(); };
  MobileApp.$('editor-form').addEventListener('input', MobileApp.scheduleDraft);
  MobileApp.$('cancel-edit').onclick = () => { void MobileApp.persistDraft().then(() => { Modal.getInstance(MobileApp.$('form-modal'))?.hide(); return MobileApp.load(); }).catch(MobileApp.error); };
  MobileApp.$('save-copy').onclick = () => { void MobileApp.busy(MobileApp.$('save-copy') as HTMLButtonElement, async () => { const library = MobileApp.library(MobileApp.input('edit-library').value); MobileApp.editing = { library: library._id, revision: library.editor_revision, operation_id: crypto.randomUUID() }; MobileApp.input('trigger').value = ''; MobileApp.input('title').value += ' (copy)'; await MobileApp.save(); }); };
  MobileApp.$('editor-form').onsubmit = event => { event.preventDefault(); void MobileApp.busy(MobileApp.$('save') as HTMLButtonElement, MobileApp.save); };
  Modal.getOrCreateInstance(MobileApp.$('form-modal')).show();
 }
 static configureEditor() {
  MobileApp.richView?.destroy(); MobileApp.richView = null;
  const rich = MobileApp.input('snippet-type').value === 'rich_text'; MobileApp.$('rich-options').hidden = !rich;
  if (rich) MobileApp.richView = new RichEditor(MobileApp.input('replace'), MobileApp.$('rich-editor'), MobileApp.$('rich-toolbar'), {
   onError: MobileApp.error,
   upload: async (file: File) => { if (file.size > 5 * 1048576) throw new Error('Choose an image up to 5 MiB'); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return Native.call('asset_import', { base64: btoa(binary) }); },
   remote: (url: string) => MobileApp.remoteImage('assets/remote', { url }),
   refresh: (id: string) => MobileApp.remoteImage(`assets/${id}/refresh`, {}),
  });
  MobileApp.template.attach();
  if (MobileApp.input('snippet-type').value === 'plain_text') MobileApp.$('template-options').hidden = true;
  MobileApp.observer?.disconnect();
  MobileApp.observer = new MutationObserver(() => { void MobileApp.hydrateImages(); });
  MobileApp.observer.observe(MobileApp.$('rich-editor'), { childList: true, subtree: true });
  void MobileApp.hydrateImages();
 }
 static async remoteImage(path: string, data: object) { const metadata = await Auth.request(path, 'POST', data); const fetch = async (force: boolean) => Native.call('asset_fetch', { metadata, server: Auth.server, access_token: await Auth.access(force) }); try { return await fetch(false); } catch (error: any) { if (String(error.code) !== '401') throw error; return fetch(true); } }
 static async hydrateImages() { for (const image of MobileApp.$('rich-editor').querySelectorAll<HTMLImageElement>('img[data-asset]')) { const id = image.dataset.asset!; if (!MobileApp.assetURLs.has(id)) { try { MobileApp.assetURLs.set(id, (await Native.call('asset', { id })).url); } catch { continue; } } if (image.isConnected) image.src = MobileApp.assetURLs.get(id)!; } }
 static scheduleDraft = () => { clearTimeout(MobileApp.draftTimer); MobileApp.draftTimer = setTimeout(() => { void MobileApp.persistDraft().catch(MobileApp.error); }, 250); };
 static async persistDraft() { clearTimeout(MobileApp.draftTimer); if (!MobileApp.editing) return; MobileApp.richView?.content(); const fields = Object.fromEntries(['title','trigger','snippet-type','language','replace','edit-library'].map(id => [id, MobileApp.input(id).value])); const draft = { editing: MobileApp.editing, fields, variables: MobileApp.template?.variables || {} }; MobileApp.draftJob = MobileApp.draftJob.catch(() => undefined).then(() => Native.call('draft', { draft })); await MobileApp.draftJob; }
 static save = async () => {
  await MobileApp.persistDraft(); const kind = MobileApp.input('snippet-type').value; const template = ['template','rich_text'].includes(kind) ? await MobileApp.template.content() : null;
  const entry = { trigger: MobileApp.input('trigger').value, title: MobileApp.input('title').value, type: kind, language: MobileApp.input('language').value, replace: MobileApp.richView?.content() ?? MobileApp.input('replace').value, variables: template?.variables || {} };
  if (kind === 'rich_text') {
   const preview = await Native.call('render', { content: { type: kind, version: 2, markdown: entry.replace, variables: entry.variables }, preview: true });
   const images = new DOMParser().parseFromString(preview.html, 'text/html').querySelectorAll('img[src]');
   for (const url of new Set([...images].map(image => image.getAttribute('src')!).filter(url => /^(https?:|data:image\/(png|jpeg|webp|gif);base64,)/i.test(url)))) { const asset = /^https?:/i.test(url) ? await MobileApp.remoteImage('assets/remote', { url }) : await Native.call('asset_import', { base64: url.slice(url.indexOf(',') + 1) }); entry.replace = entry.replace.replaceAll(url, `typerelay-asset:${asset.id}`).replaceAll(url.replaceAll('&', '&amp;'), `typerelay-asset:${asset.id}`); }
   if (MobileApp.richView && entry.replace !== MobileApp.richView.content()) { MobileApp.richView.editor.commands.setContent(entry.replace, { contentType: 'markdown' }); await MobileApp.persistDraft(); }
  }
  await Native.call('save', { ...MobileApp.editing, entry }); MobileApp.editing = null; await Native.call('draft', { draft: null });
  Modal.getInstance(MobileApp.$('form-modal'))?.hide(); await MobileApp.load(); MobileApp.toast('Snippet saved'); void MobileApp.sync().catch(MobileApp.error);
 };
 static async use(library: Library, snippet: Snippet) {
  const selection = { library: library._id, id: snippet.id, generation: MobileApp.state.generation };
  const rendered = await Native.call('keyboard_render', { ...selection, preview: true });
  MobileApp.$('detail-content').replaceChildren(MobileApp.fragment(fill({ snippet, rendered, variables: rendered.variables || rendered.template?.variables || {} })));
  MobileApp.$('fill-form').onsubmit = event => { event.preventDefault(); const button = (event.target as HTMLFormElement).querySelector<HTMLButtonElement>('[type=submit]')!; void MobileApp.busy(button, async () => { const values = Object.fromEntries(new FormData(event.target as HTMLFormElement)); const output = await Native.call('keyboard_render', { ...selection, values, clipboard: true }); if (output.enter_actions) throw new Error('Desktop Enter actions are unsupported on mobile'); await Native.plugin.copy({ text: output.text, html: output.html, rtf: output.rtf }); MobileApp.toast('Copied'); }); };
  Modal.getOrCreateInstance(MobileApp.$('detail-modal')).show();
 }
 static async showReview(mode: string) {
  const items = mode === 'conflicts' ? MobileApp.state.conflicts : await Native.call('recovery');
  MobileApp.$('detail-content').replaceChildren(MobileApp.fragment(review({ mode, title: mode === 'conflicts' ? 'Conflicts' : 'Recovered edits', items })));
  for (const button of MobileApp.$('detail-content').querySelectorAll<HTMLButtonElement>('[data-restore]')) button.onclick = () => { void MobileApp.busy(button, async () => {
   const item = items[Number(button.dataset.restore)]; const version = item.data.value || item.data.record || item.data; const library = MobileApp.state.libraries.find(library => library.permissions.edit); if (!library) throw new Error('Choose an editable library before restoring.');
   const draft = { editing: { library: library._id, revision: library.editor_revision, operation_id: crypto.randomUUID() }, fields: { title: version.title || '', trigger: '', 'snippet-type': version.content.type, language: version.content.language || 'plain_text', replace: version.content.markdown || version.content.text, 'edit-library': library._id }, variables: version.content.variables || {} };
   Modal.getInstance(MobileApp.$('detail-modal'))?.hide(); await MobileApp.openEditor(library, undefined, draft);
  }); };
  for (const button of MobileApp.$('detail-content').querySelectorAll<HTMLButtonElement>('[data-resolve]')) button.onclick = () => { void MobileApp.busy(button, async () => {
   await Native.call('resolve', { id: button.dataset.resolve, choice: button.dataset.choice, operation_id: button.dataset.operation ||= crypto.randomUUID() });
   button.closest('article')?.remove(); await MobileApp.load(); await MobileApp.sync();
  }); };
  Modal.getOrCreateInstance(MobileApp.$('detail-modal')).show();
 }
 static showSettings() {
  MobileApp.$('detail-content').replaceChildren(MobileApp.fragment(settings({ server: Auth.server })));
  MobileApp.$('reconnect').onclick = () => { void Auth.begin(Auth.server).catch(MobileApp.error); };
  MobileApp.$('keyboard-settings').onclick = () => { void Native.plugin.keyboardSettings().catch(MobileApp.error); };
  MobileApp.$('logout').onclick = () => { void MobileApp.busy(MobileApp.$('logout') as HTMLButtonElement, async () => {
   const result = await Swal.fire({ title: 'Sign out?', text: 'Cached snippets, pending edits, and drafts will be removed from this device.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Sign out' }); if (!result.isConfirmed) return;
   MobileApp.active = false; await MobileApp.syncJob?.catch(() => undefined); await MobileApp.draftJob.catch(() => undefined); clearTimeout(MobileApp.draftTimer);
   await Native.call('reset'); await Auth.request('connection','DELETE').catch(() => undefined); await Auth.clear(); MobileApp.assetURLs.clear(); MobileApp.editing = null;
   Modal.getInstance(MobileApp.$('detail-modal'))?.hide(); await MobileApp.load(); MobileApp.active = true;
  }); };
  Modal.getOrCreateInstance(MobileApp.$('detail-modal')).show();
 }
 static async start() {
  (globalThis as any).Swal = Swal;
  MobileApp.$('app').replaceChildren(...new DOMParser().parseFromString(shell(), 'text/html').body.childNodes);
  MobileApp.$('login-form').onsubmit = event => { event.preventDefault(); void MobileApp.busy((event.target as HTMLFormElement).querySelector('button')!, () => Auth.begin(MobileApp.input('server').value)); };
  MobileApp.$('settings').onclick = MobileApp.showSettings;
  MobileApp.$('sync').onclick = () => { void MobileApp.busy(MobileApp.$('sync') as HTMLButtonElement, MobileApp.sync); };
  MobileApp.$('search').oninput = MobileApp.filter; MobileApp.$('library').onchange = MobileApp.filter;
  MobileApp.$('add').onclick = () => { const library = MobileApp.state.libraries.find(library => library.permissions.edit && (!MobileApp.input('library').value || library._id === MobileApp.input('library').value)); if (!library) return MobileApp.toast('Choose an editable library. Create libraries in the web app.', 'error'); void MobileApp.openEditor(library).catch(MobileApp.error); };
  MobileApp.$('restore-draft').onclick = () => { const draft = MobileApp.state.draft; if (!draft) return; try { const library = MobileApp.library(draft.editing.library); void MobileApp.openEditor(library, library.records.find(item => item.id === draft.editing.id), draft).catch(MobileApp.error); } catch (error) { MobileApp.error(error); } };
  MobileApp.$('conflicts').onclick = () => { void MobileApp.showReview('conflicts').catch(MobileApp.error); }; MobileApp.$('recovery').onclick = () => { void MobileApp.showReview('recovery').catch(MobileApp.error); };
  MobileApp.$('snippets').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return; const article = button.closest<HTMLElement>('[data-record]')!; const library = MobileApp.library(article.dataset.library!); const snippet = library.records.find(snippet => snippet.id === article.dataset.record)!; void (button.dataset.edit ? MobileApp.openEditor(library, snippet) : MobileApp.use(library, snippet)).catch(MobileApp.error); };
  createRoot(MobileApp.$('controller')).render(createElement(Controller));
  Auth.onError = MobileApp.error;
  await Auth.initialize(async () => { await MobileApp.load(); await MobileApp.sync(); });
  if (Auth.server || Preview.enabled) MobileApp.input('server').value = Auth.server || Preview.origin;
  if (Preview.enabled) { MobileApp.input('server').readOnly = true; MobileApp.$('preview-notice').hidden = false; }
  await MobileApp.load();
  await Network.addListener('networkStatusChange', status => { if (status.connected) void MobileApp.sync().catch(MobileApp.error); });
  if (!Preview.enabled) await App.addListener('appStateChange', event => { MobileApp.active = event.isActive; if (event.isActive) void MobileApp.sync().catch(MobileApp.error); else void MobileApp.persistDraft().catch(MobileApp.error); });
  setInterval(() => { if (MobileApp.active && Auth.tokens) void MobileApp.sync().catch(() => undefined); }, 30000);
  void MobileApp.sync().catch(MobileApp.error);
 }
}
const Controller = () => { const state = useSyncExternalStore(MobileApp.subscribe, MobileApp.snapshot); useEffect(() => { MobileApp.reconcile(state); }, [state]); return null; };
void MobileApp.start().catch(MobileApp.error);
