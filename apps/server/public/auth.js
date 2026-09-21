// Streamient-style password, magic-link, passkey and authenticator flows.
import { client } from './app.js';

class AccountUI {
	totpAction = 'confirm';
	constructor() {
		document.addEventListener('submit', event => this.submit(event));
		document.addEventListener('click', event => this.click(event).catch(error => client.toast(error.message, 'error')));
		document.querySelector('#settings')?.addEventListener('show.bs.modal', () => this.security().catch(error => client.toast(error.message, 'error')));
		document.querySelector('#settings')?.addEventListener('hidden.bs.modal', () => {
			const password = document.querySelector('#new-password');
			if (password) password.value = '';
			document.querySelector('#password-result')?.classList.add('d-none');
		});
	}
	async finish(result) {
		if (result.csrf) document.querySelector('meta[name=csrf-token]').content = result.csrf;
		if (result.redirect) location.assign(result.redirect);
		else if (result.message) client.toast(result.message);
	}
	async submit(event) {
		const form = event.target;
		const routes = { 'password-login-form': '/auth/password', 'signup-form': '/auth/signup', 'forgot-form': '/auth/forgot-password', 'factor-form': '/auth/two-factor', 'redeem-reset-form': '/auth/reset-password', 'confirm-email-form': '/auth/email' };
		if (!routes[form.id] && !['totp-form', 'passkey-add-form'].includes(form.id)) return;
		event.preventDefault();
		const button = event.submitter;
		if (button) button.disabled = true;
		try {
			const fields = Object.fromEntries(new FormData(form));
			if (routes[form.id]) {
				const result = await client.request(routes[form.id], 'POST', fields);
				if (form.id === 'signup-form') {
					document.querySelector('#signup-content').classList.add('d-none');
					document.querySelector('#signup-confirmation').classList.remove('d-none');
				} else if (result.password) {
					document.querySelector('#new-password').value = result.password;
					document.querySelector('#public-password-result').classList.remove('d-none');
					form.hidden = true;
				} else await this.finish(result);
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
