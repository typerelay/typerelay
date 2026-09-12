import { Abbreviation } from './abbreviation.js';
class TypeRelay {
	account = document.querySelector('#workspace')?.dataset.account;
	libraries = new Map();
	tombstones = new Set();
	formOperation = null;
	submitting = false;
	selected = null;
	cursor = 0;
	polling = false;
	trashItems = [];
	searchVersion = 0;
	openVersion = 0;
	searchTimer = null;
	searchFocus = null;
	submit = null;
	constructor() {
		document.querySelectorAll('.library').forEach(node => this.libraries.set(node.dataset.id, JSON.parse(node.dataset.record)));
		document.addEventListener('input', event => { if (event.target.id === 'trigger' && !event.isComposing) Abbreviation.field(event.target); });
		document.addEventListener('compositionend', event => { if (event.target.id === 'trigger') Abbreviation.field(event.target); });
		document.addEventListener('submit', event => this.onSubmit(event));
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
			if (event.target.id === 'shared') document.querySelectorAll('#members-select,#groups-select').forEach(field => { field.disabled = !event.target.checked; });
			if (event.target.id === 'yaml-file' && event.target.files[0]) document.querySelector('#yaml').value = await event.target.files[0].text();
		});
		document.querySelector('#form-modal')?.addEventListener('hidden.bs.modal', () => {
			if (this.returnSettings) { this.returnSettings = false; bootstrap.Modal.getOrCreateInstance(document.querySelector('#settings')).show(); }
		});
		document.querySelector('#trash')?.addEventListener('show.bs.modal', () => this.loadTrash().catch(error => this.toast(error.message, 'error')));
		if (this.account) {
			this.poll().catch(error => this.toast(error.message, 'error'));
			setInterval(() => this.poll().catch(() => {}), 30000);
			this.devices().catch(() => {});
			const invitation = new URL(location.href).searchParams.get('invite');
			if (invitation) this.accept(invitation);
		}
	}
	toast(title, icon = 'success') { return Swal.fire({ toast: true, position: 'top-end', title, icon, timer: 3500, showConfirmButton: false }); }
	async request(path, method = 'GET', body, raw = false) {
		const response = await fetch(path.startsWith('/') ? path : '/api/v2/' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Account-Id': this.account || '' }, body: body ? JSON.stringify({ operation_id: this.submitting ? this.formOperation : crypto.randomUUID(), ...body }) : undefined });
		if (!response.ok) throw new Error((await response.json()).error);
		return raw ? response.text() : response.json();
	}
	fragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; }
	update(selector, container, html) {
		const old = document.querySelector(selector);
		const next = this.fragment(html);
		const focused = old?.contains(document.activeElement) ? [...old.querySelectorAll('button,input,select,textarea,a')].indexOf(document.activeElement) : -1;
		const scroll = { x: window.scrollX, y: window.scrollY };
		if (old) old.replaceWith(next); else document.querySelector(container).append(next);
		if (focused >= 0) next.querySelectorAll('button,input,select,textarea,a')[focused]?.focus({ preventScroll: true });
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
			for (const fragment of result.fragments) {
				const node = document.querySelector('[data-snippet="' + fragment.id + '"]');
				if (!node || Number(node.dataset.revision) < fragment.revision || prior?.permissions.edit !== library.permissions.edit) this.update('[data-snippet="' + fragment.id + '"]', '#snippets', fragment.html);
			}
		}
		document.querySelector('[data-id="' + library._id + '"]')?.classList.toggle('active-library', this.selected === library._id);
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
		const html = await this.request('editor/' + id, 'GET', null, true);
		if (version !== this.openVersion) return;
		this.selected = id;
		document.querySelector('#editor').replaceChildren(this.fragment(html));
		document.querySelectorAll('.library').forEach(node => {
			node.classList.toggle('active-library', node.dataset.id === id);
			node.setAttribute('aria-pressed', String(node.dataset.id === id));
		});

	}
	async editSnippet(library, id) {
		await this.form('snippet', { library: library._id, snippet: id || '' }, fields => this.snippet(id, { trigger: fields.get('trigger'), replace: fields.get('replace') }, library));
		if (!library.permissions.edit) {
			document.querySelector('#form-title').textContent = 'Snippet · Read-only';
			document.querySelectorAll('#form-fields input,#form-fields textarea').forEach(field => { field.readOnly = true; });
			document.querySelector('#record-form button[type="submit"]').disabled = true;
		}
	}
	async form(kind, params, submit) {
		document.querySelector('#form-title').textContent = ({ library: 'Library', snippet: 'Snippet', group: 'Group', conflict: 'Resolve conflict' })[kind];
		document.querySelector('#form-fields').replaceChildren();
		const template = document.createElement('template');
		template.innerHTML = await this.request('forms/' + kind + '?' + new URLSearchParams(params), 'GET', null, true);
		document.querySelector('#form-fields').replaceChildren(template.content);
		document.querySelector('#record-form button[type="submit"]').disabled = false;
		this.submit = submit;
		this.formOperation = crypto.randomUUID();
		const settings = document.querySelector('#settings');
		this.returnSettings = settings.classList.contains('show');
		if (this.returnSettings) await new Promise(resolve => { settings.addEventListener('hidden.bs.modal', resolve, { once: true }); bootstrap.Modal.getInstance(settings).hide(); });
		bootstrap.Modal.getOrCreateInstance(document.querySelector('#form-modal')).show();
	}
	async onSubmit(event) {
		const form = event.target;
		if (!['login', 'profile-form', 'account-form', 'invite-form', 'record-form'].includes(form.id)) return;
		event.preventDefault();
		const abbreviation = form.querySelector('#trigger');
		if (abbreviation) Abbreviation.field(abbreviation);
		const data = new FormData(form);
		const button = event.submitter;
		if (button) button.disabled = true;
		try {
			if (form.id === 'login') this.toast((await this.request('/auth/login', 'POST', { email: data.get('email') })).message);
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
			if (form.id === 'invite-form') { const result = await this.request('team/invitations', 'POST', { email: data.get('email') }); this.update('[data-invitation="' + result.invitation + '"]', '#invitations', await this.request('fragments/invitation/' + result.invitation, 'GET', null, true)); this.toast('Invitation sent'); }
			if (form.id === 'record-form') { this.submitting = true; await this.submit(data); bootstrap.Modal.getInstance(document.querySelector('#form-modal')).hide(); this.toast('Saved'); }
		} catch (error) { this.toast(error.message, 'error'); }
		finally { this.submitting = false; if (button) button.disabled = false; }
	}
	async confirm(title) { return (await Swal.fire({ title, icon: 'warning', showCancelButton: true, confirmButtonText: 'Confirm' })).isConfirmed; }
	async snippet(id, value, snapshot = null) {
		const library = snapshot || this.libraries.get(this.selected);
		const previous = library.snippets.find(snippet => snippet.id === id);
		const result = await this.request('libraries/' + library._id + '/snippets', 'POST', { base_revision: library.revision, changes: [{ id: id || crypto.randomUUID(), base_revision: previous?.revision ?? null, base: previous || null, value }] });
		await this.apply(result);
		await this.poll();
	}
	async onClick(event) {
		const row = event.target.closest('.snippet[data-snippet]');
		if (row && !event.target.closest('button,a,input,textarea,select,[contenteditable="true"]') && !window.getSelection()?.toString()) return this.editSnippet(this.libraries.get(this.selected), row.dataset.snippet);
		const card = event.target.closest('.library');
		if (card && !window.getSelection()?.toString()) return this.open(card.dataset.id);
		const button = event.target.closest('button');
		if (!button) return;
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
		if (button.id === 'search-trigger') return this.openSearch();
		if (button.dataset.settingsTab) return this.settingsTab(button.dataset.settingsTab);
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
		}
		if (button.id === 'new-group' || data.editGroup) {
			const group = data.editGroup ? JSON.parse(data.editGroup) : null;
			return this.form('group', group ? { group: group._id } : {}, async fields => {
				const result = await this.request('team/groups' + (group ? '/' + group._id : ''), group ? 'PATCH' : 'POST', { name: fields.get('name'), users: fields.getAll('users') });
				this.update('[data-group="' + result.group._id + '"]', '#groups', await this.request('fragments/group/' + result.group._id, 'GET', null, true));
			});
		}
		if (data.deleteGroup && await this.confirm('Delete this group and its grants?')) {
			await this.request('team/groups/' + data.deleteGroup, 'PATCH', { deleted: true });
			document.querySelector('[data-group="' + data.deleteGroup + '"]').remove();
			bootstrap.Modal.getInstance(document.querySelector('#form-modal')).hide();
		}
		if (data.revokeInvitation && await this.confirm('Revoke this invitation?')) { await this.request('team/invitations/' + data.revokeInvitation, 'DELETE'); document.querySelector('[data-invitation="' + data.revokeInvitation + '"]').remove(); }
		if (data.revokeDevice && await this.confirm('Revoke this device?')) { await this.request('devices/' + data.revokeDevice, 'DELETE'); document.querySelector('[data-device="' + data.revokeDevice + '"]').remove(); }
		if (data.resolve) return this.form('conflict', { library: data.library, conflict: data.resolve }, async fields => {
			const current = (await this.request('library-view/' + data.library)).library;
			const result = await this.request('conflicts/' + data.resolve, 'POST', { base_revision: current.revision, choice: fields.get('choice'), value: { trigger: fields.get('trigger'), replace: fields.get('replace') } });
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
	async devices() { for (const device of await this.request('devices')) this.update('[data-device="' + device._id + '"]', '#devices', await this.request('fragments/device/' + device._id, 'GET', null, true)); }
	async accept(token) { if (await this.confirm('Join this TypeRelay team?')) { const result = await this.request('team/accept', 'POST', { token }); location.href = '/?account=' + result.account; } }
}
const client = new TypeRelay();
export { client };
