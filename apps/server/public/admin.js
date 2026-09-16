export class AdminUI {
	static versions = new Map();
	static deleted = new Set();
	static polling = false;
	static selectPanel(tab, updateHash = true) {
		const group = tab.closest('[data-admin-panels]');
		for (const item of group.querySelectorAll('[data-admin-panel]')) { const selected = item === tab; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1; }
		for (const panel of group.querySelectorAll('[data-admin-panel-content]')) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
		if (updateHash) history.replaceState(null, '', '#' + group.dataset.adminPanels + '-' + tab.dataset.adminPanel);
	}
	static restorePanel() {
		for (const group of document.querySelectorAll('[data-admin-panels]')) {
			const tabs = [...group.querySelectorAll('[data-admin-panel]')];
			const tab = tabs.find(item => location.hash === '#' + group.dataset.adminPanels + '-' + item.dataset.adminPanel) || tabs[0];
			if (tab) AdminUI.selectPanel(tab, false);
		}
	}
	static panelKeys(event) {
		const tab = event.target.closest('[data-admin-panel]');
		if (!tab || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[data-admin-panel]')];
		const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
		AdminUI.selectPanel(tabs[index]); tabs[index].focus();
	}
	static templateSaved(form, template, reset = false) {
		for (const key of ['subject', 'text']) { form.elements[key].defaultValue = template[key]; if (reset) form.elements[key].value = template[key]; }
		if (reset) form.querySelector('[data-template-preview-output]').textContent = '';
	}
	static async request(path, method = 'GET', body) {
		const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Request failed'); }
		return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.text();
	}
	static async busy(control, action) {
		if (control?.disabled) return;
		if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
		try { return await action(); } catch (error) { await Swal.fire({ icon: 'error', title: 'Request failed', text: error.message }); }
		finally { if (control) { control.disabled = false; control.removeAttribute('aria-busy'); } }
	}
	static toast(title) { return Swal.fire({ toast: true, position: 'top-end', icon: 'success', title, timer: 2500, showConfirmButton: false }); }
	static replace(id, html, container) {
		const old = document.getElementById(id);
		const range = document.createRange(); range.selectNodeContents(container || old.parentNode);
		const fragment = range.createContextualFragment(html);
		if (old) old.replaceWith(fragment); else container.prepend(fragment);
	}
	static matches(account) {
		const query = new URLSearchParams(location.search);
		const q = (query.get('q') || '').toLowerCase();
		return (!query.get('status') || account.status === query.get('status')) && (!query.get('plan') || account.plan === query.get('plan')) && (!q || account.name.toLowerCase().includes(q) || account.id === q || account.owner?.email?.toLowerCase().includes(q));
	}
	static update(result) {
		for (const related of result.related || []) if (document.getElementById('account-' + related.id)) AdminUI.update(related);
		const id = result.deleted || result.id;
		if (result.deleted) { const old = document.getElementById('account-' + id); if (old) { old.remove(); const total = document.getElementById('account-total'); if (total) total.textContent = Math.max(0, Number(total.textContent) - 1); } AdminUI.deleted.add(id); }
		else {
			if (AdminUI.deleted.has(id)) return;
			const old = document.getElementById('account-' + id);
			const previous = Math.max(AdminUI.versions.get(id) ?? -1, Number(old?.dataset.revision ?? -1));
			if (result.revision < previous) return;
			AdminUI.versions.set(id, result.revision);
			const container = document.getElementById('admin-accounts');
			if (container && AdminUI.matches(result.account)) AdminUI.replace('account-' + id, result.html, container);
			else if (old) { old.remove(); const total = document.getElementById('account-total'); if (total) total.textContent = Math.max(0, Number(total.textContent) - 1); }
		}
		const empty = document.getElementById('account-empty'); if (empty) empty.hidden = !!document.querySelector('#admin-accounts tr');
	}
	static async poll() {
		if (AdminUI.polling) return;
		AdminUI.polling = true;
		try { for (const row of document.querySelectorAll('[data-account-id][data-status="deleting"]')) AdminUI.update(await AdminUI.request('/admin/api/accounts/' + row.dataset.accountId + '/deletion')); }
		catch { /* A transient polling error must not replace the current UI. */ }
		finally { AdminUI.polling = false; }
	}
	static modal() { return bootstrap.Modal.getOrCreateInstance(document.getElementById('admin-modal')); }
	static async submit(event) {
		const form = event.target;
		if (!form.matches('[data-admin-login], [data-admin-account], [data-admin-template], [data-admin-settings]')) return;
		event.preventDefault();
		const body = Object.fromEntries(new FormData(form));
		await AdminUI.busy(event.submitter, async () => {
			if (form.hasAttribute('data-admin-login')) { const result = await AdminUI.request('/admin/login', 'POST', body); location.assign(result.redirect); return; }
			if (form.hasAttribute('data-admin-account')) {
				const id = form.dataset.adminAccount;
				if (id) { body.revision = Number(body.revision); body.is_active = body.is_active === 'true'; body.override = { plan: body.override_plan || null, limits: Object.fromEntries(['people', 'snippets', 'libraries', 'machines'].map(key => [key, body['limit_' + key] === '' ? null : Number(body['limit_' + key])])) }; }
				const result = await AdminUI.request('/admin/api/accounts' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body);
				AdminUI.update(result); AdminUI.modal().hide();
				if (!id && AdminUI.matches(result.account)) { const total = document.getElementById('account-total'); if (total) total.textContent = Number(total.textContent) + 1; }
				if (result.warnings?.length) await Swal.fire({ icon: 'warning', title: 'Account created', text: result.warnings.join(' ') }); else AdminUI.toast('Account saved');
			} else if (form.hasAttribute('data-admin-template')) {
				const result = await AdminUI.request('/admin/api/email-templates/' + form.dataset.adminTemplate, 'PUT', body);
				AdminUI.templateSaved(form, result.template || body);
				if (form.closest('#admin-modal')) AdminUI.modal().hide();
				AdminUI.toast('Template saved');
			} else {
				const section = form.dataset.adminSettings;
				if (section === 'managani') { body.enabled = body.enabled === 'true'; body.clear_site_secret = body.clear_site_secret === 'on'; }
				else body.origins = body.origins.split(/\s+/).filter(Boolean);
				const result = await AdminUI.request('/admin/api/settings/' + section, 'PUT', body);
				if (section === 'managani') { form.elements.site_secret.value = ''; form.elements.clear_site_secret.checked = false; document.getElementById('secret-status').textContent = result.settings.site_secret_configured ? 'Secret configured' : 'No secret configured'; }
				AdminUI.toast('Settings saved');
			}
		});
	}
	static async click(event) {
		const button = event.target.closest('button'); if (!button) return;
		if (button.dataset.adminPanel) AdminUI.selectPanel(button);
		else if (button.dataset.adminForm) await AdminUI.busy(button, async () => { document.getElementById('admin-modal-body').innerHTML = await AdminUI.request(button.dataset.adminForm); document.getElementById('admin-modal-title').textContent = button.dataset.adminForm.includes('email-templates') ? 'Email template' : button.dataset.adminForm.includes('/new/') ? 'Create account' : 'Account details'; AdminUI.modal().show(); });
		else if (button.hasAttribute('data-admin-logout')) await AdminUI.busy(button, async () => { const result = await AdminUI.request('/admin/logout', 'POST', {}); location.assign(result.redirect); });
		else if (button.dataset.adminDelete) await AdminUI.busy(button, async () => {
			const id = button.dataset.adminDelete; const { account } = await AdminUI.request('/admin/api/accounts/' + id);
			const confirmation = await Swal.fire({ title: 'Permanently purge account?', text: `${account.name}: ${account.usage.users} users, ${account.usage.snippets} active snippets, ${account.usage.trash_snippets} trashed snippets, ${account.usage.libraries} active libraries. Subscriptions, domain (${account.domain.hostname || 'none'}), files, credentials, and orphan users will be removed. Type account ID: ${id}`, input: 'text', inputLabel: 'Account ID', showCancelButton: true, confirmButtonText: 'Purge account', reverseButtons: true, inputValidator: value => value === id ? undefined : 'Enter the exact account ID' });
			if (confirmation.isConfirmed) { AdminUI.update(await AdminUI.request('/admin/api/accounts/' + id, 'DELETE', { confirmation: confirmation.value })); AdminUI.toast('Purge queued'); }
		});
		else if (button.dataset.adminRetry) await AdminUI.busy(button, async () => { AdminUI.update(await AdminUI.request('/admin/api/accounts/' + button.dataset.adminRetry + '/deletion/retry', 'POST', {})); AdminUI.toast('Purge retry queued'); });
		else if (button.dataset.templateReset) await AdminUI.busy(button, async () => { const choice = await Swal.fire({ title: 'Restore default template?', icon: 'question', showCancelButton: true, reverseButtons: true }); if (choice.isConfirmed) { const result = await AdminUI.request('/admin/api/email-templates/' + button.dataset.templateReset + '/reset', 'POST', {}); AdminUI.templateSaved(button.form, result.template, true); AdminUI.toast('Template reset'); } });
		else if (button.dataset.templatePreview) await AdminUI.busy(button, async () => { const result = await AdminUI.request('/admin/api/email-templates/' + button.dataset.templatePreview + '/preview', 'POST', Object.fromEntries(new FormData(button.form))); button.form.querySelector('[data-template-preview-output]').textContent = result.subject + '\n\n' + result.text; });
		else if (button.dataset.templateTest) await AdminUI.busy(button, async () => { await AdminUI.request('/admin/api/email-templates/' + button.dataset.templateTest + '/test', 'POST', { email: button.form.elements.test_email.value }); AdminUI.toast('Test email sent'); });
	}
	static start() { document.addEventListener('submit', AdminUI.submit); document.addEventListener('click', AdminUI.click); document.addEventListener('keydown', AdminUI.panelKeys); window.addEventListener('hashchange', AdminUI.restorePanel); AdminUI.restorePanel(); if (document.getElementById('admin-accounts')) setInterval(AdminUI.poll, 3000); }
}
AdminUI.start();
