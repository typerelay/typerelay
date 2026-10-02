export class AiClient {
	constructor({ request, identity, notify, manage, admin = false }) {
		this.request = request; this.identity = identity; this.notify = notify; this.manage = manage; this.admin = admin; this.jobs = new Set(); this.modelJobs = new Set(); this.models = new WeakMap(); this.bindings = new WeakMap(); this.results = new WeakMap(); this.status = null;
		document.addEventListener('change', event => this.change(event).catch(error => this.notify(error.message, 'error')));
		document.addEventListener('click', event => this.click(event).catch(error => this.notify(error.message, 'error')));
		document.addEventListener('submit', event => { const form = event.target; if (form.matches('[data-ai-routes-form],[data-ai-connection-form],[data-ai-endpoints-form]')) { event.preventDefault(); event.stopImmediatePropagation(); void this.busy(event.submitter, () => this.submit(form)); } });
		document.addEventListener('keydown', event => this.tabKey(event));
		window.addEventListener('storage', event => { if (event.key === this.localKey()) this.update(); });
		window.addEventListener('focus', () => { if (!this.admin) void this.refresh().catch(() => {}); });
	}
	localKey() { return 'typerelay.ai.enabled'; }
	localEnabled() { return localStorage.getItem(this.localKey()) !== 'false'; }
	cancel() { for (const job of this.jobs) job.abort(); this.jobs.clear(); }
	reset() { this.cancel(); for (const job of this.modelJobs) job.abort(); this.modelJobs.clear(); this.status = null; for (const node of document.querySelectorAll('[data-ai-results]')) node.replaceChildren(); for (const node of document.querySelectorAll('[data-ai-proposal]')) node.hidden = true; this.update(); }
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
		finally { delete control.dataset.aiBusy; if (control.isConnected) { control.disabled = false; const root = this.config(control); if (root) this.routeControls(root); } this.update(); }
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
		if (control.matches('[data-ai-model],select[name$="_protocol"]')) { const row = control.closest('[data-ai-route]'); if (row) { if (row.querySelector('[name$="_connection"]').value) row.querySelector('[data-ai-model-status]').textContent = 'Verify this model before saving.'; this.routeControls(this.config(control)); } }
		if (control.matches('[data-ai-connection-form] select[name="provider"]')) this.providerControls(control.closest('form'));
	}
	selectTab(root, tab) {
		root.dataset.aiTab = tab;
		for (const button of root.querySelectorAll('[data-ai-config-tab]')) { const active = button.dataset.aiConfigTab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
		for (const panel of root.querySelectorAll('[data-ai-config-panel]')) panel.hidden = panel.dataset.aiConfigPanel !== tab;
	}
	tabKey(event) {
		if (!event.target.matches('[data-ai-config-tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault(); const root = this.config(event.target); const tabs = [...root.querySelectorAll('[data-ai-config-tab]')]; const index = tabs.indexOf(event.target); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
		this.selectTab(root, tabs[next].dataset.aiConfigTab); tabs[next].focus();
	}
	providerControls(form) { const compatible = form.elements.provider.value === 'compatible'; for (const node of form.querySelectorAll('[data-ai-compatible]')) node.hidden = !compatible; const url = form.querySelector('[name="base_url"]'); url.required = compatible; url.disabled = !compatible; form.elements.no_auth.disabled = !compatible; }
	routeControls(root) {
		for (const form of root.querySelectorAll('[data-ai-connection-form]')) this.providerControls(form);
		for (const row of root.querySelectorAll('[data-ai-route]')) {
			const selected = row.querySelector('select[name$="_connection"]').value; const model = row.querySelector('[data-ai-model]'); const status = row.querySelector('[data-ai-model-status]');
			if (!model.tomselect) new globalThis.TomSelect(model, { maxItems: 1, create: true, createOnBlur: true, createFilter: value => value.trim().length > 0 && value.trim().length <= 200, sortField: { field: 'text', direction: 'asc' }, maxOptions: 1000 });
			let state = this.models.get(row);
			if (!state || state.connection !== selected) {
				if (state) { state.job?.abort(); model.tomselect.clear(true); model.tomselect.clearOptions(); model.tomselect.wrapper.classList.remove('loading'); model.tomselect.wrapper.removeAttribute('aria-busy'); row.querySelector('[name$="_protocol"]').value = 'auto'; }
				state = { connection: selected, attempted: false }; this.models.set(row, state);
				status.textContent = selected ? 'Choose a model or enter its ID.' : row.dataset.aiRoute === 'search' ? 'Uses the authoring provider and model.' : 'Uses the inherited provider and model.';
			}
			if (selected) model.tomselect.enable(); else model.tomselect.disable();
			for (const control of row.querySelectorAll('select[name$="_protocol"],button')) control.disabled = !selected || control.dataset.aiBusy === 'true' || (control.hasAttribute('data-ai-models') && !!state.job) || (control.hasAttribute('data-ai-verify') && !model.value);
			if (selected && !state.attempted) void this.loadModels(row);
		}
	}
	async loadModels(row) {
		const state = this.models.get(row); if (!state?.connection) return;
		state.job?.abort(); const job = new AbortController(); state.job = job; state.attempted = true; this.modelJobs.add(job);
		const root = this.config(row); const identity = this.identity(); const model = row.querySelector('[data-ai-model]'); const status = row.querySelector('[data-ai-model-status]'); const refresh = row.querySelector('[data-ai-models]');
		status.textContent = 'Loading models…'; model.tomselect.wrapper.classList.add('loading'); model.tomselect.wrapper.setAttribute('aria-busy', 'true'); refresh.disabled = true;
		const current = () => !job.signal.aborted && row.isConnected && this.identity() === identity && this.models.get(row) === state && state.job === job && row.querySelector('[name$="_connection"]').value === state.connection;
		try {
			const response = await this.request('/models', 'POST', { scope: root.dataset.aiConfiguration, connection: state.connection }, job.signal);
			if (!current()) return;
			model.tomselect.clearOptions(); model.tomselect.addOptions(response.models.map(value => ({ value: value.id, text: value.name === value.id ? value.id : value.name + ' · ' + value.id }))); model.tomselect.refreshOptions(false);
			status.textContent = response.models.length ? 'Choose a model or enter its ID, then Verify.' : 'No models listed. Enter the model ID, then Verify.';
		} catch (error) { if (current() && error.name !== 'AbortError') { status.textContent = 'Could not load models. Enter an ID or refresh to retry.'; this.notify(error.message, 'error'); } }
		finally { this.modelJobs.delete(job); if (state.job === job) { state.job = null; if (row.isConnected && this.models.get(row) === state) { model.tomselect.wrapper.classList.remove('loading'); model.tomselect.wrapper.removeAttribute('aria-busy'); refresh.disabled = !state.connection; } } }
	}
	destroyConfig(root) { for (const row of root.querySelectorAll('[data-ai-route]')) { this.models.get(row)?.job?.abort(); row.querySelector('[data-ai-model]').tomselect?.destroy(); } }
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
			if (result.id === selected) { const state = this.models.get(select.closest('[data-ai-route]')); if (state) { state.job?.abort(); state.attempted = false; } }
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
			if (form.isConnected && !form.dataset.id) { form.reset(); this.providerControls(form); form.closest('details').open = false; }
		} else if (form.matches('[data-ai-endpoints-form]')) {
			this.updateConfig(root, await this.request('/settings', 'PATCH', { scope, revision: this.configValue(root).revision, private_endpoints: data.get('private_endpoints') }));
		} else {
			const routes = {};
			for (const workflow of ['authoring', 'search']) if (data.get(workflow + '_connection')) routes[workflow] = { connection: data.get(workflow + '_connection'), model: data.get(workflow + '_model'), protocol: data.get(workflow + '_protocol') };
			const result = await this.request('/settings', 'PATCH', { scope, enabled: data.has('enabled'), routes, revision: this.configValue(root).revision, ...(this.admin ? { daily_limit: Number(data.get('daily_limit')) } : {}) });
			this.updateConfig(root, result);
		}
		this.notify('AI settings saved');
	}
	async click(event) {
		const launch = event.target.closest('[data-ai-launch]'); if (launch && (!this.localEnabled() || !this.status?.enabled)) { event.preventDefault(); return; }
		const button = event.target.closest('button'); if (!button) return;
		if (button.matches('[data-ai-config-tab]')) { this.selectTab(this.config(button), button.dataset.aiConfigTab); return; }
		if (button.matches('[data-ai-refresh-scope]')) return this.busy(button, async () => { if (!await this.confirm('Refresh saved AI settings? Unsaved changes in this section will be discarded.', 'Refresh')) return; const root = this.config(button); const result = await this.request(this.admin ? '/settings' : '/settings?scope=' + root.dataset.aiConfiguration); const node = this.fragment(result.html); const tab = root.dataset.aiTab; this.destroyConfig(root); root.replaceWith(node); this.selectTab(node, tab); this.routeControls(node); this.acceptStatus(result.status); this.update(); });
		if (button.matches('[data-ai-manage]')) { event.preventDefault(); await this.manage(); return; }
		if (button.matches('[data-ai-edit-connection]')) { button.closest('[data-ai-connection]').querySelector('form').hidden = false; return; }
		if (button.matches('[data-ai-cancel-connection]')) { const form = button.closest('form'); form.reset(); this.providerControls(form); if (form.dataset.id) form.hidden = true; else form.closest('details').open = false; return; }
		if (button.matches('[data-ai-delete-connection]')) {
			return this.busy(button, async () => { if (!await this.confirm('Remove this AI provider?')) return; this.cancel(); const root = this.config(button); this.updateConfig(root, await this.request('/connections/' + encodeURIComponent(button.dataset.aiDeleteConnection), 'DELETE', { scope: root.dataset.aiConfiguration, revision: this.configValue(root).revision })); });
		}
		if (button.matches('[data-ai-models]')) return this.loadModels(button.closest('[data-ai-route]'));
		if (button.matches('[data-ai-verify]')) {
			return this.busy(button, async () => {
				const root = this.config(button); const row = button.closest('[data-ai-route]'); const workflow = button.dataset.aiVerify; const form = root.querySelector('[data-ai-routes-form]'); const connection = form.elements[workflow + '_connection'].value; const model = form.elements[workflow + '_model'].value; const protocol = form.elements[workflow + '_protocol'].value; const identity = this.identity();
				await this.request('/verify', 'POST', { scope: root.dataset.aiConfiguration, connection, model, protocol });
				if (row.isConnected && identity === this.identity() && form.elements[workflow + '_connection'].value === connection && form.elements[workflow + '_model'].value === model && form.elements[workflow + '_protocol'].value === protocol) row.querySelector('[data-ai-model-status]').textContent = 'Selected model verified.';
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
					await binding.apply(proposal); binding.proposal = null; root.querySelector('[data-ai-proposal]').hidden = true; root.querySelector('[data-ai-author-status]').textContent = 'Draft applied. Review it, then Save.';
					if (root.classList.contains('ai-author-compact')) root.hidden = true;
					return;
				}
				binding.job?.abort(); await this.ready('authoring'); const entry = await binding.read(); if (!this.localEnabled() || !this.status.enabled) return; const snapshot = JSON.stringify(entry); const job = new AbortController(); binding.job = job; this.jobs.add(job); binding.snapshot = snapshot;
				try {
					const result = await this.request('/author', 'POST', { request_id: crypto.randomUUID(), action: root.querySelector('[data-ai-action]')?.value || 'generate', prompt: root.querySelector('[data-ai-prompt]').value, entry: entry.entry || entry, library: entry.library }, job.signal);
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
