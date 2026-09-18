import { ProductNews } from './product-updates.js';
import { TemplateEditor, TemplateFill } from './template-editor.js';
import { Abbreviation } from './abbreviation.js';
import { RichTextRuntime } from './rich-text-runtime.js';
class TypeRelay {
	account = document.querySelector('#workspace')?.dataset.account;
	libraries = new Map();
	tombstones = new Set();
	formOperation = null;
	submitting = false;
	selected = null;
	selectedSnippets = new Set();
	selectionAnchor = null;
	cursor = 0;
	polling = false;
	trashItems = [];
	searchVersion = 0;
	tokensVersion = 0;
	devicesVersion = 0;
	openVersion = 0;
	searchTimer = null;
	searchFocus = null;
	submit = null;
	constructor() {
		this.templateEditor = new TemplateEditor(this); this.templateFill = new TemplateFill(this);
		document.querySelectorAll('.library').forEach(node => this.libraries.set(node.dataset.id, JSON.parse(node.dataset.record)));
		document.addEventListener('input', event => { if ((event.target.id === 'trigger' || event.target.hasAttribute('data-import-trigger')) && !event.isComposing) Abbreviation.field(event.target); });
		document.addEventListener('compositionend', event => { if (event.target.id === 'trigger') Abbreviation.field(event.target); });
		document.addEventListener('submit', event => this.onSubmit(event));
		document.querySelector('#settings')?.addEventListener('hidden.bs.modal', () => { const secret = document.querySelector('#token-secret-value'); if (secret) secret.textContent = ''; document.querySelector('#token-secret')?.setAttribute('hidden', ''); const password = document.querySelector('#team-member-generated-password'); if (password) password.value = ''; document.querySelector('#team-member-password-result')?.classList.add('d-none'); });
		document.addEventListener('click', event => this.onClick(event).catch(error => this.toast(error.message, 'error')));
		document.querySelector('#search')?.addEventListener('input', () => {
			this.searchVersion++;
			clearTimeout(this.searchTimer);
			this.searchTimer = setTimeout(() => this.filter().catch(error => this.toast(error.message, 'error')), 150);
		});
		document.addEventListener('keydown', event => this.keyboard(event));
		document.querySelector('#search-modal')?.addEventListener('shown.bs.modal', () => {
			document.querySelector('#search').focus();
			this.filter().catch(error => this.toast(error.message, 'error'));
		});
		document.querySelector('#search-modal')?.addEventListener('hidden.bs.modal', () => { this.searchVersion++; this.searchFocus?.focus?.({ preventScroll: true }); if (this.searchFocus?.matches?.('[data-snippet]')) this.searchFocus.scrollIntoView({ block: 'center' }); });
		const shortcut = document.querySelector('#search-shortcut');
		if (shortcut && /Mac|iPhone|iPad/.test(navigator.platform)) shortcut.textContent = '⌘ K';
		document.querySelector('#account-switch')?.addEventListener('change', event => { location.href = '/?account=' + event.target.value; });
		document.addEventListener('change', async event => {
			if (event.target.id === 'trigger') Abbreviation.field(event.target);
			if (['snippet-type', 'code-language', 'code-indent', 'code-width'].includes(event.target.id)) await this.codeEditor().catch(error => this.toast(error.message, 'error'));
			if (event.target.id === 'shared') document.querySelectorAll('#members-select,#groups-select').forEach(field => { field.disabled = !event.target.checked; });
			if (event.target.hasAttribute('data-import-key')) { const field = document.querySelector('[data-import-trigger="' + event.target.dataset.importKey + '"]'); if (field) field.disabled = !event.target.checked || field.dataset.review === 'true'; }
			if (event.target.id === 'import-file') { this.importSource = null; document.querySelector('#import-preview').replaceChildren(); document.querySelector('#record-form button[type=submit]').disabled = true; }
			if (event.target.id === 'yaml-file' && event.target.files[0]) document.querySelector('#yaml').value = await event.target.files[0].text();
			if (event.target.hasAttribute('data-white-label-file') && event.target.files[0]) await this.whiteLabelUpload(event.target).catch(error => this.toast(error.message, 'error'));
		});
		document.querySelector('#form-modal')?.addEventListener('hidden.bs.modal', () => {
			const modal = document.querySelector('#form-modal');
			if (modal.dataset.preserveEditor === 'true') { delete modal.dataset.preserveEditor; return; }
			this.codeVersion = (this.codeVersion || 0) + 1; this.codeView?.destroy(); this.codeView = null; this.richView?.destroy(); this.richView = null;
			if (this.returnSettings) { this.returnSettings = false; bootstrap.Modal.getOrCreateInstance(document.querySelector('#settings')).show(); }
		});
		document.querySelector('#trash')?.addEventListener('show.bs.modal', () => this.loadTrash().catch(error => this.toast(error.message, 'error')));
		window.addEventListener('scroll', () => this.updateScrollTop(), { passive: true });
		window.addEventListener('resize', () => this.updateScrollTop());
		this.updateScrollTop();
		if (this.account) {
			this.poll().catch(error => this.toast(error.message, 'error'));
			setInterval(() => this.poll().catch(() => {}), 30000);
			this.devices().catch(() => {});
			const invitation = new URL(location.href).searchParams.get('invite');
			if (invitation) this.accept(invitation);
			this.productNews = new ProductNews(this);
			if (location.hash === '#settings-subscription') { bootstrap.Modal.getOrCreateInstance(document.querySelector('#settings')).show(); this.settingsTab('subscription'); }
		}
	}
	updateScrollTop() {
		const button = document.querySelector('#scroll-top');
		if (!button) return;
		const distance = document.documentElement.scrollHeight - window.innerHeight;
		const visible = distance > 0 && window.scrollY / distance > .5;
		button.classList.toggle('is-visible', visible);
		button.setAttribute('aria-hidden', String(!visible));
		button.tabIndex = visible ? 0 : -1;
	}
	toast(title, icon = 'success') { return Swal.fire({ toast: true, position: 'top-end', title, icon, timer: 3500, showConfirmButton: false }); }
	async request(path, method = 'GET', body, raw = false) {
		const response = await fetch(path.startsWith('/') ? path : '/api/v2/' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Account-Id': this.account || '' }, body: body ? JSON.stringify({ operation_id: this.submitting ? this.formOperation : crypto.randomUUID(), ...body }) : undefined });
		if (!response.ok) { const result = await response.json(); if (result.code === 'reauthentication_required') document.querySelector('#token-auth-required')?.removeAttribute('hidden'); const error = new Error(result.error); Object.assign(error, result); throw error; }
		if (response.headers.get('X-CSRF-Token')) document.querySelector('meta[name=csrf-token]').content = response.headers.get('X-CSRF-Token');
		return raw ? response.text() : response.json();
	}
	async upload(path, data) {
		const response = await fetch('/api/v2/' + path, { method: 'POST', headers: { 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Account-Id': this.account || '' }, body: data });
		if (!response.ok) { const result = await response.json(); const error = new Error(result.error); Object.assign(error, result); throw error; }
		return response.json();
	}
	async bundle(file) { const response = await fetch('/api/v2/import/bundle', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Account-Id': this.account || '', 'X-Operation-Id': this.formOperation }, body: file }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
	fragment(html) { const template = document.createElement('template'); template.innerHTML = html; for (const time of template.content.querySelectorAll('time[data-local-time]')) time.textContent = new Date(time.dateTime).toLocaleString(); return template.content.firstElementChild; }
	update(selector, container, html, before) {
		const old = document.querySelector(selector);
		const next = this.fragment(html);
		const outerFocused = old === document.activeElement;
		const focused = old?.contains(document.activeElement) ? [...old.querySelectorAll('button,input,select,textarea,a')].indexOf(document.activeElement) : -1;
		const scroll = { x: window.scrollX, y: window.scrollY };
		if (old) old.replaceWith(next); else document.querySelector(container).append(next);
		if (before !== undefined) document.querySelector(container).insertBefore(next, before);
		if (outerFocused) next.focus({ preventScroll: true });
		else if (focused >= 0) next.querySelectorAll('button,input,select,textarea,a')[focused]?.focus({ preventScroll: true });
		if (window.scrollX !== scroll.x || window.scrollY !== scroll.y) window.scrollTo(scroll.x, scroll.y);
	}
	async apply(result) {
		if (result.purged) for (const id of result.purged) {
			const previous = this.libraries.get(id);
			if (previous) await this.apply({ library: { ...previous, deleted: true } });
		}
		if (!result.library) return;
		const library = result.library;
		const prior = this.libraries.get(library._id);
		if (this.tombstones.has(library._id) && !library.deleted) return;
		if (prior && prior.revision > library.revision && !library.deleted) return;
		this.libraries.set(library._id, library);
		if (library.deleted) {
			this.tombstones.add(library._id);
			document.querySelector('[data-id="' + library._id + '"]')?.remove();
			this.libraries.delete(library._id);
			if (this.selected === library._id) { document.querySelector('[data-editor]')?.remove(); this.selected = null; }
			return;
		}
		const html = result.html || await this.request('fragments/library/' + library._id, 'GET', null, true);
		if (this.tombstones.has(library._id) || this.libraries.get(library._id)?.revision > library.revision) return;
		this.update('[data-id="' + library._id + '"]', '#libraries', html);
		if (this.selected === library._id && result.fragments) {
			document.querySelector('[data-library-title]').textContent = library.name;
			document.querySelector('[data-library-settings]').hidden = !library.permissions.manage;
			document.querySelector('[data-add-snippet]').hidden = !library.permissions.edit;
			const ids = new Set(library.snippets.map(snippet => snippet.id));
			document.querySelectorAll('[data-snippet]').forEach(node => { if (!ids.has(node.dataset.snippet)) node.remove(); });
			let before = null;
			const fragments = new Map(result.fragments.map(fragment => [fragment.id, fragment]));
			for (const snippet of [...library.snippets].reverse()) {
				const fragment = fragments.get(snippet.id);
				if (!fragment) continue;
				const node = document.querySelector('[data-snippet="' + fragment.id + '"]');
				if (!node || Number(node.dataset.revision) < fragment.revision || prior?.permissions.edit !== library.permissions.edit) this.update('[data-snippet="' + fragment.id + '"]', '#snippets', fragment.html, before);
				before = document.querySelector('[data-snippet="' + fragment.id + '"]');
			}
		}
		document.querySelector('[data-id="' + library._id + '"]')?.classList.toggle('active-library', this.selected === library._id);
		this.syncSelection();
		this.updateScrollTop();
		if (document.querySelector('#search-modal')?.classList.contains('show')) await this.filter();
	}
	async filter() {
		const input = document.querySelector('#search');
		if (!input) return;
		const query = input.value;
		const version = ++this.searchVersion;
		const html = await this.request('search?q=' + encodeURIComponent(query), 'GET', null, true);
		if (version !== this.searchVersion || query !== input.value) return;
		// Search queries are explicit navigation, never a mutation refresh.
		document.querySelector('#search-results').replaceChildren(this.fragment(html));
	}
	openSearch() {
		if (!this.account || document.querySelector('.modal.show:not(#search-modal)')) return;
		if (!document.querySelector('#search-modal').classList.contains('show')) this.searchFocus = document.activeElement;
		bootstrap.Modal.getOrCreateInstance(document.querySelector('#search-modal')).show();
		document.querySelector('#search').focus();
	}
	settingsTab(id, focus = false) {
		const tab = document.querySelector('[data-settings-tab="' + id + '"]');
		if (!tab) return;
		document.querySelectorAll('[data-settings-tab]').forEach(button => {
			const selected = button === tab;
			button.classList.toggle('active', selected);
			button.setAttribute('aria-selected', String(selected));
			button.tabIndex = selected ? 0 : -1;
		});
		document.querySelectorAll('.settings-pane').forEach(pane => { pane.hidden = pane.id !== 'settings-pane-' + id; });
		if (focus) tab.focus();
		if (id === 'tokens') this.tokens().catch(error => this.toast(error.message, 'error'));
		if (id === 'devices') this.devices().catch(error => this.toast(error.message, 'error'));
		if (id === 'whiteLabel') this.refreshWhiteLabel().catch(error => this.toast(error.message, 'error'));
		if (id === 'subscription') this.refreshBilling().catch(error => this.toast(error.message, 'error'));
	}
	applyBilling(result) {
		if (result.subscription_html && document.querySelector('#settings-pane-subscription')) this.update('#subscription-content', '#settings-pane-subscription', result.subscription_html);
		if (result.trial_html) this.update('#billing-nav-action', 'header .d-flex', result.trial_html);
		if (result.tokens_form_html && !document.querySelector('#access-token-form')) document.querySelector('#access-token-form-container')?.replaceChildren(this.fragment(result.tokens_form_html));
	}
	async refreshBilling() { if (document.querySelector('#settings-pane-subscription')) this.applyBilling(await this.request('billing/fragments')); }
	applyWhiteLabel(result) {
		if (result.html) this.update('#white-label-content', '#settings-pane-whiteLabel', result.html);
		if (result.brand_html) this.update('header .brand', '.brand-link', result.brand_html);
		if (result.settings) document.querySelector('link[rel="icon"]').href = result.settings.favicon_url || '/assets/favicon.ico';
	}
	async whiteLabelRequest(path, method = 'GET', body) { try { const result = await this.request(path, method, body); this.applyWhiteLabel(result); return result; } catch (error) { this.applyWhiteLabel(error); throw error; } }
	async refreshWhiteLabel() { await this.whiteLabelRequest('white-label'); }
	async whiteLabelUpload(input) {
		const button = input;
		button.disabled = true;
		try { const data = new FormData(); data.append('file', input.files[0]); this.applyWhiteLabel(await this.upload('white-label/assets/' + input.dataset.whiteLabelFile, data)); this.toast('Brand asset saved'); } finally { button.disabled = false; }
	}
	async tokens() {
		const version = ++this.tokensVersion;
		let rows;
		try { rows = await this.request('access-tokens'); } catch (error) { if (error.code === 'reauthentication_required') return; throw error; }
		if (version !== this.tokensVersion) return;
		document.querySelector('#token-auth-required').hidden = true;
		const ids = new Set(rows.map(row => row.id));
		for (const row of rows) this.update('[data-access-token="' + row.id + '"]', '#access-tokens', row.html);
		for (const node of document.querySelectorAll('[data-access-token]')) if (!ids.has(node.dataset.accessToken)) node.remove();
	}
	keyboard(event) {
		if (!this.account || event.isComposing) return;
		const editing = event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
		const command = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.altKey;
		if (command || (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey)) {
			if (document.querySelector('.modal.show:not(#search-modal)')) return;
			event.preventDefault(); this.openSearch(); return;
		}
		const tab = event.target.closest?.('[data-settings-tab]');
		if (tab && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			const tabs = [...document.querySelectorAll('[data-settings-tab]')];
			const current = tabs.indexOf(tab);
			const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
			event.preventDefault(); this.settingsTab(tabs[index].dataset.settingsTab, true); return;
		}
		if (document.querySelector('#search-modal').classList.contains('show')) {
			const results = [...document.querySelectorAll('.search-result')];
			const index = results.indexOf(document.activeElement);
			if (['ArrowDown', 'ArrowUp'].includes(event.key) && results.length) {
				event.preventDefault();
				results[index < 0 ? (event.key === 'ArrowDown' ? 0 : results.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length].focus();
			} else if (event.key === 'Enter' && event.target.id === 'search' && results.length) { event.preventDefault(); results[0].click(); }
			return;
		}
		if (event.target.matches?.('.snippet[data-snippet]') && ['Enter', ' '].includes(event.key)) {
			event.preventDefault(); this.editSnippet(this.libraries.get(this.selected), event.target.dataset.snippet).catch(error => this.toast(error.message, 'error')); return;
		}
		if (event.target.matches?.('.library') && ['Enter', ' '].includes(event.key)) {
			event.preventDefault(); this.open(event.target.dataset.id).catch(error => this.toast(error.message, 'error'));
		}
	}
	async open(id) {
		const version = ++this.openVersion;
		const result = await this.request('editor/' + id + '?format=json');
		const html = result.html;
		if (version !== this.openVersion) return;
		if (this.selected !== id) { this.selectedSnippets.clear(); this.selectionAnchor = null; }
		this.selected = id;
		this.libraries.set(id, result.library);
		this.update('[data-id="' + id + '"]', '#libraries', result.card);
		document.querySelector('#editor').replaceChildren(this.fragment(html));
		this.syncSelection();
		this.updateScrollTop();
		document.querySelectorAll('.library').forEach(node => {
			node.classList.toggle('active-library', node.dataset.id === id);
			node.setAttribute('aria-pressed', String(node.dataset.id === id));
		});

	}
	async snippetValue(fields) { const type = fields.get('type') || 'plain_text'; const text = fields.get('replace'); const dynamic = type !== 'code' && (type === 'rich_text' || Object.keys(this.templateEditor.variables || {}).length || /(^|[^\\])\{\{/.test(text)); const template = dynamic ? await this.templateEditor.content() : null; if (type === 'rich_text') return { trigger: fields.get('trigger') || null, title: fields.get('title') || '', content: { version: 2, type, markdown: this.richView?.content() || text, variables: template?.variables || {} } }; const storedType = type === 'plain_text' && dynamic ? 'template' : type; return { trigger: fields.get('trigger') || null, title: fields.get('title') || '', content: { version: 1, type: storedType, text, ...(storedType === 'template' ? { variables: template.variables } : {}), ...(type === 'code' ? { language: fields.get('language') || 'plain_text' } : {}) } }; }
	async assetFile(file) { const response = await fetch('/api/v2/assets', { method: 'POST', headers: { 'Content-Type': file.type, 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Account-Id': this.account || '' }, body: file }); if (!response.ok) throw new Error((await response.json()).error); return response.json(); }
	async richAssets(content) { const first = await RichTextRuntime.render(content, {}, true); const assets = {}; for (const id of first.assets) { const response = await fetch('/api/v2/assets/' + id, { headers: { 'X-Account-Id': this.account || '' } }); if (!response.ok) throw new Error('Could not load rich-text image'); const blob = await response.blob(); assets[id] = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); } return assets; }
	async copyRich(content, values = {}) { const assets = await this.richAssets(content); const rendered = await RichTextRuntime.render(content, values, false, new Date(), assets); try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([rendered.text], { type: 'text/plain' }), 'text/html': new Blob([rendered.html], { type: 'text/html' }) })]); } catch { await navigator.clipboard.writeText(rendered.text); this.toast('This browser copied the plain-text fallback'); } return rendered; }
	async codeEditor() {
		this.templateEditor.attach();
		const version = this.codeVersion = (this.codeVersion || 0) + 1;
		if (!document.querySelector('#snippet-type')) return;
		const code = document.querySelector('#snippet-type').value === 'code';
		const rich = document.querySelector('#snippet-type').value === 'rich_text';
		document.querySelector('#code-options').hidden = !code;
		document.querySelector('#rich-options').hidden = !rich;
		if (!code) { this.codeView?.destroy(); this.codeView = null; }
		if (!rich) { this.richView?.destroy(); this.richView = null; }
		if (rich) {
			const { RichEditor } = await import('./generated/rich-editor.js');
			if (version !== this.codeVersion || !document.querySelector('#snippet-type')) return;
			if (!this.richView) {
				this.richView = new RichEditor(document.querySelector('#replace'), document.querySelector('#rich-editor'), document.querySelector('#rich-toolbar'), { readonly: !!this.codeReadonly, upload: file => this.assetFile(file), remote: url => this.request('assets/remote', 'POST', { url }), refresh: id => this.request('assets/' + id + '/refresh', 'POST', {}), onError: error => this.toast(error.message, 'error') });
				document.querySelector('[data-rich-image-file]').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { const asset = await this.assetFile(file); this.richView.editor.chain().focus().setImage({ src: 'typerelay-asset:' + asset.id, alt: file.name }).run(); } catch (error) { this.toast(error.message, 'error'); } finally { event.target.value = ''; } });
			}
			return;
		}
		if (!code) return;
		const { CodeEditor } = await import('./generated/code-editor.js');
		if (version !== this.codeVersion || !document.querySelector('#snippet-type')) return;
		const selector = document.querySelector('#code-language');
		if (!selector.dataset.loaded) {
			for (const language of CodeEditor.languages) selector.add(new Option(language.name, language.name));
			const original = selector.dataset.language;
			if (![...selector.options].some(option => option.value === original)) selector.add(new Option(original, original));
			selector.value = original; selector.dataset.loaded = 'true';
		}
		if (!this.codeView) this.codeView = new CodeEditor(document.querySelector('#replace'), document.querySelector('#code-editor'), !!this.codeReadonly);
		await this.codeView.configure(selector.value, document.querySelector('#code-indent').value === 'spaces', document.querySelector('#code-width').value);
	}
	async editSnippet(library, id) {
		await this.form('snippet', { library: library._id, snippet: id || '' }, async fields => {
			const value = await this.snippetValue(fields);
			const destination = fields.get('destination_library');
			if (id && destination && destination !== library._id) {
				const item = library.snippets.find(entry => entry.id === id);
				await this.applyBatch(await this.request('snippets/batch', 'POST', { action: 'move', source_library: library._id, destination_library: destination, items: [{ id, base_revision: item.revision, value }] }), false);
			} else await this.snippet(id, value, library);
		});
		if (!library.permissions.edit) {
			this.codeReadonly = true; this.codeView?.setReadonly(true); this.richView?.setReadonly(true);
			document.querySelectorAll('[data-vfield],#insert-variable,#variable-kind,#variable-name').forEach(field => field.disabled = true);
			document.querySelectorAll('#form-fields select').forEach(field => { field.disabled = true; });
			document.querySelector('#form-title').textContent = 'Snippet · Read-only';
			document.querySelectorAll('#form-fields input,#form-fields textarea').forEach(field => { field.readOnly = true; });
			document.querySelector('#record-form button[type="submit"]').disabled = true;
		}
	}
	async form(kind, params, submit) {
		this.codeView?.destroy(); this.codeView = null; this.richView?.destroy(); this.richView = null; this.codeReadonly = false;
		document.querySelector('#form-title').textContent = ({ library: 'Library', snippet: 'Snippet', group: 'Group', conflict: 'Resolve conflict', move: 'Move snippets', snippetslab: 'Import SnippetsLab', import: 'Import snippets' })[kind];
		document.querySelector('#form-fields').replaceChildren();
		const template = document.createElement('template');
		template.innerHTML = await this.request('forms/' + kind + '?' + new URLSearchParams(params), 'GET', null, true);
		document.querySelector('#form-fields').replaceChildren(template.content);
		document.querySelector('#record-form button[type="submit"]').disabled = ['snippetslab', 'import'].includes(kind) || (kind === 'move' && !document.querySelector('#destination-library option'));
		document.querySelector('#record-form button[type="submit"]').textContent = kind === 'move' ? 'Move' : ['import', 'snippetslab'].includes(kind) ? 'Import' : 'Save';
		await this.codeEditor();
		this.submit = submit;
		this.formOperation = crypto.randomUUID();
		const settings = document.querySelector('#settings');
		this.returnSettings = settings.classList.contains('show');
		if (this.returnSettings) await new Promise(resolve => { settings.addEventListener('hidden.bs.modal', resolve, { once: true }); bootstrap.Modal.getInstance(settings).hide(); });
		bootstrap.Modal.getOrCreateInstance(document.querySelector('#form-modal')).show();
	}
	async onSubmit(event) {
		const form = event.target;
		const groupForm = form.hasAttribute('data-group-form');
		if (!groupForm && !['login', 'access-token-form', 'profile-form', 'account-form', 'team-member-form', 'record-form', 'team-seats-form', 'change-to-pro-form', 'change-to-team-form', 'checkout-team-form', 'white-label-domain-form'].includes(form.id)) return;
		event.preventDefault();
		const abbreviation = form.querySelector('#trigger');
		if (abbreviation) Abbreviation.field(abbreviation);
		const data = new FormData(form);
		const button = event.submitter;
		if (button) button.disabled = true;
		try {
			if (form.id === 'team-seats-form' || form.id === 'change-to-team-form') { const result = await this.request('billing/change', 'POST', { plan: 'team', seats: Number(data.get('seats')) }); if (result.url) location.assign(result.url); else { this.applyBilling(result); this.toast('Change scheduled'); } return; }
			if (form.id === 'change-to-pro-form') { const result = await this.request('billing/change', 'POST', { plan: 'pro', seats: 1 }); this.applyBilling(result); this.toast('Change scheduled'); return; }
			if (form.id === 'checkout-team-form') { const result = await this.request('billing/checkout', 'POST', { plan: 'team', seats: Number(data.get('seats')) }); location.assign(result.url); return; }
			if (form.id === 'white-label-domain-form') { await this.whiteLabelRequest('white-label/domain', 'PUT', { hostname: data.get('hostname') }); this.toast('Domain saved'); return; }
			if (form.id === 'login') this.toast((await this.request('/auth/login', 'POST', { email: data.get('email') })).message);
			if (form.id === 'access-token-form') { ++this.tokensVersion; const row = await this.request('access-tokens', 'POST', { name: form.elements.name.value, days: Number(form.elements.days.value), scopes: [...form.querySelectorAll('[name=scopes]:checked')].map(input => input.value) }); ++this.tokensVersion; this.update('[data-access-token="' + row.id + '"]', '#access-tokens', row.html); document.querySelector('#token-secret-value').textContent = row.token; document.querySelector('#token-secret').hidden = false; form.reset(); return; }
			if (form.id === 'profile-form') {
				const result = await this.request('profile', 'PATCH', { name: data.get('name'), email: data.get('email') });
				this.update('#account-avatar', 'header .dropdown', result.avatar);
				this.update('[data-member="' + result.member.id + '"]', '#members', result.member.html);
				document.querySelector('#profile-status').textContent = result.pending_email ? 'Verification sent to ' + result.pending_email + '. Your current email remains ' + result.email + ' until confirmed.' : 'Profile saved.';
				this.toast(result.pending_email ? 'Name saved. Check your new email to confirm the change.' : 'Profile saved');
			}
			if (form.id === 'account-form') {
				await this.request('account', 'PATCH', { name: data.get('name') });
				document.querySelector('#account-switch').selectedOptions[0].textContent = data.get('name');
				this.toast('Account saved');
			}
			if (form.id === 'team-member-form') {
				const result = await this.request('team/members', 'POST', { name: data.get('name'), email: data.get('email'), password: data.get('password'), send_welcome_email: data.has('send_welcome_email') });
				this.update('[data-member="' + result.member._id + '"]', '#members', result.html);
				form.reset();
				document.querySelector('#team-member-generated-password').value = ''; document.querySelector('#team-member-password-result').classList.add('d-none');
				if (result.temporary_password) { document.querySelector('#team-member-generated-password').value = result.temporary_password; document.querySelector('#team-member-password-result').classList.remove('d-none'); }
				await this.refreshBilling(); this.toast('User added');
			}
			if (groupForm) {
				const id = form.dataset.groupId;
				const result = await this.request('team/groups' + (id ? '/' + id : ''), id ? 'PATCH' : 'POST', { name: data.get('name'), users: data.getAll('users') });
				this.update('[data-group="' + result.group._id + '"]', '#groups', result.html);
				if (!id) { form.reset(); form.classList.add('d-none'); }
				this.toast('Group saved');
			}
			if (form.id === 'record-form') { this.submitting = true; await this.submit(data); bootstrap.Modal.getInstance(document.querySelector('#form-modal')).hide(); this.toast('Saved'); }
		} catch (error) { this.toast(error.message, 'error'); }
		finally { this.submitting = false; if (button) button.disabled = false; }
	}
	async confirm(title) { return (await Swal.fire({ title, icon: 'warning', showCancelButton: true, allowOutsideClick: false, allowEscapeKey: false, confirmButtonText: 'Confirm' })).isConfirmed; }
	async snippet(id, value, snapshot = null) {
		const library = snapshot || this.libraries.get(this.selected);
		const previous = library.snippets.find(snippet => snippet.id === id);
		const result = await this.request('libraries/' + library._id + '/snippets', 'POST', { base_revision: library.revision, changes: [{ id: id || crypto.randomUUID(), base_revision: previous?.revision ?? null, base: previous || null, value }] });
		await this.apply(result);
		await this.poll();
	}
	selectionItems() {
		const library = this.libraries.get(this.selected);
		return library?.snippets.filter(item => this.selectedSnippets.has(item.id)).map(item => ({ id: item.id, base_revision: item.revision })) || [];
	}
	syncSelection() {
		const library = this.libraries.get(this.selected);
		const allowed = new Set(library?.permissions.edit ? library.snippets.map(item => item.id) : []);
		for (const id of this.selectedSnippets) if (!allowed.has(id)) this.selectedSnippets.delete(id);
		if (!allowed.has(this.selectionAnchor)) this.selectionAnchor = null;
		for (const input of document.querySelectorAll('[data-select-snippet]')) input.checked = this.selectedSnippets.has(input.dataset.selectSnippet);
		const all = document.querySelector('[data-select-all]');
		if (all) {
			all.disabled = !allowed.size;
			all.checked = allowed.size > 0 && this.selectedSnippets.size === allowed.size;
			all.indeterminate = this.selectedSnippets.size > 0 && !all.checked;
			document.querySelector('[data-select-all-label]').textContent = all.checked ? 'Deselect all' : 'Select all';
			document.querySelector('.bulk-actions').hidden = !this.selectedSnippets.size;
			document.querySelector('[data-selection-count]').textContent = this.selectedSnippets.size + ' selected';
		}
	}
	selectSnippet(id, checked, range) {
		const library = this.libraries.get(this.selected);
		if (!library?.permissions.edit) return;
		const ids = [...document.querySelectorAll('[data-select-snippet]')].map(input => input.dataset.selectSnippet);
		const index = ids.indexOf(id);
		if (index < 0) return;
		const anchor = range ? ids.indexOf(this.selectionAnchor) : index;
		for (const item of ids.slice(Math.min(anchor < 0 ? index : anchor, index), Math.max(anchor < 0 ? index : anchor, index) + 1)) {
			if (checked) this.selectedSnippets.add(item); else this.selectedSnippets.delete(item);
		}
		if (!range || anchor < 0) this.selectionAnchor = id;
		this.syncSelection();
	}
	async applyBatch(result, clear = true) {
		if (clear) { this.selectedSnippets.clear(); this.selectionAnchor = null; }
		for (const update of result.updates || []) await this.apply(update);
		this.syncSelection();
	}
	async batchAction(action) {
		const source = this.selected;
		const items = this.selectionItems();
		if (!items.length) return;
		if (action === 'trash') {
			if (await this.confirm('Move ' + items.length + ' selected snippets to Trash?')) await this.applyBatch(await this.request('snippets/batch', 'POST', { action, source_library: source, items }));
		} else await this.form('move', { library: source }, async fields => this.applyBatch(await this.request('snippets/batch', 'POST', { action, source_library: source, destination_library: fields.get('destination_library'), items })));
	}
	async onClick(event) {
		const input = event.target.closest('[data-select-snippet],[data-select-all]');
		if (input) {
			if (input.disabled) return;
			if (input.hasAttribute('data-select-all')) {
				this.selectedSnippets.clear();
				if (input.checked) for (const item of this.libraries.get(this.selected)?.snippets || []) this.selectedSnippets.add(item.id);
				this.selectionAnchor = null; this.syncSelection();
			} else this.selectSnippet(input.dataset.selectSnippet, input.checked, event.shiftKey);
			return;
		}
		if (event.target.closest('.snippet-selection label')) return;
		const row = event.target.closest('.snippet[data-snippet]');
		if (row && event.shiftKey && !event.target.closest('button,a,input')) { this.selectSnippet(row.dataset.snippet, !this.selectedSnippets.has(row.dataset.snippet), true); return; }
		if (row && !event.target.closest('button,a,input,textarea,select,[contenteditable="true"]') && !window.getSelection()?.toString()) return this.editSnippet(this.libraries.get(this.selected), row.dataset.snippet);
		const card = event.target.closest('.library');
		if (card && !window.getSelection()?.toString()) return this.open(card.dataset.id);
		const button = event.target.closest('button');
		if (!button) return;
		if (button.dataset.settingsOpen) { bootstrap.Modal.getOrCreateInstance(document.querySelector('#settings')).show(); this.settingsTab(button.dataset.settingsOpen); return; }
		if (button.hasAttribute('data-start-trial')) { button.disabled = true; try { this.applyBilling(await this.request('billing/trial', 'POST', {})); this.toast('Pro trial started'); } finally { button.disabled = false; } return; }
		if (button.dataset.checkoutPlan) { button.disabled = true; try { location.assign((await this.request('billing/checkout', 'POST', { plan: button.dataset.checkoutPlan, seats: 1 })).url); } finally { button.disabled = false; } return; }
		if (button.hasAttribute('data-billing-portal')) { button.disabled = true; try { location.assign((await this.request('billing/portal', 'POST', {})).url); } finally { button.disabled = false; } return; }
		if (button.hasAttribute('data-checkout-team')) { document.querySelector('#checkout-team-form').hidden = false; document.querySelector('#checkout-team-seats').focus(); return; }
		if (button.hasAttribute('data-cancel-team-checkout')) { document.querySelector('#checkout-team-form').hidden = true; return; }
		if (button.dataset.whiteLabelDelete && await this.confirm('Remove this brand asset?')) { this.applyWhiteLabel(await this.request('white-label/assets/' + button.dataset.whiteLabelDelete, 'DELETE')); return; }
		if (button.hasAttribute('data-white-label-verify')) { button.disabled = true; try { await this.whiteLabelRequest('white-label/domain/verify', 'POST', {}); this.toast('Domain verification started'); } finally { button.disabled = false; } return; }
		if (button.hasAttribute('data-white-label-refresh')) { button.disabled = true; try { await this.whiteLabelRequest('white-label/domain/refresh', 'POST', {}); } finally { button.disabled = false; } return; }
		if (button.hasAttribute('data-white-label-remove-domain') && await this.confirm('Remove this custom domain?')) { await this.whiteLabelRequest('white-label/domain', 'DELETE'); return; }
		if (button.hasAttribute('data-bulk-move')) return this.batchAction('move');
		if (button.hasAttribute('data-bulk-trash')) return this.batchAction('trash');
		if (button.hasAttribute('data-restore-trash')) {
			const target = JSON.parse(button.closest('[data-trash-id]').dataset.target);
			const result = await this.request('trash/action', 'POST', { target, action: 'restore' });
			if (result.library?.state === 'active') this.tombstones.delete(result.library._id);
			await this.apply(result);
			await this.loadTrash();
			this.toast('Restored');
			return;
		}
		if (button.id === 'empty-trash') {
			const targets = this.trashItems.filter(item => item.can_purge);
			if (!targets.length || !await this.confirm('Permanently remove ' + targets.length + ' eligible Trash items? This cannot be undone.')) return;
			await this.request('trash/empty', 'POST', { targets });
			await this.loadTrash(); this.toast('Trash emptied'); return;
		}
		if (button.id === 'scroll-top') { window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
		if (button.id === 'search-trigger') return this.openSearch();
		if (button.dataset.settingsTab) return this.settingsTab(button.dataset.settingsTab);
		if (button.id === 'dismiss-token') { document.querySelector('#token-secret-value').textContent = ''; document.querySelector('#token-secret').hidden = true; return; }
		if (button.id === 'copy-team-member-password') { await navigator.clipboard.writeText(document.querySelector('#team-member-generated-password').value); this.toast('Password copied'); return; }
		if (button.id === 'dismiss-team-member-password') { document.querySelector('#team-member-generated-password').value = ''; document.querySelector('#team-member-password-result').classList.add('d-none'); return; }
		if (button.id === 'retry-tokens') { button.disabled = true; try { await this.tokens(); } finally { button.disabled = false; } return; }
		if (button.dataset.revokeToken && await this.confirm('Revoke this integration?')) { button.disabled = true; ++this.tokensVersion; try { await this.request('access-tokens/' + button.dataset.revokeToken, 'DELETE'); ++this.tokensVersion; document.querySelector('[data-access-token="' + button.dataset.revokeToken + '"]')?.remove(); } finally { button.disabled = false; } return; }
		if (button.dataset.searchLibrary) {
			const id = button.dataset.searchLibrary;
			const snippet = button.dataset.searchSnippet;
			let library;
			if (snippet) {
				const detail = await this.request('library-view/' + id);
				library = detail.library;
				if (library.state !== 'active' || !library.snippets.some(entry => entry.id === snippet)) throw new Error('This snippet is no longer available. Search again.');
				await this.apply(detail);
			}
			await this.open(id);
			this.searchFocus = snippet ? null : document.querySelector('[data-id="' + id + '"]');
			const modal = document.querySelector('#search-modal');
			if (modal.classList.contains('show')) await new Promise(resolve => { modal.addEventListener('hidden.bs.modal', resolve, { once: true }); bootstrap.Modal.getInstance(modal).hide(); });
			if (snippet) await this.editSnippet(library, snippet);
			return;
		}
		const data = button.dataset;
		const library = this.libraries.get(this.selected);
		if (button.dataset.copySnippet) { const library = this.libraries.get(this.selected); const entry = library.snippets.find(item => item.id === button.dataset.copySnippet); if (['template', 'rich_text'].includes(entry.content.type)) return this.templateFill.open(entry.content, async () => { const current = await this.request('library-view/' + library._id); if (!current.library.snippets.some(item => item.id === entry.id && item.revision === entry.revision)) throw new Error('Snippet changed; reopen it before copying.'); }); await navigator.clipboard.writeText(entry.replace); return this.toast('Copied'); }
		if (button.dataset.importFormat) { this.importSource = null; this.importFormat = button.dataset.importFormat; return this.form('import', { format: this.importFormat }, async () => {
			const selected = [...document.querySelectorAll('[data-import-key]:checked')].map(input => ({ key: input.dataset.importKey, trigger: Abbreviation.normalize(document.querySelector('[data-import-trigger="' + input.dataset.importKey + '"]').value) }));
			await this.applyBatch(await this.request('import/' + this.importFormat, 'POST', { source: this.importSource, filename: this.importFilename, selected }), false);
		}); }
		if (button.id === 'preview-import') {
			const file = document.querySelector('#import-file').files[0];
			if (!file || file.size > (this.importFormat === 'typerelay' ? 16 : 8) * 1048576) throw new Error('Choose an export within the size limit');
			button.disabled = true; document.querySelector('#record-form button[type=submit]').disabled = true;
			try {
				if (this.importFormat === 'typerelay') { await this.apply(await this.bundle(file)); bootstrap.Modal.getInstance(document.querySelector('#form-modal')).hide(); this.toast('Bundle imported'); return; }
				this.importSource = await file.text(); this.importFilename = file.name;
				const preview = await this.request('import/' + this.importFormat + '/preview', 'POST', { source: this.importSource, filename: this.importFilename });
				document.querySelector('#import-preview').replaceChildren(this.fragment(preview.html));
				document.querySelector('#record-form button[type="submit"]').disabled = !preview.entries.some(entry => !entry.error);
			} finally { button.disabled = false; }
			return;
		}
		if (button.id === 'new-library') return this.form('library', {}, async fields => this.apply(await this.request('libraries', 'POST', { name: fields.get('name'), yaml: fields.get('yaml') })));
		if ('librarySettings' in data) return this.form('library', { library: library._id }, async fields => this.apply(await this.request('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: fields.get('name'), shared: fields.has('shared'), editable: fields.get('editable') === 'true', members: fields.getAll('members'), groups: fields.getAll('groups') })));
		if ('addSnippet' in data || data.editSnippet) return this.editSnippet(library, data.editSnippet);
		if (data.deleteSnippet && await this.confirm('Move this snippet to Trash?')) return this.snippet(data.deleteSnippet, null);
		if (data.deleteLibrary && await this.confirm('Move this library and its active snippets to Trash?')) {
			await this.apply(await this.request('libraries/' + data.deleteLibrary, 'PATCH', { base_revision: library.revision, deleted: true }));
			return bootstrap.Modal.getInstance(document.querySelector('#form-modal')).hide();
		}
		if (button.id === 'preview') {
			const preview = await this.request('import/preview', 'POST', { yaml: document.querySelector('#yaml').value });
			document.querySelector('#preview-result').textContent = 'Valid: ' + preview.matches.length + ' snippets';
		}
		if (data.role || data.removeMember) {
			if (data.removeMember && !await this.confirm('Remove team access?')) return;
			const id = data.role || data.removeMember;
			await this.request('team/members/' + id, 'PATCH', data.role ? { role: data.next } : {});
			if (data.removeMember) document.querySelector('[data-member="' + id + '"]').remove();
			else this.update('[data-member="' + id + '"]', '#members', await this.request('fragments/member/' + id, 'GET', null, true));
			await this.refreshBilling();
		}
		if (button.id === 'new-group') { const form = document.querySelector('#group-create-form'); form.classList.remove('d-none'); form.elements.name.focus(); return; }
		if ('editGroup' in data) { const row = button.closest('[data-group]'); row.querySelector('.group-display').hidden = true; const form = row.querySelector('[data-group-form]'); form.classList.remove('d-none'); form.elements.name.focus(); return; }
		if ('cancelGroup' in data) { const form = button.closest('[data-group-form]'); form.reset(); form.classList.add('d-none'); form.closest('[data-group]')?.querySelector('.group-display').removeAttribute('hidden'); return; }
		if (data.deleteGroup && await this.confirm('Delete this group and its grants?')) {
			await this.request('team/groups/' + data.deleteGroup, 'PATCH', { deleted: true });
			document.querySelector('[data-group="' + data.deleteGroup + '"]').remove();
		}
		if (data.revokeInvitation && await this.confirm('Revoke this invitation?')) { await this.request('team/invitations/' + data.revokeInvitation, 'DELETE'); document.querySelector('[data-invitation="' + data.revokeInvitation + '"]').remove(); await this.refreshBilling(); }
		if (data.revokeDevice && await this.confirm('Revoke this device?')) { button.disabled = true; ++this.devicesVersion; try { await this.request('devices/' + data.revokeDevice, 'DELETE'); ++this.devicesVersion; document.querySelector('[data-device="' + data.revokeDevice + '"]')?.remove(); } finally { button.disabled = false; } }
		if (data.resolve) return this.form('conflict', { library: data.library, conflict: data.resolve }, async fields => {
			const current = (await this.request('library-view/' + data.library)).library;
			const result = await this.request('conflicts/' + data.resolve, 'POST', { base_revision: current.revision, choice: fields.get('choice'), value: await this.snippetValue(fields) });
			await this.apply(result);
			document.querySelector('[data-conflict="' + data.resolve + '"]').remove();
		});
		if (button.id === 'logout') { await this.request('/auth/logout', 'POST', {}); location.href = '/'; }
	}
	async poll() {
		if (this.polling) return;
		this.polling = true;
		try {
		const result = await this.request('sync?cursor=' + this.cursor);
		for (const library of result.libraries) {
			if (library.state !== "active") { await this.apply({ library }); continue; }
			this.tombstones.delete(library._id);
			// Reuse mutation updater; fetch per-item snippets only when the revision changes.
			const prior = this.libraries.get(library._id);
			if (prior && prior.revision >= library.revision) continue;
			const detail = await this.request('library-view/' + library._id);
			await this.apply(detail);
		}
		for (const id of this.libraries.keys()) if (!result.accessible.includes(id)) await this.apply({ library: { ...this.libraries.get(id), deleted: true } });
		const conflicts = new Set(result.conflicts.map(conflict => conflict._id));
		document.querySelectorAll('[data-conflict]').forEach(node => { if (!conflicts.has(node.dataset.conflict)) node.remove(); });
		for (const conflict of result.conflicts) if (!document.querySelector('[data-conflict="' + conflict._id + '"]')) this.update('[data-conflict="' + conflict._id + '"]', '#conflicts', await this.request('fragments/conflict/' + conflict._id, 'GET', null, true));
		if (document.querySelector('#trash')?.classList.contains('show')) await this.loadTrash();
		this.cursor = result.cursor;
		} finally { this.polling = false; }
	}
	async loadTrash() {
		const result = await this.request('trash');
		const template = this.fragment(result.html);
		const ids = new Set(result.items.map(item => item.type + '-' + item.id));
		document.querySelectorAll('[data-trash-id]').forEach(node => { if (!ids.has(node.dataset.trashId)) node.remove(); });
		for (const node of template.querySelectorAll('[data-trash-id]')) {
			const previous = document.querySelector('[data-trash-id="' + node.dataset.trashId + '"]');
			if (!previous) document.querySelector('#trash-items').append(node);
			else if (previous.dataset.target !== node.dataset.target) previous.replaceWith(node);
		}
		this.trashItems = result.items;
		const count = result.items.filter(item => item.can_purge).length;
		document.querySelector('#empty-trash').disabled = count === 0;
		document.querySelector('#empty-trash').textContent = 'Empty Trash (' + count + ')';
		document.querySelector('#trash-empty').hidden = result.items.length !== 0;
	}
	async devices() {
		const version = ++this.devicesVersion;
		const devices = await this.request('devices');
		for (const device of devices) {
			if (version !== this.devicesVersion) return;
			const html = await this.request('fragments/device/' + device._id, 'GET', null, true);
			if (version !== this.devicesVersion) return;
			this.update('[data-device="' + device._id + '"]', '#devices', html);
		}
		if (version !== this.devicesVersion) return;
		const ids = new Set(devices.map(device => device._id));
		for (const node of document.querySelectorAll('[data-device]')) if (!ids.has(node.dataset.device)) node.remove();
	}
	async accept(token) { if (await this.confirm('Join this TypeRelay team?')) { const result = await this.request('team/accept', 'POST', { token }); location.href = '/?account=' + result.account; } }
}
const client = new TypeRelay();
export { client };
