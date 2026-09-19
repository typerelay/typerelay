export class PasswordField {
	static generate(length = 32) {
		if (!window.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable');
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; const values = new Uint8Array(length); window.crypto.getRandomValues(values);
		return Array.from(values, value => alphabet[value & 63]).join('');
	}
	static fill(input, status, submit, announce = true) {
		try { input.value = PasswordField.generate(); if (status) status.textContent = announce ? 'New password generated.' : ''; if (submit) submit.disabled = false; }
		catch (error) { input.value = ''; if (status) status.textContent = 'Password generation failed. Reload this page and try again.'; if (submit) submit.disabled = true; }
	}
	static async copy(input, status, copied) {
		if (!input?.value) throw new Error('No password to copy');
		if (navigator.clipboard?.writeText && window.isSecureContext) try { await navigator.clipboard.writeText(input.value); if (status) status.textContent = ''; await copied(); return; } catch { /* Fall back when browser clipboard permission is denied. */ }
		input.focus({ preventScroll: true }); input.select(); input.setSelectionRange?.(0, input.value.length);
		if (document.execCommand?.('copy')) { if (status) status.textContent = ''; await copied(); return; }
		if (status) status.textContent = 'Password selected. Press ' + (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Cmd+C' : 'Ctrl+C') + ' to copy.';
	}
}
