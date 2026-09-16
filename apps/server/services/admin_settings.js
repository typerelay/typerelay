import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import managani from '@managani/node';
import { Parser } from 'htmlparser2';
import pug from 'pug';
import { emailTemplates } from '../config/email_templates.js';
import { mongoose, Account, SystemSetting, User, AdminAudit, ApiAudit } from '../model/index.js';
import { Support } from './support.js';
import { Auth } from './auth.js';

export class AdminSettings {
	static templates = emailTemplates;
	static async get(key, fallback = {}) { return (await SystemSetting.findOne({ key }).lean())?.value ?? fallback; }
	static async set(key, value) { await SystemSetting.updateOne({ key }, { $set: { value }, $inc: { revision: 1 } }, { upsert: true }); return value; }
	static validateTemplate(key, input) {
		const template = AdminSettings.templates[key]; Support.assert(template, 'Unknown template', 404);
		Support.assert(typeof input.subject === 'string' && input.subject.trim() && input.subject.length <= 200 && !/[\r\n]/.test(input.subject), 'Enter a subject up to 200 characters');
		Support.assert(typeof input.text === 'string' && input.text.length <= 20000 && input.text.includes('{{url}}'), 'Message must include {{url}} and be at most 20,000 characters');
		const html = input.html ?? '';
		Support.assert(typeof html === 'string' && html.length <= 50000 && (!html.trim() || html.includes('{{url}}')), 'HTML must include {{url}} and be at most 50,000 characters');
		for (const match of (input.subject + input.text + html).matchAll(/{{\s*([^{}]+)\s*}}/g)) Support.assert(template.variables.includes(match[1].trim()), 'Unknown template variable: ' + match[1]);
		return { subject: input.subject.trim(), text: input.text, html: html.trim() };
	}
	static plainText(html) {
		let text = ''; let link = ''; let ignored = 0;
		const parser = new Parser({ onopentag: (name, attributes) => { if (['script', 'style'].includes(name)) ignored++; if (ignored) return; if (name === 'a') link = attributes.href || ''; if (name === 'br') text += '\n'; if (name === 'li') text += '\n- '; }, ontext: value => { if (!ignored) text += value; }, onclosetag: name => { if (['script', 'style'].includes(name)) { ignored = Math.max(0, ignored - 1); return; } if (ignored) return; if (name === 'a' && link) { text += ': ' + link; link = ''; } if (['p', 'div', 'ul', 'ol', 'h1', 'h2', 'h3'].includes(name)) text += '\n\n'; } }, { decodeEntities: true });
		parser.end(html);
		return text.replace(/\n{3,}/g, '\n\n').trim();
	}
	static async template(key) {
		const defaults = AdminSettings.templates[key]; Support.assert(defaults, 'Unknown template', 404);
		const stored = await AdminSettings.get('email.' + key);
		const placeholder = stored.text?.trim() === '{{url}}' && !stored.html;
		const text = typeof stored.text === 'string' && !placeholder ? stored.text : AdminSettings.plainText(defaults.html);
		const html = placeholder ? defaults.html : typeof stored.html === 'string' ? stored.html : typeof stored.text === 'string' ? '' : defaults.html;
		return { key, ...defaults, subject: stored.subject || defaults.subject, text, html };
	}
	static escape(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
	static render(template, variables) {
		const result = Object.fromEntries(['subject', 'text', ...(template.html ? ['html'] : [])].map(field => [field, template[field].replace(/{{\s*(\w+)\s*}}/g, (_, key) => field === 'html' ? AdminSettings.escape(variables[key] ?? '') : String(variables[key] ?? ''))]));
		result.subject = result.subject.replace(/[\r\n]+/g, ' ');
		return result;
	}
	static samples() { return { url: Auth.origin + '/example-link', name: 'Alex', inviterName: 'Sam', tenantName: 'Example team' }; }
	static preview(template) { const result = AdminSettings.render(template, AdminSettings.samples()); return { ...result, preview_html: pug.renderFile('./views/ajax/admin-email-preview.pug', { message: result }) }; }
	static async send(key, to, variables) {
		const template = await AdminSettings.template(key);
		const values = { ...variables };
		if (template.variables.includes('name') && !values.name) values.name = (await User.findOne({ email: to }).select('name').lean())?.name || 'there';
		return Auth.mail.sendMail({ to, ...AdminSettings.render(template, values) });
	}
	static key() { const raw = process.env.GIT_ENCRYPTION_KEY || ''; const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw); Support.assert(key.length === 32, 'Configure GIT_ENCRYPTION_KEY with 32 bytes or 64 hex characters', 503); return key; }
	static encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', AdminSettings.key(), iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(item => item.toString('hex')).join(':'); }
	static decrypt(value) { const [iv, tag, data] = value.split(':').map(item => Buffer.from(item, 'hex')); const cipher = createDecipheriv('aes-256-gcm', AdminSettings.key(), iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'); }
	static origin(value) { let url; try { url = new URL(value); } catch {} Support.assert(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Enter an HTTP(S) origin without a path'); Support.assert(process.env.NODE_ENV !== 'production' || url.protocol === 'https:', 'HTTPS is required in production'); return url.origin; }
	static async managani(mask = true) {
		const settings = await AdminSettings.get('managani', { enabled: false, base_url: '', site_key: '' });
		return mask ? { enabled: settings.enabled, base_url: settings.base_url, site_key: settings.site_key, site_secret_configured: !!settings.secret } : settings;
	}
	static async saveManagani(body) {
		Support.assert(typeof body.enabled === 'boolean', 'Invalid enabled flag');
		const current = await AdminSettings.managani(false);
		const settings = { enabled: body.enabled, base_url: body.base_url ? AdminSettings.origin(body.base_url) : '', site_key: String(body.site_key || '').trim().slice(0, 1000), secret: current.secret || '' };
		Support.assert(!(body.clear_site_secret && body.site_secret), 'Choose replace or clear secret');
		if (body.clear_site_secret) settings.secret = '';
		if (body.site_secret) { Support.assert(typeof body.site_secret === 'string' && body.site_secret.length <= 4096, 'Invalid secret'); settings.secret = AdminSettings.encrypt(body.site_secret); }
		Support.assert(!settings.enabled || (settings.base_url && settings.site_key && settings.secret && AdminSettings.decrypt(settings.secret)), 'Complete Managani configuration before enabling');
		await AdminSettings.set('managani', settings);
		return AdminSettings.managani();
	}
	static async customCode() { return AdminSettings.get('custom_code', { js: '', css: '', origins: [] }); }
	static client(settings) { return managani.createManaganiClient({ baseUrl: settings.base_url, siteKey: settings.site_key, siteSecret: AdminSettings.decrypt(settings.secret), timeout: 3000 }); }
	static async saveCustomCode(body) {
		Support.assert(typeof body.js === 'string' && typeof body.css === 'string' && body.js.length <= 50000 && body.css.length <= 50000, 'JS/CSS must be text up to 50,000 characters each');
		Support.assert(!/<\/?(?:script|style)\b/i.test(body.js + body.css), 'Enter JavaScript/CSS without script or style tags');
		Support.assert(Array.isArray(body.origins) && body.origins.length <= 20, 'Enter at most 20 external origins');
		return AdminSettings.set('custom_code', { js: body.js, css: body.css, origins: [...new Set(body.origins.map(AdminSettings.origin))] });
	}
	static async application(req, res, profile, ctx) {
		res.locals.customCode = await AdminSettings.customCode();
		const origins = [...res.locals.customCode.origins];
		try {
			const settings = await AdminSettings.managani(false);
			if (settings.enabled) {
				const client = AdminSettings.client(settings);
				const user = { id: String(profile._id), name: profile.name, email: profile.email, role: ['owner', 'admin'].includes(ctx.role) ? 'admin' : 'user', metadata: { host_id: ctx.account, is_paid: ctx.entitlements.plan !== 'free' } };
				res.locals.managani = { url: settings.base_url + '/managani.js', key: settings.site_key, token: client.signUser(user).token };
				origins.push(settings.base_url);
			}
		} catch { console.error('Managani widget unavailable'); }
		const directives = String(res.getHeader('Content-Security-Policy') || '').split(';').map(value => value.trim()).filter(Boolean);
		for (const name of ['script-src', 'style-src', 'connect-src', 'img-src', 'frame-src']) {
			let index = directives.findIndex(value => value.startsWith(name + ' '));
			if (index < 0) { index = directives.length; directives.push(name + " 'self'"); }
			if (name === 'script-src') directives[index] += " 'nonce-" + res.locals.styleNonce + "'";
			directives[index] += origins.length ? ' ' + [...new Set(origins)].join(' ') : '';
		}
		res.setHeader('Content-Security-Policy', directives.join(';'));
	}
	static middleware(req, res, next) {
		res.once('finish', () => {
			if (!req.ctx || res.statusCode >= 400 || !(req.path === '/' || /^\/api\/v[23]\//.test(req.originalUrl))) return;
			AdminSettings.track(req.ctx, req.method === 'GET' ? 'pageview' : 'user_action', { page: req.route?.path || '/api', method: req.method, status_code: res.statusCode }).catch(() => console.error('Managani tracking unavailable'));
		});
		next();
	}
	static async track(ctx, event, metadata) {
		try {
			const settings = await AdminSettings.managani(false); if (!settings.enabled) return;
			const user = await User.findById(ctx.user).select('email name').lean(); if (!user) return;
			const client = AdminSettings.client(settings);
			await client.track({ id: ctx.user, email: user.email, name: user.name, metadata: { host_id: ctx.account } }, event, { app_instance: 'typerelay', metadata });
		} catch { console.error('Managani tracking unavailable'); }
	}
	static status() { return { smtp: !!process.env.SMTP_SERVERS, stripe: !!process.env.STRIPE_SECRET_KEY, stripe_webhook: !!process.env.STRIPE_WEBHOOK_SECRET, cloudflare: !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID), helpmonks: !!(process.env.HELPMONKS_SIGNUP_API_URL || process.env.HELPMONKS_API_URL), secret_encryption: !!process.env.GIT_ENCRYPTION_KEY }; }
	static async audit(actor, operation, account = null, status = 200) {
		const record = { actor, operation, ...(account ? { account } : {}), status };
		if (!account) { await AdminAudit.create(record); return; }
		await mongoose.connection.transaction(async session => { const active = await Account.updateOne({ _id: account, 'deletion.requested_at': null }, { $inc: { activity_sequence: 1 } }, { session }); if (active.matchedCount) await AdminAudit.create([record], { session }); });
	}
	static async logs(query = {}) {
		const filter = {};
		if (query.account) filter.account = new mongoose.Types.ObjectId(Support.id(query.account));
		if (query.action) filter.operation = String(query.action).slice(0, 100);
		if (query.actor) filter.actor = String(query.actor).slice(0, 254);
		if (query.result === 'success') filter.status = { $lt: 400 }; else if (query.result === 'failure') filter.status = { $gte: 400 };
		for (const [key, op] of [['from', '$gte'], ['to', '$lte']]) if (query[key]) { const date = new Date(query[key]); Support.assert(Number.isFinite(+date), 'Invalid date'); filter.createdAt = { ...filter.createdAt, [op]: date }; }
		const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
		const rows = await AdminAudit.aggregate([{ $unionWith: { coll: ApiAudit.collection.name, pipeline: [{ $addFields: { actor: { $toString: '$user' } } }] } }, { $match: filter }, { $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * 50 }, { $limit: 51 }]);
		return { rows: rows.slice(0, 50), more: rows.length > 50, page, query };
	}
}
