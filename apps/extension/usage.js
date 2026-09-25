export class Usage {
	constructor(request, origin) { this.request = request; this.origin = origin; this.flushing = null; }
	async record(event) {
		const { statisticsIdentity } = await chrome.storage.local.get('statisticsIdentity');
		if (!event?.identity || JSON.stringify(event.identity) !== JSON.stringify(statisticsIdentity) || !event.library) return {};
		await chrome.storage.local.set({ ['usage-' + event.event_id]: event });
		void this.flush().catch(() => undefined);
		return {};
	}
	async flush() {
		if (this.flushing) return this.flushing;
		this.flushing = this.upload().finally(() => { this.flushing = null; });
		return this.flushing;
	}
	async upload() {
		const state = await chrome.storage.local.get(null); const identity = state.statisticsIdentity;
		if (!identity || identity.server !== this.origin()) return;
		const rows = Object.entries(state).filter(([key, event]) => key.startsWith('usage-') && JSON.stringify(event.identity) === JSON.stringify(identity));
		for (let offset = 0; offset < rows.length; offset += 100) {
			const { statisticsIdentity } = await chrome.storage.local.get('statisticsIdentity');
			if (JSON.stringify(identity) !== JSON.stringify(statisticsIdentity) || identity.server !== this.origin()) return;
			const response = await this.request({ path: '/api/v2/statistics/events', options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity, events: rows.slice(offset, offset + 100).map(([, event]) => { const { identity, ...value } = event; return value; }) }) } });
			const result = await response.json();
			await chrome.storage.local.remove([...result.accepted, ...result.discarded].map(id => 'usage-' + id));
		}
	}
}
