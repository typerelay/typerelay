export class Statistics {
	constructor(client) {
		this.client = client; this.version = 0; this.sorts = {}; this.dirty = false;
		this.modal = document.querySelector('#statistics-modal');
		if (!this.modal) return;
		this.filters = document.querySelector('#statistics-filters'); this.preferences = document.querySelector('#statistics-preferences');
		this.modal.addEventListener('show.bs.modal', () => { void this.load().catch(error => client.toast(error.message, 'error')); this.timer = setInterval(() => void this.load().catch(() => undefined), 30000); });
		this.modal.addEventListener('hidden.bs.modal', () => { ++this.version; clearInterval(this.timer); });
		this.filters.addEventListener('change', event => { document.querySelectorAll('[data-statistics-custom]').forEach(node => { node.hidden = this.filters.elements.range.value !== 'custom'; }); if (event.target.name === 'scope') { this.dirty = false; void this.submit(this.filters, event.target); } });
		this.preferences.addEventListener('input', () => { this.dirty = true; });
		for (const form of [this.filters, this.preferences]) form.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void this.submit(form, event.submitter); });
		document.querySelector('#statistics-export').addEventListener('click', () => void this.export());
		this.modal.addEventListener('click', event => { const button = event.target.closest('[data-statistics-sort]'); if (!button || !this.report) return; const kind = button.dataset.statisticsKind; const key = button.dataset.statisticsSort; this.sorts[kind] = { key, direction: this.sorts[kind]?.key === key ? -this.sorts[kind].direction : 1 }; this.rows(kind); });
		window.addEventListener('online', () => void this.flush()); void this.flush();
		if (location.hash === '#statistics') queueMicrotask(() => bootstrap.Modal.getOrCreateInstance(this.modal).show());
	}
	query() { const query = new URLSearchParams(new FormData(this.filters)); query.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone); return query; }
	async submit(form, button) {
		if (button) button.disabled = true;
		try {
			if (form === this.preferences) { if (this.report?.scope !== this.filters.elements.scope.value) throw new Error('Refresh this report before saving its settings'); await this.client.request('statistics/preferences', 'PATCH', { ...Object.fromEntries(new FormData(form)), scope: this.filters.elements.scope.value }); this.dirty = false; }
			await this.load();
		} catch (error) { this.client.toast(error.message, 'error'); } finally { if (button) button.disabled = false; }
	}
	async load() {
		const version = ++this.version; const query = this.query().toString(); const report = await this.client.request('statistics?' + query);
		if (version !== this.version || query !== this.query().toString()) return;
		this.report = report;
		const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: report.settings.currency });
		for (const node of this.modal.querySelectorAll('[data-statistics-total]')) { const key = node.dataset.statisticsTotal; node.textContent = key === 'money' ? money.format(report.totals[key]) : report.totals[key].toLocaleString(undefined, { maximumFractionDigits: 1 }); }
		if (!this.dirty) for (const key of ['wpm', 'hourly_rate', 'currency']) this.preferences.elements[key].value = report.settings[key];
		document.querySelector('#statistics-estimate').textContent = `Estimated savings at ${report.settings.wpm} WPM and ${money.format(report.settings.hourly_rate)}/hour. Dates use ${report.options.timezone}.`;
		document.querySelector('#statistics-empty').hidden = report.totals.uses > 0;
		for (const kind of ['days', 'snippets', 'libraries', 'members']) { this.modal.querySelector(`[data-statistics-section="${kind}"]`).hidden = kind === 'members' && report.scope !== 'team'; this.rows(kind); }
	}
	rows(kind) {
		const parent = this.modal.querySelector(`[data-statistics-rows="${kind}"]`); const rows = [...this.report[kind]]; const sort = this.sorts[kind];
		if (sort) rows.sort((a, b) => sort.direction * (typeof a[sort.key] === 'number' ? a[sort.key] - b[sort.key] : String(a[sort.key]).localeCompare(String(b[sort.key]))));
		const ids = new Set(rows.map(row => row.id)); for (const node of [...parent.children]) if (!ids.has(node.dataset.statisticsId)) node.remove();
		for (const [index, row] of rows.entries()) { const html = this.report.rows[kind].find(item => item.id === row.id).html; let node = [...parent.children].find(item => item.dataset.statisticsId === row.id); if (!node || node.statisticsHTML !== html) { const replacement = this.client.fragment(html); replacement.statisticsHTML = html; if (node) node.replaceWith(replacement); node = replacement; } if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); }
		if (kind === 'days') { const max = Math.max(1, ...rows.map(row => row.uses)); for (const meter of parent.querySelectorAll('meter')) meter.max = max; }
	}
	async export() {
		const button = document.querySelector('#statistics-export'); button.disabled = true;
		try { const response = await fetch('/api/v2/statistics/export?' + this.query(), { headers: { 'X-Account-Id': this.client.account } }); if (!response.ok) throw new Error((await response.json()).error || 'Export failed'); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'typerelay-statistics.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { this.client.toast(error.message, 'error'); } finally { button.disabled = false; }
	}
	record(library, entry, text, characters = [...text].length) {
		try { const event_id = crypto.randomUUID(); const event = { event_id, library: library._id, snippet: entry.id, action: 'copy', client: 'web', occurred_at: new Date().toISOString(), characters, shared: library.shared === true }; localStorage.setItem(this.queuePrefix() + event_id, JSON.stringify(event)); void this.flush(); } catch (error) { console.error('TypeRelay usage could not be queued:', error.message); }
	}
	queuePrefix() { return `typerelay-usage:${document.querySelector('#workspace').dataset.user}:${this.client.account}:`; }
	async flush() {
		if (this.flushing) return; this.flushing = true;
		try { const prefix = this.queuePrefix(); const keys = Object.keys(localStorage).filter(key => key.startsWith(prefix)); for (let offset = 0; offset < keys.length; offset += 100) { const events = keys.slice(offset, offset + 100).map(key => JSON.parse(localStorage.getItem(key))).filter(Boolean); const result = await this.client.request('statistics/events', 'POST', { events }); for (const id of [...result.accepted, ...result.discarded]) localStorage.removeItem(prefix + id); } if (keys.length && this.modal?.classList.contains('show')) await this.load(); } catch { /* Durable events retry on the next copy, reconnect, or page visit. */ } finally { this.flushing = false; }
	}
}
