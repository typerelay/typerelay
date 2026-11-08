export class EmailConfirmation {
	constructor(app) {
		this.app = app;
		const refresh = () => this.refresh().catch(() => {});
		window.addEventListener('focus', refresh);
		document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
		document.querySelector('#email-confirmation-resend')?.addEventListener('click', event => this.resend(event.currentTarget));
	}
	async refresh() {
		if (!document.querySelector('#email-confirmation-banner')) return;
		const status = await this.app.request('email-confirmation');
		if (status.confirmed) document.querySelector('#email-confirmation-banner')?.remove();
	}
	async resend(button) {
		button.disabled = true;
		try { this.app.toast((await this.app.request('email-confirmation', 'POST', {})).message); } catch (error) { this.app.toast(error.message, 'error'); } finally { button.disabled = false; }
	}
}
