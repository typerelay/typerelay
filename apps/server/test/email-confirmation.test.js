import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EmailConfirmation } from '../public/email-confirmation.js';

test('email confirmation banner is removed in place once confirmed and Resend posts', async () => {
	const dom = new JSDOM('<div id="email-confirmation-banner"><button id="email-confirmation-resend">Resend</button></div>');
	Object.assign(globalThis, { window: dom.window, document: dom.window.document });
	const calls = [];
	const toasts = [];
	let confirmed = false;
	const app = { request: async (path, method = 'GET') => { calls.push(method); return method === 'GET' ? { confirmed } : { message: 'Sent' }; }, toast: (message, icon) => toasts.push([message, icon]) };
	try {
		const banner = new EmailConfirmation(app);
		dom.window.document.querySelector('#email-confirmation-resend').click();
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(calls, ['POST']);
		assert.deepEqual(toasts, [['Sent', undefined]]);
		await banner.refresh();
		assert.ok(dom.window.document.querySelector('#email-confirmation-banner'));
		confirmed = true;
		dom.window.dispatchEvent(new dom.window.Event('focus'));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(dom.window.document.querySelector('#email-confirmation-banner'), null);
	} finally {
		delete globalThis.window;
		delete globalThis.document;
		dom.window.close();
	}
});
