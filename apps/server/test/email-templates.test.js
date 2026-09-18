import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { AdminSettings } from '../services/admin_settings.js';

test('Mailtwine-style defaults cover every active Type Relay email flow with HTML and text', () => {
	assert.deepEqual(Object.keys(AdminSettings.templates), ['login', 'signup', 'email-change', 'password-reset', 'invite', 'team-member-added']);
	for (const [key, definition] of Object.entries(AdminSettings.templates)) {
		const template = { ...definition, text: AdminSettings.plainText(definition.html) };
		assert.doesNotThrow(() => AdminSettings.validateTemplate(key, template));
		const message = AdminSettings.render(template, { name: 'Alex', inviterName: 'Sam', tenantName: 'Example team', url: 'https://app.example.test/action?token=abc&other=def' });
		assert.match(message.html, /<p>/); assert.match(message.text, /https:\/\/app.example.test\/action\?token=abc&other=def/); assert.ok(message.text.length > 200);
		assert.doesNotMatch(message.html + message.text + message.subject, /Mailtwine|{{|24 hours|1 hour|account will be locked/);
		if (key === 'invite') assert.match(message.text, /7 days/); else if (key !== 'team-member-added') assert.match(message.text, /15 minutes/);
		const dom = new JSDOM(message.html); assert.equal(dom.window.document.querySelector('a').href, 'https://app.example.test/action?token=abc&other=def'); dom.window.close();
	}
	assert.match(AdminSettings.templates['password-reset'].html, /generate a new password/);
});

test('email interpolation escapes HTML values and uses replacement strings literally', () => {
	const defaults = AdminSettings.templates.invite;
	const message = AdminSettings.render({ ...defaults, text: AdminSettings.plainText(defaults.html) }, { name: '<img src=x onerror=alert(1)>', inviterName: 'Sam\r\nBcc: victim@example.test', tenantName: 'A & B $&', url: 'https://example.test/?token="quoted"&next=<unsafe>' });
	assert.doesNotMatch(message.html, /<img/); assert.match(message.html, /&lt;img/); assert.match(message.html, /A &amp; B \$&amp;/); assert.match(message.html, /&quot;quoted&quot;/); assert.doesNotMatch(message.subject, /[\r\n]/); assert.match(message.text, /A & B \$&/);
});

test('HTML validation and preview keep active content isolated from the admin page', () => {
	assert.throws(() => AdminSettings.validateTemplate('login', { subject: 'Sign in', text: '{{url}}', html: '<p>{{bad}}</p>{{url}}' }), /Unknown template variable/);
	assert.throws(() => AdminSettings.validateTemplate('login', { subject: 'Sign in', text: '{{url}}', html: '<p>No link</p>' }), /HTML must include/);
	const preview = AdminSettings.preview({ subject: 'Preview', text: '{{url}}', html: '<script>window.parent.injected=true</script><p>{{url}}</p>' });
	const dom = new JSDOM(preview.preview_html);
	const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
	assert.match(policy, /default-src 'none'/); assert.match(policy, /form-action 'none'/); assert.match(policy, /img-src data:/);
	assert.doesNotMatch(preview.html, /{{url}}/); dom.window.close();
});
