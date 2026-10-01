export class Statistics {
	constructor(client) {
		this.client = client; this.version = 0; this.sorts = {}; this.dirty = false;
		this.modal = document.querySelector('#statistics-modal');
		if (!this.modal) return;
		this.filters = document.querySelector('#statistics-filters'); this.preferences = document.querySelector('#statistics-preferences');
		this.trend = this.modal.querySelector('#statistics-trend'); this.trendObserver = new ResizeObserver(() => { if (this.report) this.chart(); }); this.trendObserver.observe(this.trend);
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
		document.querySelector('#statistics-estimate').textContent = `Estimated savings · ${report.settings.wpm} WPM · ${money.format(report.settings.hourly_rate)}/hour · ${report.options.timezone}`;
		document.querySelector('#statistics-empty').hidden = report.totals.uses > 0;
		for (const kind of ['days', 'snippets', 'libraries', 'members']) { this.modal.querySelector(`[data-statistics-section="${kind}"]`).hidden = kind === 'members' && report.scope !== 'team'; this.rows(kind); }
		this.chart();
	}
	rows(kind) {
		const parent = this.modal.querySelector(`[data-statistics-rows="${kind}"]`); const rows = [...this.report[kind]]; const sort = this.sorts[kind];
		if (sort) rows.sort((a, b) => sort.direction * (typeof a[sort.key] === 'number' ? a[sort.key] - b[sort.key] : String(a[sort.key]).localeCompare(String(b[sort.key]))));
		const ids = new Set(rows.map(row => row.id)); for (const node of [...parent.children]) if (!ids.has(node.dataset.statisticsId)) node.remove();
		for (const [index, row] of rows.entries()) { const html = this.report.rows[kind].find(item => item.id === row.id).html; let node = [...parent.children].find(item => item.dataset.statisticsId === row.id); if (!node || node.statisticsHTML !== html) { const replacement = this.client.fragment(html); replacement.statisticsHTML = html; if (node) node.replaceWith(replacement); node = replacement; } if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); }
		const max = Math.max(1, ...rows.map(row => row.uses)); for (const bar of parent.querySelectorAll('[data-statistics-uses]')) bar.style.width = (Number(bar.dataset.statisticsUses) / max * 100) + '%';
	}
	chart() {
		const section = this.modal.querySelector('#statistics-trend-section'); const days = this.report.days; section.hidden = days.length === 0;
		const line = this.trend.querySelector('.statistics-trend-line'); const area = this.trend.querySelector('.statistics-trend-area'); const point = this.trend.querySelector('.statistics-trend-point');
		point.setAttribute('visibility', 'hidden');
		if (!days.length) { line.setAttribute('d', ''); area.setAttribute('d', ''); return; }
		const width = this.trend.clientWidth; const height = this.trend.clientHeight; if (width < 100 || height < 100) return;
		const start = Date.parse((this.report.options.range === 'all' ? days[0].id : this.report.options.start) + 'T00:00:00Z') / 86400000; const end = Date.parse(this.report.options.end + 'T00:00:00Z') / 86400000; const span = end - start;
		const values = new Map(days.map(row => [Date.parse(row.id + 'T00:00:00Z') / 86400000, row.uses])); const positions = new Set([start, end]);
		for (const day of values.keys()) { positions.add(day); if (day > start) positions.add(day - 1); if (day < end) positions.add(day + 1); }
		const dates = [...positions].sort((a, b) => a - b); const max = Math.max(1, ...values.values()); const step = Math.max(1, 10 ** Math.floor(Math.log10(max / 3))); const tick = Math.ceil(max / 3 / step) * step;
		const left = Math.max(48, (tick * 3).toLocaleString().length * 8 + 12); const right = width - 16; const top = 28; const bottom = height - 32; const x = day => span ? left + (right - left) * (day - start) / span : (left + right) / 2; const y = uses => bottom - (bottom - top) * uses / (tick * 3);
		this.trend.setAttribute('viewBox', `0 0 ${width} ${height}`);
		for (const [index, grid] of [...this.trend.querySelectorAll('[data-statistics-grid]')].entries()) { const position = top + (bottom - top) * index / 3; grid.setAttribute('x1', left); grid.setAttribute('x2', right); grid.setAttribute('y1', position); grid.setAttribute('y2', position); const label = this.trend.querySelector(`[data-statistics-y="${index}"]`); label.setAttribute('x', left - 8); label.setAttribute('y', position + 4); label.textContent = (tick * (3 - index)).toLocaleString(); }
		const path = 'M' + dates.map(day => `${x(day).toFixed(2)} ${y(values.get(day) || 0).toFixed(2)}`).join(' L');
		line.setAttribute('d', span ? path : ''); area.setAttribute('d', span ? `${path} L ${right} ${bottom} L ${left} ${bottom} Z` : '');
		if (!span) { point.setAttribute('cx', x(start)); point.setAttribute('cy', y(values.get(start) || 0)); point.setAttribute('visibility', 'visible'); }
		const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); const period = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); const ticks = Math.min(width < 420 ? 3 : 4, span + 1);
		for (const [index, label] of [...this.trend.querySelectorAll('[data-statistics-x]')].entries()) { label.style.display = index < ticks ? '' : 'none'; if (index >= ticks) continue; const day = Math.round(start + span * index / Math.max(1, ticks - 1)); label.setAttribute('x', x(day)); label.setAttribute('y', height - 6); label.setAttribute('text-anchor', ticks === 1 ? 'middle' : index === 0 ? 'start' : index === ticks - 1 ? 'end' : 'middle'); label.textContent = format.format(new Date(day * 86400000)); }
		this.modal.querySelector('#statistics-trend-period').textContent = span ? `${period.format(new Date(start * 86400000))} – ${period.format(new Date(end * 86400000))}` : period.format(new Date(start * 86400000));
		this.trend.querySelector('#statistics-trend-description').textContent = `${this.report.totals.uses.toLocaleString()} uses from ${new Date(start * 86400000).toISOString().slice(0, 10)} to ${this.report.options.end}, in ${this.report.options.timezone}. Days without activity count as zero; exact daily counts appear in the table below.`;
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
