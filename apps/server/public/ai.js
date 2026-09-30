export class AiClient {
	constructor({ request, identity, notify, manage, admin = false }) {
		this.request = request; this.identity = identity; this.notify = notify; this.manage = manage; this.admin = admin; this.jobs = new Set(); this.bindings = new WeakMap(); this.results = new WeakMap(); this.status = null;
		document.addEventListener('change', event => this.change(event).catch(error => this.notify(error.message, 'error')));
		document.addEventListener('click', event => this.click(event).catch(error => this.notify(error.message, 'error')));
		document.addEventListener('submit', event => { const form = event.target; if (form.matches('[data-ai-routes-form],[data-ai-connection-form]')) { event.preventDefault(); event.stopImmediatePropagation(); void this.busy(event.submitter, () => this.submit(form)); } });
		window.addEventListener('storage', event => { if (event.key === this.localKey()) this.update(); });
		window.addEventListener('focus', () => { if (!this.admin) void this.refresh().catch(() => {}); });
	}
	localKey() { return 'typerelay.ai.enabled'; }
	localEnabled() { return localStorage.getItem(this.localKey()) !== 'false'; }
	cancel() { for (const job of this.jobs) job.abort(); this.jobs.clear(); }
	reset() { this.cancel(); this.status = null; for (const node of document.querySelectorAll('[data-ai-results]')) node.replaceChildren(); for (const node of document.querySelectorAll('[data-ai-proposal]')) node.hidden = true; this.update(); }
	update() {
		const enabled = this.localEnabled() && this.status?.enabled;
		if (!enabled) this.cancel();
		for (const control of document.querySelectorAll('[data-ai-local]')) control.checked = this.localEnabled();
		for (const control of document.querySelectorAll('[data-ai-personal]')) control.checked = this.status?.personal_enabled !== false;
		for (const node of document.querySelectorAll('[data-ai-status]')) {
			const usage = Object.values(this.status?.effective || {}).some(route => route.managed) ? this.status?.allowance : null;
			node.textContent = !this.status ? 'Connect to your server to use AI.' : !enabled ? 'AI is disabled.' : Object.values(this.status.effective).map(value => value.error || value.name + ' · ' + value.model).filter((value, index, all) => all.indexOf(value) === index).join(' / ') + (usage ? ' · Managed allowance: ' + usage.used + '/' + usage.limit + ' today (UTC)' : '');
		}
		for (const workflow of ['authoring', 'search']) {
			const route = this.status?.effective[workflow];
			for (const node of document.querySelectorAll('[data-ai-effective="' + workflow + '"]')) node.textContent = !enabled ? 'AI is disabled.' : route?.error || (route ? route.name + ' · ' + route.model + ' · ' + route.scope : 'Connect to use AI.');
			for (const button of document.querySelectorAll(workflow === 'authoring' ? '[data-ai-generate],[data-ai-apply]' : '[data-ai-search-run]')) if (button.dataset.aiBusy !== 'true') button.disabled = !enabled || !!route?.error;
		}
		for (const control of document.querySelectorAll('[data-ai-launch]')) { control.disabled = !enabled; control.setAttribute('aria-disabled', String(!enabled)); }
	}
	acceptStatus(status) { if (!status || this.pendingPolicy) return; const same = JSON.stringify(this.status?.identity) === JSON.stringify(status.identity) && this.context === this.identity(); if (same && Object.entries(this.status?.revisions || {}).some(([scope, revision]) => revision > (status.revisions?.[scope] || 0))) return; if (!same) this.cancel(); this.status = status; this.context = this.identity(); this.update(); }
	async refresh() { const result = await this.request('/settings'); this.acceptStatus(result.status); return result; }
	async ready(workflow) { if (!this.localEnabled()) throw Error('AI is disabled in this app'); await this.refresh(); if (!this.localEnabled()) throw Error('AI is disabled in this app'); if (!this.status.enabled) throw Error('AI is disabled for this account or user'); if (this.status.effective[workflow].error) throw Error(this.status.effective[workflow].error); }
	fragment(html) { return new DOMParser().parseFromString(html, 'text/html').body.firstElementChild; }
	async busy(control, action) {
		if (!control || control.dataset.aiBusy === 'true') return;
		control.dataset.aiBusy = 'true'; control.disabled = true;
		try { await action(); } catch (error) { if (error.name !== 'AbortError' && !/cancelled/.test(error.message)) this.notify(error.message, 'error'); }
		finally { delete control.dataset.aiBusy; if (control.isConnected) control.disabled = false; this.update(); }
	}
	async change(event) {
		const control = event.target;
		if (control.matches('[data-ai-local]')) { localStorage.setItem(this.localKey(), String(control.checked)); this.update(); }
		if (control.matches('[data-ai-personal]')) {
			this.cancel(); control.disabled = true; const previous = this.status; this.pendingPolicy = true;
			if (this.status) { this.status = { ...this.status, personal_enabled: control.checked, enabled: control.checked && this.status.team_enabled && this.status.installation_enabled }; this.update(); }
			try { const current = await this.request('/settings?scope=personal'); const result = await this.request('/settings', 'PATCH', { scope: 'personal', enabled: control.checked, routes: current.settings.routes, revision: current.settings.revision }); this.pendingPolicy = false; this.acceptStatus(result.status); for (const root of document.querySelectorAll('[data-ai-configuration="personal"]')) { this.updateConfig(root, result); root.querySelector('[name="enabled"]').checked = result.settings.enabled; } }
			catch (error) { this.status = previous; this.update(); throw error; } finally { this.pendingPolicy = false; control.disabled = false; }
		}
		if (control.matches('[data-ai-configuration] select[name$="_connection"]')) this.routeControls(this.config(control));
	}
	routeControls(root) { for (const row of root.querySelectorAll('[data-ai-route]')) { const selected = row.querySelector('select[name$="_connection"]').value; for (const control of row.querySelectorAll('input,select[name$="_protocol"],button')) control.disabled = !selected; } }
	async loadSettings(root) {
		for (const slot of root.querySelectorAll('[data-ai-configuration-slot]')) {
			if (slot.firstElementChild) continue;
			const scope = slot.dataset.aiConfigurationSlot; const result = await this.request(this.admin ? '/settings' : '/settings?scope=' + scope);
			slot.append(this.fragment(result.html));
			this.acceptStatus(result.status);
		}
		this.routeControls(root);
		this.update();
	}
	config(node) { return node.closest('[data-ai-configuration]'); }
	configValue(root) { return JSON.parse(root.dataset.settings); }
	updateConfig(root, result) {
		if (!root.isConnected || result.settings.revision <= this.configValue(root).revision) return;
		if (result.settings) root.dataset.settings = JSON.stringify(result.settings);
		this.acceptStatus(result.status);
		if (result.id) {
			const container = root.querySelector('[data-ai-connections]'); const previous = [...container.children].find(node => node.dataset.aiConnection === result.id);
			if (result.deleted) previous?.remove(); else { const node = this.fragment(result.html); if (previous) previous.replaceWith(node); else container.append(node); }
		}
		for (const select of root.querySelectorAll('[name$="_connection"]')) {
			const selected = select.value; const connections = result.settings.connections;
			for (const option of [...select.options]) if (option.value && !connections.some(connection => connection.id === option.value)) option.remove();
			for (const connection of connections) { let option = [...select.options].find(option => option.value === connection.id); if (!option) { option = new Option(connection.name, connection.id); select.add(option); } option.textContent = connection.name; }
			select.value = connections.some(connection => connection.id === selected) ? selected : '';
		}
		this.routeControls(root);
		this.update();
	}
	async submit(form) {
		this.cancel();
		const root = this.config(form); const scope = root.dataset.aiConfiguration; const data = new FormData(form);
		if (form.matches('[data-ai-connection-form]')) {
			const result = await this.request('/connections', 'POST', { scope, revision: this.configValue(root).revision, id: form.dataset.id || undefined, name: data.get('name'), provider: data.get('provider'), base_url: data.get('base_url') || '', api_key: data.get('api_key'), clear_key: data.has('clear_key'), no_auth: data.has('no_auth') });
			this.updateConfig(root, result);
			if (form.isConnected) form.querySelector('[name="api_key"]').value = '';
			if (form.isConnected && !form.dataset.id) { form.reset(); form.closest('details').open = false; }
		} else {
			const routes = {};
			for (const workflow of ['authoring', 'search']) if (data.get(workflow + '_connection')) routes[workflow] = { connection: data.get(workflow + '_connection'), model: data.get(workflow + '_model'), protocol: data.get(workflow + '_protocol') };
			const result = await this.request('/settings', 'PATCH', { scope, enabled: data.has('enabled'), routes, revision: this.configValue(root).revision, ...(this.admin ? { daily_limit: Number(data.get('daily_limit')), private_endpoints: data.get('private_endpoints') } : {}) });
			this.updateConfig(root, result);
		}
		this.notify('AI settings saved');
	}
	async click(event) {
		const launch = event.target.closest('[data-ai-launch]'); if (launch && (!this.localEnabled() || !this.status?.enabled)) { event.preventDefault(); return; }
		const button = event.target.closest('button'); if (!button) return;
		if (button.matches('[data-ai-refresh-scope]')) return this.busy(button, async () => { if (!await this.confirm('Refresh saved AI settings? Unsaved changes in this section will be discarded.', 'Refresh')) return; const root = this.config(button); const result = await this.request(this.admin ? '/settings' : '/settings?scope=' + root.dataset.aiConfiguration); const node = this.fragment(result.html); root.replaceWith(node); this.routeControls(node); if (result.status) this.status = result.status; this.update(); });
		if (button.matches('[data-ai-manage]')) { event.preventDefault(); await this.manage(); return; }
		if (button.matches('[data-ai-edit-connection]')) { button.closest('[data-ai-connection]').querySelector('form').hidden = false; return; }
		if (button.matches('[data-ai-cancel-connection]')) { const form = button.closest('form'); form.querySelector('[name="api_key"]').value = ''; form.hidden = true; return; }
		if (button.matches('[data-ai-delete-connection]')) {
			return this.busy(button, async () => { if (!await this.confirm('Remove this AI connection?')) return; this.cancel(); const root = this.config(button); this.updateConfig(root, await this.request('/connections/' + encodeURIComponent(button.dataset.aiDeleteConnection), 'DELETE', { scope: root.dataset.aiConfiguration, revision: this.configValue(root).revision })); });
		}
		if (button.matches('[data-ai-models],[data-ai-verify]')) {
			return this.busy(button, async () => {
				const root = this.config(button); const workflow = button.dataset.aiModels || button.dataset.aiVerify; const form = root.querySelector('[data-ai-routes-form]'); const connection = form.elements[workflow + '_connection'].value; const model = form.elements[workflow + '_model'].value; const protocol = form.elements[workflow + '_protocol'].value;
				const response = await this.request(button.hasAttribute('data-ai-models') ? '/models' : '/verify', 'POST', { scope: root.dataset.aiConfiguration, connection, model, protocol });
				const status = root.querySelector('[data-ai-connection-status]');
				if (response.models) { const list = root.querySelector('#ai-models-' + root.dataset.aiConfiguration + '-' + workflow); list.replaceChildren(...response.models.map(model => new Option(model.name, model.id))); status.textContent = response.models.length ? 'Models loaded. Choose or enter a model ID, then Verify.' : 'Enter the model ID manually, then Verify.'; }
				else status.textContent = 'Selected model verified.';
			});
		}
		if (button.matches('[data-ai-generate],[data-ai-apply],[data-ai-discard]')) {
			const root = button.closest('[data-ai-author]'); const binding = this.bindings.get(root); if (!binding) return;
			if (button.hasAttribute('data-ai-discard')) { binding.job?.abort(); binding.proposal = null; root.querySelector('[data-ai-proposal]').hidden = true; return; }
			return this.busy(button, async () => {
				if (button.hasAttribute('data-ai-apply')) {
					if (!this.localEnabled() || !binding.proposal || !root.isConnected) return;
					await this.ready('authoring');
					if (JSON.stringify(await binding.read()) !== binding.snapshot) throw Error('The snippet changed. Generate a new proposal to preserve your edits.');
					const proposal = structuredClone(binding.proposal); const text = root.querySelector('[data-ai-draft]').value;
					if (proposal.content.type === 'rich_text') proposal.content.markdown = text; else proposal.content.text = text;
					await binding.apply(proposal); binding.proposal = null; root.querySelector('[data-ai-proposal]').hidden = true; root.querySelector('[data-ai-author-status]').textContent = 'Draft applied. Review it, then Save.'; return;
				}
				binding.job?.abort(); await this.ready('authoring'); const entry = await binding.read(); if (!this.localEnabled() || !this.status.enabled) return; const snapshot = JSON.stringify(entry); const job = new AbortController(); binding.job = job; this.jobs.add(job); binding.snapshot = snapshot;
				try {
					const result = await this.request('/author', 'POST', { request_id: crypto.randomUUID(), action: root.querySelector('[data-ai-action]').value, prompt: root.querySelector('[data-ai-prompt]').value, entry: entry.entry || entry, library: entry.library }, job.signal);
					if (job.signal.aborted || !root.isConnected || JSON.stringify(await binding.read()) !== snapshot || !this.localEnabled()) return;
					this.acceptStatus(result.status); if (!this.status.enabled || job.signal.aborted) return; binding.proposal = result.proposal; root.querySelector('[data-ai-draft]').value = result.proposal.content.markdown ?? result.proposal.content.text; root.querySelector('[data-ai-proposal]').hidden = false; root.querySelector('[data-ai-author-status]').textContent = 'Review the proposal before applying it.';
				} finally { this.jobs.delete(job); }
			});
		}
		if (button.matches('[data-ai-search-run]')) {
			const root = button.closest('[data-ai-search]'); const binding = this.bindings.get(root); if (!binding) return;
			return this.busy(button, async () => {
				binding.job?.abort(); await this.ready('search'); const query = root.querySelector('[data-ai-query]').value; const job = new AbortController(); binding.job = job; this.jobs.add(job);
				try {
					const payload = await binding.payload();
					if (job.signal.aborted || !this.localEnabled() || !this.status.enabled) return;
					const result = await this.request('/search', 'POST', { request_id: crypto.randomUUID(), query, ...payload }, job.signal);
					if (job.signal.aborted || !root.isConnected || query !== root.querySelector('[data-ai-query]').value || !this.localEnabled()) return;
					this.acceptStatus(result.status); if (!this.status.enabled || job.signal.aborted) return; this.results.set(root, result.results); root.querySelector('[data-ai-results]').replaceChildren(this.fragment(result.html)); root.querySelector('[data-ai-search-status]').textContent = result.results.length + ' matching snippets';
				} finally { this.jobs.delete(job); }
			});
		}
		if (button.matches('[data-ai-result]')) {
			const root = button.closest('[data-ai-search]'); const binding = this.bindings.get(root); const result = this.results.get(root)?.find(result => result.id === button.dataset.snippet && result.library === button.dataset.library && result.source === button.dataset.source);
			if (result && binding) return this.busy(button, () => binding.select(result));
		}
	}
	async confirm(message, label = 'Remove') { if (globalThis.Swal) return (await globalThis.Swal.fire({ title: message, showCancelButton: true, reverseButtons: true, confirmButtonText: label })).isConfirmed; return globalThis.confirm(message); }
	bindAuthor(root, read, apply) {
		if (!root) return;
		const binding = { read, apply }; this.bindings.set(root, binding);
		const parent = root.closest('form');
		parent?.addEventListener('input', event => { if (!root.contains(event.target)) { binding.job?.abort(); binding.proposal = null; root.querySelector('[data-ai-proposal]').hidden = true; } });
		parent?.addEventListener('change', event => { if (!root.contains(event.target)) { binding.job?.abort(); binding.proposal = null; root.querySelector('[data-ai-proposal]').hidden = true; } });
		this.update();
	}
	bindSearch(root, payload, select) {
		if (!root) return;
		const binding = { payload, select }; this.bindings.set(root, binding);
		root.querySelector('[data-ai-query]').addEventListener('input', () => binding.job?.abort());
		root.querySelector('details').addEventListener('toggle', () => { if (!root.querySelector('details').open) binding.job?.abort(); });
		this.update();
	}
}
