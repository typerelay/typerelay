export class TrialCountdown {
	constructor(app) { this.app = app; this.timer = null; }
	static text(startedAt, now, trialDays) {
		const startDay = Date.UTC(startedAt.getFullYear(), startedAt.getMonth(), startedAt.getDate());
		const currentDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
		const elapsed = Math.max(0, Math.floor((currentDay - startDay) / 86400000));
		const days = Math.max(0, trialDays - elapsed);
		return days === 0 ? 'Trial ends today' : `Trial ends in ${days} day${days === 1 ? '' : 's'}`;
	}
	refresh(now = new Date()) {
		clearTimeout(this.timer);
		this.timer = null;
		const button = document.querySelector('[data-trial-countdown]');
		if (!button) return;
		const startedAt = new Date(button.dataset.trialStartedAt);
		const endsAt = new Date(button.dataset.trialEndsAt);
		const trialDays = Number(button.dataset.trialDays);
		if (![startedAt.getTime(), endsAt.getTime(), trialDays].every(Number.isFinite)) return;
		if (now >= endsAt) { void this.app.refreshBilling().catch(error => this.app.toast(error.message, 'error')); return; }
		button.textContent = TrialCountdown.text(startedAt, now, trialDays);
		const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
		const delay = Math.min(midnight - now, endsAt - now);
		this.timer = setTimeout(() => this.refresh(), Math.max(1, delay + 100));
	}
	stop() { clearTimeout(this.timer); this.timer = null; }
}
