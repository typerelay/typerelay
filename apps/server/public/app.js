class TypeRelay {
	account = document.querySelector('#workspace')?.dataset.account;
	libraries = new Map();
	tombstones = new Set();
	formOperation = null;
	submitting = false;
	selected = null;
	cursor = 0;
	polling = false;
	submit = null;
	constructor() {
		document.querySelectorAll('.library').forEach(node => this.libraries.set(node.dataset.id, JSON.parse(node.dataset.record)));
		document.addEventListener('submit', event => this.onSubmit(event));
		document.addEventListener('click', event => this.onClick(event).catch(error => this.toast(error.message, 'error')));
		document.querySelector('#search')?.addEventListener('input', () => this.filter());
		document.querySelector('#account-switch')?.addEventListener('change', event => { location.href = '/?account=' + event.target.value; });
		document.addEventListener('change', async event => {
			if (event.target.id === 'shared') document.querySelectorAll('#members-select,#groups-select').forEach(field => { field.disabled = !event.target.checked; });
			if (event.target.id === 'yaml-file' && event.target.files[0]) document.querySelector('#yaml').value = await event.target.files[0].text();
		});
		document.querySelector('#form-modal')?.addEventListener('hidden.bs.modal', () => {
			if (this.returnSettings) { this.returnSettings = false; bootstrap.Modal.getOrCreateInstance(document.querySelector('#settings')).show(); }
		});
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
		const response = await fetch(path.startsWith('/') ? path : '/api/v1/' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content, 'X-Account-Id': this.account || '' }, body: body ? JSON.stringify({ operation_id: this.submitting ? this.formOperation : crypto.randomUUID(), ...body }) : undefined });
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
		this.filter();
	}
	filter() {
		const query = document.querySelector('#search').value.toLowerCase();
		document.querySelectorAll('.library').forEach(node => {
			const library = this.libraries.get(node.dataset.id);
			node.hidden = ![library.name, ...library.snippets.flatMap(snippet => [snippet.trigger, snippet.replace])].some(text => text.toLowerCase().includes(query));
		});
	}
	async open(id) {
		this.selected = id;
		// Full detail rendering is initial navigation only.
		document.querySelector('#editor').replaceChildren(this.fragment(await this.request('editor/' + id, 'GET', null, true)));
	}
	async form(kind, params, submit) {
		document.querySelector('#form-title').textContent = ({ library: 'Library', snippet: 'Snippet', group: 'Group', conflict: 'Resolve conflict' })[kind];
		document.querySelector('#form-fields').replaceChildren();
		const template = document.createElement('template');
		template.innerHTML = await this.request('forms/' + kind + '?' + new URLSearchParams(params), 'GET', null, true);
		document.querySelector('#form-fields').replaceChildren(template.content);
		this.submit = submit;
		this.formOperation = crypto.randomUUID();
		const settings = document.querySelector('#settings');
		this.returnSettings = settings.classList.contains('show');
		if (this.returnSettings) await new Promise(resolve => { settings.addEventListener('hidden.bs.modal', resolve, { once: true }); bootstrap.Modal.getInstance(settings).hide(); });
		bootstrap.Modal.getOrCreateInstance(document.querySelector('#form-modal')).show();
	}
	async onSubmit(event) {
		event.preventDefault();
		const form = event.target;
		const data = new FormData(form);
		const button = event.submitter;
		if (button) button.disabled = true;
		try {
			if (form.id === 'login') this.toast((await this.request('/auth/login', 'POST', { email: data.get('email') })).message);
			if (form.id === 'profile-form') { await this.request('profile', 'PATCH', { name: data.get('name') }); this.toast('Profile saved'); }
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
		const button = event.target.closest('button');
		if (!button) return;
		const data = button.dataset;
		const library = this.libraries.get(this.selected);
		if (button.classList.contains('library-open')) return this.open(button.closest('[data-id]').dataset.id);
		if (button.id === 'new-library') return this.form('library', {}, async fields => this.apply(await this.request('libraries', 'POST', { name: fields.get('name'), yaml: fields.get('yaml') })));
		if ('librarySettings' in data) return this.form('library', { library: library._id }, async fields => this.apply(await this.request('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: fields.get('name'), shared: fields.has('shared'), editable: fields.get('editable') === 'true', members: fields.getAll('members'), groups: fields.getAll('groups') })));
		if ('addSnippet' in data || data.editSnippet) return this.form('snippet', { library: library._id, snippet: data.editSnippet || '' }, fields => this.snippet(data.editSnippet, { trigger: fields.get('trigger'), replace: fields.get('replace') }, library));
		if (data.deleteSnippet && await this.confirm('Delete this snippet?')) return this.snippet(data.deleteSnippet, null);
		if (data.deleteLibrary && await this.confirm('Delete this library on all connected devices?')) {
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
			const current = this.libraries.get(data.library);
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
		this.cursor = result.cursor;
		} finally { this.polling = false; }
	}
	async devices() { for (const device of await this.request('devices')) this.update('[data-device="' + device._id + '"]', '#devices', await this.request('fragments/device/' + device._id, 'GET', null, true)); }
	async accept(token) { if (await this.confirm('Join this TypeRelay team?')) { const result = await this.request('team/accept', 'POST', { token }); location.href = '/?account=' + result.account; } }
}
new TypeRelay();
