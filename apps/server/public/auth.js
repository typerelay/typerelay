// Streamient-style password, magic-link, passkey and authenticator flows.
import { client } from './app.js';

class AccountUI {
	totpAction = 'confirm';
	ssoVersion = 0;
	ssoRevision = -1;
	constructor() {
		document.addEventListener('submit', event => this.submit(event));
		document.addEventListener('click', event => this.click(event).catch(error => client.toast(error.message, 'error')));
		document.addEventListener('sso-settings-open', () => this.sso().catch(error => client.toast(error.message, 'error')));
		document.querySelector('#settings')?.addEventListener('show.bs.modal', () => this.security().catch(error => client.toast(error.message, 'error')));
		document.querySelector('#settings')?.addEventListener('hidden.bs.modal', () => {
			document.querySelector('#sso-recovery-secret')?.remove();
			const password = document.querySelector('#new-password');
			if (password) password.value = '';
			document.querySelector('#password-result')?.classList.add('d-none');
		});
		if (location.hash === '#settings-sso' && document.querySelector('#sso-settings-container')) this.sso().catch(error => client.toast(error.message, 'error'));
	}
	async sso(method = 'GET', body, suffix = '') {
		const version = ++this.ssoVersion;
		const result = await client.request('sso' + suffix, method, body);
		if (version !== this.ssoVersion || result.revision < this.ssoRevision) return;
		this.ssoRevision = result.revision;
		const panel = document.querySelector('#settings .modal-body');
		const scroll = panel?.scrollTop;
		client.update('#sso-configuration', '#sso-settings-container', result.html);
		if (panel) panel.scrollTop = scroll;
		if (result.secret_html) client.update('#sso-recovery-secret', '#sso-secret-container', result.secret_html);
	}
	async finish(result) {
		if (result.csrf) document.querySelector('meta[name=csrf-token]').content = result.csrf;
		if (result.redirect) location.assign(result.redirect);
		else if (result.message) client.toast(result.message);
	}
	async submit(event) {
		const form = event.target;
		const routes = { 'password-login-form': '/auth/password', 'signup-form': '/auth/signup', 'forgot-form': '/auth/forgot-password', 'factor-form': '/auth/two-factor', 'redeem-reset-form': '/auth/reset-password', 'confirm-email-form': '/auth/email' };
		routes['sso-start-form'] = '/auth/sso/start';
		if (form.id === 'sso-recover-form') routes[form.id] = '/auth/sso/' + form.dataset.account + '/recovery';
		if (!routes[form.id] && !['totp-form', 'passkey-add-form', 'sso-settings-form'].includes(form.id)) return;
		event.preventDefault();
		const button = event.submitter;
		if (button) button.disabled = true;
		try {
			const fields = Object.fromEntries(new FormData(form));
			if (routes[form.id]) {
				const result = await client.request(routes[form.id], 'POST', fields);
				const persistent = { 'signup-form': ['#signup-content', '#signup-confirmation'], 'forgot-form': ['#forgot-content', '#forgot-confirmation'] }[form.id];
				if (persistent) {
					document.querySelector(persistent[0]).classList.add('d-none');
					document.querySelector(persistent[1]).classList.remove('d-none');
				} else if (result.password) {
					document.querySelector('#new-password').value = result.password;
					document.querySelector('#public-password-result').classList.remove('d-none');
					form.hidden = true;
				} else await this.finish(result);
			} else if (form.id === 'sso-settings-form') {
				const body = { ...fields, revision: Number(form.dataset.revision), enabled: Boolean(fields.enabled), enforce: Boolean(fields.enforce), provision: Boolean(fields.provision) };
				if (body.enforce && form.dataset.enforced !== 'true' && !await client.confirm('Require SSO for this account? Members and connected apps must authenticate through SSO. Keep your owner recovery code available.')) return;
				await this.sso('PUT', body);
				client.toast('Single sign-on settings saved');
			} else if (form.id === 'totp-form') {
				const result = await client.request('security/totp/' + this.totpAction, 'POST', fields);
				this.factorState(result.enabled);
				this.clearFactor();
				client.toast(result.enabled ? '2FA enabled' : '2FA disabled');
			} else {
				if (!window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) throw new Error('This browser does not support passkeys. Use a current browser on HTTPS or localhost.');
				const options = await client.request('security/passkeys/options', 'POST', {});
				const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
				const result = await client.request('security/passkeys/verify', 'POST', { name: fields.name, response });
				await this.key(result.key);
				client.toast('Passkey added');
			}
		} catch (error) { client.toast(error.message, 'error'); }
		finally { if (button) button.disabled = false; }
	}
	factorState(enabled) {
		document.querySelector('#totp-status').textContent = enabled ? '2FA is enabled' : '2FA is not enabled';
		document.querySelector('#setup-totp').hidden = enabled;
		document.querySelector('#disable-totp').hidden = !enabled;
	}
	clearFactor() {
		document.querySelector('#totp-setup').classList.add('d-none');
		document.querySelector('#totp-verify').classList.add('d-none');
		document.querySelector('#totp-secret').textContent = '';
		document.querySelector('#totp-qr').removeAttribute('src');
		document.querySelector('#totp-code').value = '';
	}
	async key(key) {
		if (!document.querySelector('[data-passkey="' + key._id + '"]')) client.update('[data-passkey="' + key._id + '"]', '#passkeys', await client.request('security/passkeys/' + key._id, 'GET', null, true));
	}
	async security() {
		const result = await client.request('security');
		this.factorState(result.totp_enabled);
		const ids = new Set(result.keys.map(key => key._id));
		document.querySelectorAll('[data-passkey]').forEach(node => { if (!ids.has(node.dataset.passkey)) node.remove(); });
		for (const key of result.keys) await this.key(key);
	}
	async click(event) {
		const button = event.target.closest('button');
		if (!button) return;
		if (button.hasAttribute('data-sso-refresh')) {
			button.disabled = true;
			try { await this.sso(); } finally { button.disabled = false; }
		}
		if (button.hasAttribute('data-sso-recovery-code') && await client.confirm('Generate a new recovery code? The previous code will stop working. Save the new code outside TypeRelay.')) {
			button.disabled = true;
			try { await this.sso('POST', {}, '/recovery-code'); } finally { button.disabled = false; }
		}
		if (button.hasAttribute('data-sso-hide-secret')) document.querySelector('#sso-recovery-secret')?.remove();
		if (button.hasAttribute('data-sso-logs')) {
			button.disabled = true;
			try { const result = await client.request('sso/logs'); client.update('#sso-login-logs', '#sso-logs-container', result.html); } finally { button.disabled = false; }
		}
		if (button.id === 'magic-link-btn' || button.id === 'magic-link-back') {
			const magic = button.id === 'magic-link-btn';
			document.querySelector('#login-options').classList.toggle('d-none', magic);
			document.querySelector('#magic-link-form').classList.toggle('d-none', !magic);
			document.querySelector(magic ? '#magic-email' : '#email').focus();
		}
		if (button.id === 'passkey-btn') {
			button.disabled = true;
			try {
				if (!window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) throw new Error('This browser does not support passkeys. Use password or magic-link sign-in.');
				const options = await client.request('/auth/passkey/options', 'POST', {});
				const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
				await this.finish(await client.request('/auth/passkey/verify', 'POST', { response }));
			} finally { button.disabled = false; }
		}
		if (button.id === 'reset-password' && await client.confirm('Generate a new password? Your existing password will stop working.')) {
			button.disabled = true;
			try {
				const result = await client.request('security/password', 'POST', {});
				document.querySelector('#new-password').value = result.password;
				document.querySelector('#password-result').classList.remove('d-none');
			} finally { button.disabled = false; }
		}
		if (button.id === 'copy-password') { await navigator.clipboard.writeText(document.querySelector('#new-password').value); client.toast('Password copied'); }
		if (button.id === 'password-copied') { document.querySelector('#new-password').value = ''; document.querySelector('#password-result').classList.add('d-none'); }
		if (button.id === 'setup-totp') {
			button.disabled = true;
			try {
				const result = await client.request('security/totp/setup', 'POST', {});
				this.totpAction = 'confirm';
				document.querySelector('#totp-qr').src = result.qr;
				document.querySelector('#totp-secret').textContent = result.secret;
				document.querySelector('#totp-setup').classList.remove('d-none');
				document.querySelector('#totp-verify').classList.remove('d-none');
			} finally { button.disabled = false; }
		}
		if (button.id === 'disable-totp') { this.totpAction = 'disable'; document.querySelector('#totp-verify').classList.remove('d-none'); }
		if (button.id === 'cancel-totp') this.clearFactor();
		if (button.dataset.deletePasskey && await client.confirm('Remove this passkey?')) {
			await client.request('security/passkeys/' + button.dataset.deletePasskey, 'DELETE');
			document.querySelector('[data-passkey="' + button.dataset.deletePasskey + '"]').remove();
		}
	}
}
new AccountUI();
