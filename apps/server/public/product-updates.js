// Mailtwine's product-update flow using TypeRelay's request/fragment helpers.
export class ProductNews {
	constructor(app) {
		this.app = app;
		this.root = document.querySelector('#product-updates-modal-root');
		if (!this.root) return;
		this.view = document.querySelector('#news-view');
		this.version = 0; this.navigation = 0; this.active = location.pathname === '/news';
		this.workspaceUrl = '/?account=' + encodeURIComponent(app.account);
		this.newsUrl = '/news?account=' + encodeURIComponent(app.account);
		document.addEventListener('click', event => {
			const link = event.target.closest('[data-product-updates-nav], .brand-link');
			if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (link.matches('.brand-link') && !this.active)) return;
			event.preventDefault();
			void this.navigate(link.hasAttribute('data-product-updates-nav'), true, link).catch(error => this.app.toast(error.message, 'error'));
		});
		window.addEventListener('popstate', () => { void this.navigate(location.pathname === '/news', false).catch(error => this.app.toast(error.message, 'error')); });
		document.addEventListener('hidden.bs.modal', () => this.showQueued());
		document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.lastCheck = 0; void this.check(); this.showQueued(); } });
		if (this.active) { this.setActive(true); void this.mountArchive().catch(error => this.app.toast(error.message, 'error')); }
		void this.check();
	}
	badge(count) {
		const badge = document.querySelector('#product-updates-badge');
		const value = Math.max(Number(count) || 0, 0);
		this.archiveStale = value > 0;
		badge.textContent = value > 99 ? '99+' : String(value);
		badge.classList.toggle('d-none', value === 0);
		badge.setAttribute('aria-label', `${value} new product updates`);
	}
	busy(button, value) {
		if (!button) return;
		button.disabled = value;
		button.setAttribute('aria-busy', String(value));
		button.querySelector('[data-product-updates-spinner]')?.classList.toggle('d-none', !value);
	}
	async seen(id) {
		if (!id) return;
		const version = ++this.version;
		this.marking = (this.marking || 0) + 1;
		try {
			const result = await this.app.request('/ajax/product-updates/seen', 'POST', { update_id: id });
			if (version === this.version) this.badge(result.new_count);
			return result;
		} finally { this.marking--; if (version === this.version) this.version++; }
	}
	async check() {
		clearTimeout(this.timer);
		if (document.hidden || this.checking || this.marking || Date.now() - (this.lastCheck || 0) < 60000) { this.schedule(); return; }
		this.checking = true; this.lastCheck = Date.now();
		const version = this.version;
		try {
			const status = await this.app.request('/ajax/product-updates/status');
			if (version !== this.version) return;
			this.badge(status.new_count);
			if (status.has_modal && !this.active && !this.root.firstElementChild) {
				const html = await this.app.request('/ajax/product-updates/modal', 'GET', undefined, true);
				if (!html || version !== this.version || this.active) return;
				const modal = this.app.fragment(html);
				this.root.replaceChildren(modal);
				modal.querySelectorAll('[data-product-updates-dismiss], [data-product-updates-read-more]').forEach(button => button.addEventListener('click', () => { void this.dismiss(button, button.hasAttribute('data-product-updates-read-more')); }));
				modal.addEventListener('hidden.bs.modal', () => { bootstrap.Modal.getInstance(modal)?.dispose(); modal.remove(); }, { once: true });
				this.queued = true;
				this.showQueued();
			}
		} catch (error) { console.error('Product update check failed:', error.message); }
		finally { this.checking = false; this.schedule(); }
	}
	schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.check(); }, 45 * 60 * 1000); }
	showQueued() {
		if (!this.queued || this.active || document.hidden || document.querySelector('.modal.show, .modal-backdrop')) return;
		const modal = this.root.firstElementChild;
		if (!modal) return;
		this.queued = false;
		bootstrap.Modal.getOrCreateInstance(modal, { backdrop: 'static', keyboard: false }).show();
	}
	async dismiss(button, openLink) {
		if (this.dismissing) return;
		const modal = this.root.firstElementChild;
		if (!modal) return;
		this.dismissing = true;
		this.busy(button, true);
		modal.querySelectorAll('button').forEach(action => { action.disabled = true; });
		const popup = openLink ? window.open('about:blank', '_blank') : null;
		if (popup) popup.opener = null;
		try {
			await this.seen(modal.dataset.throughUpdateId);
			bootstrap.Modal.getOrCreateInstance(modal).hide();
			if (popup) popup.location.href = modal.dataset.readMoreLink;
		} catch (error) { popup?.close(); await this.app.toast(error.message, 'error'); }
		finally { this.dismissing = false; this.busy(button, false); modal.querySelectorAll('button').forEach(action => { action.disabled = false; }); }
	}
	setActive(active) {
		this.active = active;
		document.querySelector('#workspace-content').hidden = active;
		document.querySelector('#conflicts').hidden = active;
		this.view.hidden = !active;
		document.querySelector('[data-product-updates-nav]').classList.toggle('active', active);
		document.title = active ? "What's new · TypeRelay" : 'TypeRelay';
	}
	async navigate(active, push, button) {
		const navigation = ++this.navigation;
		this.busy(button, true);
		try {
			if (active && (!this.view.firstElementChild || this.archiveStale)) {
				const html = await this.app.request('/ajax/section/news', 'GET', undefined, true);
				if (navigation !== this.navigation) return;
				this.view.replaceChildren(this.app.fragment(html));
				this.archiveStale = false; this.newsScroll = { x: 0, y: 0 };
			}
			if (navigation !== this.navigation) return;
			if (active !== this.active) {
				if (active) { this.workspaceScroll = { x: window.scrollX, y: window.scrollY }; this.workspaceFocus = document.activeElement; }
				else this.newsScroll = { x: window.scrollX, y: window.scrollY };
			}
			this.setActive(active);
			const url = active ? this.newsUrl : this.workspaceUrl;
			if (push && location.pathname !== new URL(url, location.href).pathname) history.pushState({}, '', url);
			const scroll = (active ? this.newsScroll : this.workspaceScroll) || { x: 0, y: 0 };
			window.scrollTo(scroll.x, scroll.y);
			if (!active) this.workspaceFocus?.focus({ preventScroll: true });
			else await this.mountArchive();
		} finally { this.busy(button, false); }
	}
	async mountArchive() {
		const root = this.view.firstElementChild;
		if (!root) return;
		if (!root.dataset.mounted) {
			root.dataset.mounted = 'true';
			root.querySelector('[data-product-updates-load-more]').addEventListener('click', event => { void this.more(root, event.currentTarget); });
		}
		await this.seen(root.dataset.latestUpdateId);
		this.queued = false;
		const modal = this.root.firstElementChild;
		if (modal?.classList.contains('show')) bootstrap.Modal.getOrCreateInstance(modal).hide();
		else modal?.remove();
	}
	async more(root, button) {
		const cursor = root.dataset.nextCursor;
		if (!cursor || button.disabled) return;
		this.busy(button, true);
		try {
			const fragment = this.app.fragment(await this.app.request('/ajax/product-updates/items?cursor=' + encodeURIComponent(cursor), 'GET', undefined, true));
			const list = root.querySelector('#product-updates-list');
			if (!fragment?.hasAttribute('data-product-update-items-fragment')) throw new Error('Invalid product update response');
			const ids = new Set([...list.querySelectorAll('[data-product-update-id]')].map(node => node.dataset.productUpdateId));
			for (const item of [...fragment.children]) { if (!ids.has(item.dataset.productUpdateId)) { list.append(item); ids.add(item.dataset.productUpdateId); } }
			root.dataset.nextCursor = fragment.dataset.nextCursor || '';
			button.classList.toggle('d-none', !root.dataset.nextCursor);
		} catch (error) { await this.app.toast(error.message, 'error'); }
		finally { this.busy(button, false); }
	}
}
