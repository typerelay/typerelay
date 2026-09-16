import { Router } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import pug from 'pug';
import { AdminAccounts } from './services/admin_accounts.js';
import { AdminSettings } from './services/admin_settings.js';
import { Auth } from './services/auth.js';
import { Security } from './services/security.js';
import { Support } from './services/support.js';
import { Account } from './model/index.js';

export class Admin {
	static credentials(email, password) {
		if (!process.env.SYSADMIN_EMAIL || !process.env.SYSADMIN_PASSWORD || typeof email !== 'string' || typeof password !== 'string' || password.length > 1024) return false;
		const digest = value => createHash('sha256').update(value).digest();
		return timingSafeEqual(digest(email.trim().toLowerCase()), digest(process.env.SYSADMIN_EMAIL.trim().toLowerCase())) && timingSafeEqual(digest(password), digest(process.env.SYSADMIN_PASSWORD));
	}
	static fingerprint() { return Support.hash((process.env.SYSADMIN_EMAIL || '') + '\0' + (process.env.SYSADMIN_PASSWORD || '')); }
	static fragment(account) { return { account, id: account.id, revision: account.revision, html: pug.renderFile('./views/ajax/admin-account.pug', { account }) }; }
	static async templateResult(key) { const template = await AdminSettings.template(key); return { id: key, template, html: pug.renderFile('./views/ajax/admin-template.pug', { template }) }; }
	static mount(app) {
		const router = Router();
		router.use((req, res, next) => {
			const origin = new URL(Auth.origin);
			Support.assert(!req.boundAccount && req.headers.host?.toLowerCase() === origin.host.toLowerCase() && (!req.headers['x-forwarded-host'] || String(req.headers['x-forwarded-host']).split(',')[0].trim().toLowerCase() === origin.host.toLowerCase()) && (!req.headers.origin || req.headers.origin === origin.origin), 'Admin is available only on the platform origin', 403);
			res.set('Cache-Control', 'no-store');
			if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) Support.assert(req.headers['x-csrf-token'] === req.session.csrf, 'Session expired; sign in again', 403);
			next();
		});
		router.get('/login', (req, res) => res.render('admin/login'));
		router.post('/login', rateLimit({ windowMs: 900000, limit: 10, message: { error: 'Too many admin sign-in attempts; try again later.' } }), async (req, res) => {
			const valid = Admin.credentials(req.body.email, req.body.password);
			await AdminSettings.audit('system-admin', 'admin.login', null, valid ? 200 : 401);
			Support.assert(valid, 'Invalid credentials', 401);
			await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
			req.session.admin = { fingerprint: Admin.fingerprint(), expires: Date.now() + 8 * 3600000 };
			req.session.csrf = Support.token();
			await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
			res.json({ redirect: '/admin', csrf: req.session.csrf });
		});
		router.use((req, res, next) => {
			if (!req.session.admin || req.session.admin.expires < Date.now() || req.session.admin.fingerprint !== Admin.fingerprint() || !process.env.SYSADMIN_EMAIL || !process.env.SYSADMIN_PASSWORD) {
				if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(401).json({ error: 'System administrator sign-in required' });
				return res.redirect('/admin/login');
			}
			res.locals.adminEmail = process.env.SYSADMIN_EMAIL;
			next();
		});
		router.post('/logout', async (req, res) => { await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve())); res.json({ redirect: '/admin/login' }); });
		router.get('/', async (req, res) => res.render('admin/accounts', await AdminAccounts.list(req.query)));
		router.get('/api/accounts', async (req, res) => res.json(await AdminAccounts.list(req.query)));
		router.get('/api/accounts/new/form', (req, res) => res.render('ajax/admin-account-form', { account: null }));
		router.get('/api/accounts/:id/form', async (req, res) => res.render('ajax/admin-account-form', { account: await AdminAccounts.get(req.params.id) }));
		router.get('/api/accounts/:id', async (req, res) => res.json(Admin.fragment(await AdminAccounts.get(req.params.id))));
		router.get('/api/users.csv', async (req, res) => { await AdminSettings.audit(res.locals.adminEmail, 'users.export'); res.type('text/csv').attachment('type-relay-users.csv').send(await AdminAccounts.csv()); });
		router.post('/api/accounts', async (req, res) => { const result = await AdminAccounts.create(req.body); await AdminSettings.audit(res.locals.adminEmail, 'account.create', result.account.id); res.status(201).json({ ...Admin.fragment(result.account), warnings: result.warnings }); });
		router.put('/api/accounts/:id', async (req, res) => { const { related, ...account } = await AdminAccounts.update(req.params.id, req.body); await AdminSettings.audit(res.locals.adminEmail, 'account.update', account.id); res.json({ ...Admin.fragment(account), related: related.map(Admin.fragment) }); });
		router.delete('/api/accounts/:id', async (req, res) => { const account = await AdminAccounts.requestDeletion(req.params.id, req.body.confirmation); await AdminSettings.audit(res.locals.adminEmail, 'account.delete', account.id); res.status(202).json(Admin.fragment(account)); });
		router.get('/api/accounts/:id/deletion', async (req, res) => { const exists = await Account.exists({ _id: Support.id(req.params.id) }); res.json(exists ? Admin.fragment(await AdminAccounts.get(req.params.id)) : { deleted: req.params.id }); });
		router.post('/api/accounts/:id/deletion/retry', async (req, res) => res.status(202).json(Admin.fragment(await AdminAccounts.retry(req.params.id))));
		router.get('/email-templates', async (req, res) => res.render('admin/templates', { templates: await Promise.all(Object.keys(AdminSettings.templates).map(AdminSettings.template)) }));
		router.get('/api/email-templates/:key/form', async (req, res) => res.render('ajax/admin-template-form', { template: await AdminSettings.template(req.params.key) }));
		router.put('/api/email-templates/:key', async (req, res) => {
			await AdminSettings.set('email.' + req.params.key, AdminSettings.validateTemplate(req.params.key, req.body));
			await AdminSettings.audit(res.locals.adminEmail, 'email-template.update');
			res.json(await Admin.templateResult(req.params.key));
		});
		router.post('/api/email-templates/:key/reset', async (req, res) => {
			Support.assert(AdminSettings.templates[req.params.key], 'Unknown template', 404); await AdminSettings.set('email.' + req.params.key, {}); await AdminSettings.audit(res.locals.adminEmail, 'email-template.reset');
			res.json(await Admin.templateResult(req.params.key));
		});
		router.post('/api/email-templates/:key/preview', (req, res) => res.json(AdminSettings.render(AdminSettings.validateTemplate(req.params.key, req.body), { url: Auth.origin + '/example-link' })));
		router.post('/api/email-templates/:key/test', rateLimit({ windowMs: 60000, limit: 10 }), async (req, res) => { await AdminSettings.send(req.params.key, Security.email(req.body.email), { url: Auth.origin + '/example-link' }); await AdminSettings.audit(res.locals.adminEmail, 'email-template.test'); res.json({ message: 'Test email sent' }); });
		router.get('/settings', async (req, res) => res.render('admin/settings', { managani: await AdminSettings.managani(), customCode: await AdminSettings.customCode(), status: AdminSettings.status() }));
		router.get('/api/settings', async (req, res) => res.json({ managani: await AdminSettings.managani(), custom_code: await AdminSettings.customCode(), status: AdminSettings.status() }));
		router.put('/api/settings/managani', async (req, res) => { const settings = await AdminSettings.saveManagani(req.body); await AdminSettings.audit(res.locals.adminEmail, 'settings.managani'); res.json({ settings }); });
		router.put('/api/settings/custom-code', async (req, res) => { const settings = await AdminSettings.saveCustomCode(req.body); await AdminSettings.audit(res.locals.adminEmail, 'settings.custom-code'); res.json({ settings }); });
		router.get('/audit-logs', async (req, res) => res.render('admin/audit', await AdminSettings.logs(req.query)));
		router.get('/api/audit-logs', async (req, res) => res.json(await AdminSettings.logs(req.query)));
		router.use((error, req, res, next) => { if (req.session.admin && !['GET', 'HEAD'].includes(req.method)) AdminSettings.audit(res.locals.adminEmail || 'system-admin', `failed.${req.method.toLowerCase()}.${req.route?.path || '/admin'}`, /^[a-f0-9]{24}$/.test(req.params?.id || '') ? req.params.id : null, error.status || 500).catch(() => console.error('Admin audit failed')); next(error); });
		app.use('/admin', router);
	}
}
