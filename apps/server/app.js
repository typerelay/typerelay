import express from 'express';
import { Admin } from './admin.js';
import { AdminSettings } from './services/admin_settings.js';
import { AccountAccess } from './services/account_access.js';
import pug from 'pug';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { mkdir, rm } from 'node:fs/promises';
import formidable from 'formidable';
import { mongoose, User, Account, Member, Device, Conflict, Group, Ticket, Operation } from './model/index.js';
import { Auth } from './services/auth.js';
import { Support, Yaml } from './services/support.js';
import { Libraries } from './services/libraries.js';
import { Team } from './services/team.js';
import { StorageMigration } from './services/storage_migration.js';
import { PublicApi } from './api/public.js';
import { Security } from './services/security.js';
import { Scheduler } from './services/scheduler.js';
import { Billing } from './services/billing.js';
import { WhiteLabel } from './services/white_label.js';
import { Assets } from './services/assets.js';
import { Bundles } from './services/bundles.js';

export class Server {
	static async start() {
		await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
		if (process.env.SERVER_MODE === 'scheduler') {
			Scheduler.start();
			console.log('TypeRelay scheduler running: Trash cleanup daily; trial and white-label reconciliation every five minutes; Helpmonks trial enrollment every minute');
			return;
		}
		await StorageMigration.code();
		await Promise.all(Object.values(mongoose.models).map(model => model.createIndexes()));
		await StorageMigration.run();
		const app = express();
		if (process.env.IS_DOCKER === 'true') app.set('trust proxy', 1);
		app.set('view engine', 'pug');
		app.set('views', './views');
		app.use((req, res, next) => { res.locals.styleNonce = Support.token(); next(); });
		app.use('/docs', helmet({ contentSecurityPolicy: false }), express.static(process.env.DOCS_DIR || '/docs', { extensions: ['html'] }));
		app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': Auth.origin.startsWith('https:') ? [] : null, 'script-src': ["'self'", "'wasm-unsafe-eval'"], 'style-src': ["'self'", (req, res) => "'nonce-" + res.locals.styleNonce + "'"], 'style-src-attr': ["'unsafe-inline'"], 'img-src': ["'self'", 'data:'] } } }));
		app.use(AccountAccess.middleware);
		app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => { Support.assert(req.headers['stripe-signature'], 'Missing Stripe-Signature', 400); try { await Billing.handleWebhook(req.body, req.headers['stripe-signature']); res.json({ received: true }); } catch (error) { error.status ||= 400; throw error; } });
		app.use(express.json({ limit: '12mb' }), express.urlencoded({ extended: false, limit: '32kb' }));
		app.use('/assets/generated', express.static('/data/editor'));
		app.use('/assets', express.static('public'));
		app.use('/vendor/webauthn', express.static('node_modules/@simplewebauthn/browser/dist/bundle'));
		app.use('/vendor/bootstrap', express.static('node_modules/bootstrap/dist'));
		app.use('/vendor/sweetalert2', express.static('node_modules/sweetalert2/dist'));
		app.use('/white-label-assets', express.static(WhiteLabel.assetsRoot(), { index: false, maxAge: '7d' }));
		const sessionStore = MongoStore.create({ mongoUrl: process.env.MONGO_URI, collectionName: 'web_sessions' });
		app.use(session({ name: 'typerelay.sid', secret: process.env.SESSION_SECRET || 'change-me', store: sessionStore, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: Auth.origin.startsWith('https:'), maxAge: 7 * 86400000 } }));
		app.use(WhiteLabel.resolveRequest);
		app.use(async (req, res, next) => {
			if (req.session.user) {
				const user = await User.findById(req.session.user).select('auth_version').lean();
				if (!user || (user.auth_version || 0) !== (req.session.auth_version || 0)) { delete req.session.user; delete req.session.auth_at; }
			}
			res.locals.serverOrigin = Auth.origin;
			res.locals.passkeysAvailable = !req.boundAccount;
			res.locals.signupEnabled = Security.signupEnabled();
			res.locals.csrf = req.session.csrf ||= Support.token();
			if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !['/oauth/token', '/integrations/token', '/integrations/register'].includes(req.path) && !req.headers.authorization) Support.assert((req.headers['x-csrf-token'] || req.body?._csrf) === req.session.csrf, 'Session expired; reload and retry', 403);
			next();
		});
		Admin.mount(app);
		app.use(AdminSettings.middleware);
		app.get('/health', (req, res) => res.json({ ok: true }));
		const authLimit = rateLimit({ windowMs: 900000, limit: 30, message: { error: 'Too many sign-in attempts; try again later.' } });
		Security.mount(app, authLimit);
		await PublicApi.mount(app, authLimit);
		app.post('/auth/login', authLimit, async (req, res) => { await Auth.login(req.body.email, null, { origin: req.boundAccount ? Server.requestOrigin(req) : Auth.origin, account: req.boundAccount }); res.json({ message: 'Check your email for a sign-in link.' }); });
		app.get('/auth/callback', async (req, res) => {
			const user = await Auth.consume(req.query.token);
			const result = await Security.establish(req, user);
			res.redirect(result.redirect);
		});
		app.post('/auth/logout', async (req, res) => { await new Promise(resolve => req.session.destroy(resolve)); res.json({ signed_out: true }); });
		app.post('/oauth/token', authLimit, async (req, res) => res.json(await Auth.exchange(req.body)));
		app.get('/oauth/authorize', async (req, res) => {
			if (!req.session.user) { req.session.return_to = req.originalUrl; return res.render('login', { returnTo: req.originalUrl }); }
			const redirect = new URL(Auth.redirect(req.query.redirect_uri));
			res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy')).replace("form-action 'self'", "form-action 'self' " + (redirect.protocol === 'typerelay:' ? redirect.protocol : redirect.origin)));
			const memberships = await Member.find({ user: req.session.user }).lean();
			const accounts = (await Account.find({ _id: { $in: memberships.map(member => member.account) } }).lean()).filter(account => !req.boundAccount || String(account._id) === req.boundAccount);
			res.render('authorize', { accounts, request: req.query });
		});
		app.post('/oauth/authorize', async (req, res) => { Support.assert(req.session.user, 'Sign in required', 401); res.redirect(await Auth.authorize(req.session.user, req.body)); });
		app.get('/', async (req, res) => {
			if (!req.session.user) { if (req.query.invite) req.session.return_to = '/?invite=' + encodeURIComponent(req.query.invite); return res.render('login'); }
			const memberships = await Member.find({ user: req.session.user }).lean();
			const records = await Account.find({ _id: { $in: memberships.map(member => member.account) } }).lean();
			const accounts = records.filter(account => account.is_active !== false && !account.deletion?.requested_at && (Billing.entitlements(account).plan === 'team' || memberships.find(member => String(member.account) === String(account._id))?.role === 'owner'));
			const account = accounts.find(account => String(account._id) === (req.boundAccount || req.query.account)) || (!req.boundAccount ? accounts[0] : null);
			Support.assert(account, 'Account access denied', 403);
			const ctx = await Support.context(req.session.user, String(account._id));
			req.ctx = ctx;
			res.locals.whiteLabel = WhiteLabel.public(account);
			const usage = await Billing.usage(account._id);
			const profile = await User.findById(ctx.user).lean();
			await AdminSettings.application(req, res, profile, ctx);
			res.render('app', { integrationScopes: Auth.scopes, importFormats: Libraries.importFormats, accounts, account, ctx, libraries: await Libraries.list(ctx), team: await Team.list(ctx), profile, ...Billing.locals(account, ctx, usage), whiteLabelSettings: WhiteLabel.serialize(account) });
		});
		app.get('/snippet-assets/:account/:id', async (req, res) => { const ctx = await Support.context(req.session.user, req.params.account); const asset = await Assets.get(ctx, req.params.id, true); res.set({ 'Content-Type': asset.mime_type, 'Content-Length': String(asset.size), ETag: `"${asset.id}"`, 'Cache-Control': 'private, max-age=31536000, immutable' }).send(asset.data); });
		app.use('/api/v1', (req, res) => res.status(426).json({ error: 'Upgrade TypeRelay: rich text requires sync protocol 6', protocol: 6 }));
		app.use('/api/v2', async (req, res, next) => {
			if (req.headers.authorization && req.headers['x-typerelay-sync-protocol'] !== '6') return res.status(426).json({ error: 'Upgrade TypeRelay: rich text requires sync protocol 6', protocol: 6 });
			req.ctx = req.headers.authorization ? await Auth.bearer(req.headers.authorization.replace(/^Bearer /, '')) : await Support.context(req.session.user, req.headers['x-account-id']);
			if (req.boundAccount) Support.assert(req.ctx.account === req.boundAccount, 'Custom domain account mismatch', 403);
			next();
		});
		PublicApi.mountSettings(app);
		app.post('/api/v2/assets', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: '5mb' }), async (req, res) => res.json(await Assets.put(req.ctx, req.body)));
		app.post('/api/v2/assets/presence', async (req, res) => res.json(await Assets.presence(req.ctx, req.body.ids)));
		app.put('/api/v2/assets/:id', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: '2mb' }), async (req, res) => res.json(await Assets.accept(req.ctx, req.body, req.params.id)));
		app.get('/api/v2/assets/:id', async (req, res) => { const asset = await Assets.get(req.ctx, req.params.id, true); res.set({ 'Content-Type': asset.mime_type, 'Content-Length': String(asset.size), ETag: `"${asset.id}"`, 'Cache-Control': 'private, max-age=31536000, immutable' }).send(asset.data); });
		app.post('/api/v2/assets/remote', async (req, res) => res.json(await Assets.remote(req.ctx, req.body.url)));
		app.post('/api/v2/assets/:id/refresh', async (req, res) => { const asset = await Assets.get(req.ctx, req.params.id); Support.assert(asset.source_urls?.length, 'Asset has no remote source', 409); res.json(await Assets.remote(req.ctx, asset.source_urls.at(-1))); });
		app.get('/api/v2/libraries/:id/export-bundle', async (req, res) => { const bundle = await Bundles.export(req.ctx, req.params.id); res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${bundle.name}"`, 'Content-Length': String(bundle.bytes.length) }).send(bundle.bytes); });
		app.post('/api/v2/import/bundle', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '16mb' }), async (req, res) => { const bundle = await Bundles.import(req.ctx, req.body); const result = await Libraries.mutate(req.ctx, String(req.headers['x-operation-id'] || ''), { bundle: Support.hash(req.body) }, async (ctx, session) => ({ library: await Libraries.create(ctx, bundle, session) })); Server.result(res, req.ctx, result); });
		Security.mountPrivate(app, rateLimit({ windowMs: 900000, limit: 60, message: { error: 'Too many security requests; try again later.' } }));
		app.post('/api/v2/billing/trial', async (req, res) => {
			Support.assert(Support.admin(req.ctx), 'Admin required', 403);
			await Billing.startTrial(req.ctx.account);
			res.json(await Billing.fragments(req.ctx.account, { ...req.ctx, entitlements: Billing.entitlements(await Billing.account(req.ctx.account)) }));
		});
		app.post('/api/v2/billing/checkout', async (req, res) => {
			Support.assert(Support.admin(req.ctx), 'Admin required', 403);
			const user = await Billing.owner(req.ctx.account);
			const origin = Server.requestOrigin(req);
			res.json({ url: await Billing.checkout(req.ctx.account, user, req.body, { successUrl: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${origin}/#settings-subscription` }) });
		});
		app.post('/api/v2/billing/portal', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); res.json({ url: await Billing.portal(req.ctx.account, `${Server.requestOrigin(req)}/#settings-subscription`) }); });
		app.post('/api/v2/billing/change', async (req, res) => {
			Support.assert(Support.admin(req.ctx), 'Admin required', 403);
			const result = await Billing.change(req.ctx.account, req.body, { returnUrl: `${Server.requestOrigin(req)}/#settings-subscription` });
			res.json({ ...result, ...(!result.url ? await Billing.fragments(req.ctx.account, req.ctx) : {}) });
		});
		app.get('/api/v2/billing/fragments', async (req, res) => res.json(await Billing.fragments(req.ctx.account, req.ctx)));
		app.get('/billing/success', async (req, res) => {
			Support.assert(req.session.user, 'Sign in required', 401);
			const account = await Billing.reconcileCheckout(Support.text(req.query.session_id, 256), req.session.user);
			res.redirect(`/?account=${account._id}&billing=success#settings-subscription`);
		});
		app.get('/billing/cancel', (req, res) => res.redirect('/#settings-subscription'));
		app.get('/api/v2/white-label', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); Server.whiteLabelResult(res, await WhiteLabel.settings(req.ctx.account)); });
		app.put('/api/v2/white-label/domain', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); Server.whiteLabelResult(res, await WhiteLabel.configure(req.ctx.account, req.body.hostname)); });
		app.post('/api/v2/white-label/domain/verify', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); Server.whiteLabelResult(res, await WhiteLabel.verify(req.ctx.account)); });
		app.post('/api/v2/white-label/domain/refresh', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); Server.whiteLabelResult(res, await WhiteLabel.refresh(req.ctx.account)); });
		app.delete('/api/v2/white-label/domain', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); Server.whiteLabelResult(res, await WhiteLabel.remove(req.ctx.account)); });
		app.post('/api/v2/white-label/assets/:kind', async (req, res) => {
			Support.assert(Support.admin(req.ctx), 'Admin required', 403);
			await mkdir(WhiteLabel.temporaryRoot(req.ctx.account), { recursive: true });
			const form = formidable({ uploadDir: WhiteLabel.temporaryRoot(req.ctx.account), keepExtensions: true, maxFileSize: WhiteLabel.maximumFileSize, minFileSize: 1, allowEmptyFiles: false, multiples: false });
			let file;
			try {
				const [, files] = await form.parse(req);
				file = (Array.isArray(files.file) ? files.file : [files.file]).find(value => value?.filepath);
				Support.assert(file, 'Choose an image', 400);
				Server.whiteLabelResult(res, await WhiteLabel.upload(req.ctx.account, req.params.kind, file));
			} finally { if (file?.filepath) await rm(file.filepath, { force: true }); }
		});
		app.delete('/api/v2/white-label/assets/:kind', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); Server.whiteLabelResult(res, await WhiteLabel.deleteAsset(req.ctx.account, req.params.kind)); });
		app.get('/api/v2/operations/:id', async (req, res) => {
			const receipt = await Operation.findOne({ account: req.ctx.account, user: req.ctx.user, operation: req.params.id }).lean();
			res.json(receipt ? { found: true, ...await Libraries.receipt(req.ctx, receipt.result) } : { found: false });
		});
		app.post('/api/v2/snippets/batch', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.batch(ctx, req.body, session))));
		app.get('/api/v2/trash', async (req, res) => {
			const items = await Libraries.trash(req.ctx);
			res.render('ajax/trash', { items }, (error, html) => { if (error) return res.status(500).json({ error: 'Could not render Trash' }); res.json({ items, html }); });
		});
		app.post('/api/v2/trash/action', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.trashAction(ctx, req.body.target, req.body.action, session))));
		app.post('/api/v2/trash/empty', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.empty(ctx, req.body.targets, session))));
		app.get('/api/v2/libraries/:id/export', async (req, res) => {
			const library = await Libraries.get(req.ctx, req.params.id);
			const output = await Yaml.export(library.snippets.map(Libraries.exportEntry));
			res.type('text/yaml').attachment('library-' + library._id + '.yml').send(output.yaml);
		});
		app.get('/api/v2/library-view/:id', async (req, res) => Server.result(res, req.ctx, { library: Libraries.view(req.ctx, await Libraries.get(req.ctx, req.params.id, null, true)) }));
		app.get('/api/v2/search', async (req, res) => {
			const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200).toLowerCase() : '';
			const results = [];
			if (query) for (const library of await Libraries.list(req.ctx)) {
				if (library.name.toLowerCase().includes(query)) results.push({ library: library._id, title: library.name, name: 'Library' });
				for (const snippet of library.snippets) if ((snippet.trigger || '').toLowerCase().includes(query) || (snippet.title || '').toLowerCase().includes(query) || snippet.replace.toLowerCase().includes(query)) results.push({ library: library._id, snippet: snippet.id, title: snippet.title || snippet.trigger || 'Untitled snippet', name: library.name, preview: snippet.replace.slice(0, 240) });
				if (results.length > 60) break;
			}
			res.render('ajax/search', { query, results: results.slice(0, 60), truncated: results.length > 60 });
		});
		app.get('/api/v2/libraries', async (req, res) => res.json(await Libraries.list(req.ctx)));
		app.post('/api/v2/import/:format/preview', async (req, res) => { const preview = await Libraries.previewImport(req.params.format, req.body); res.json({ ...preview, html: pug.renderFile('./views/ajax/snippetslab.pug', preview) }); });
		app.post('/api/v2/import/preview', async (req, res) => res.json(await Yaml.run(req.body.yaml)));
		app.post('/api/v2/import/:format', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.commitImport(ctx, req.params.format, req.body, session))));
		app.post('/api/v2/libraries', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, async (ctx, session) => ({ library: await Libraries.create(ctx, req.body, session) }))));
		app.patch('/api/v2/libraries/:id', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.settings(ctx, req.params.id, req.body, session))));
		app.post('/api/v2/libraries/:id/snippets', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.upload(ctx, req.params.id, req.body, session))));
		app.get('/api/v2/sync', async (req, res) => res.json(await Libraries.download(req.ctx, Number(req.query.cursor || 0))));
		app.post('/api/v2/conflicts/:id', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.resolve(ctx, req.params.id, req.body, session))));
		app.get('/api/v2/team', async (req, res) => res.json(await Team.list(req.ctx)));
		app.post('/api/v2/team/invitations', async (req, res) => res.json(await Team.invite(req.ctx, req.body.email)));
		app.delete('/api/v2/team/invitations/:id', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); await Ticket.deleteOne({ _id: Support.id(req.params.id), account: req.ctx.account, kind: 'invite' }); res.json({ deleted: req.params.id }); });
		app.post('/api/v2/team/accept', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.accept(ctx, req.body.token, session))));
		app.patch('/api/v2/team/members/:id', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.member(ctx, req.params.id, req.body, session))));
		app.post('/api/v2/team/groups', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.group(ctx, null, req.body, session))));
		app.patch('/api/v2/team/groups/:id', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.group(ctx, req.params.id, req.body, session))));
		app.delete('/api/v2/connection', async (req, res) => { Support.assert(req.ctx.device, 'Device authentication required', 401); await Device.updateOne({ _id: req.ctx.device, user: req.ctx.user, account: req.ctx.account }, { $set: { revoked: true } }); res.json({ disconnected: true }); });
		app.get('/api/v2/devices', async (req, res) => res.json(await Device.find({ account: req.ctx.account, user: req.ctx.user, revoked: false }).select('_id name createdAt').lean()));
		app.delete('/api/v2/devices/:id', async (req, res) => { await Device.updateOne({ _id: Support.id(req.params.id), account: req.ctx.account, user: req.ctx.user }, { $set: { revoked: true } }); res.json({ deleted: req.params.id }); });
		app.patch('/api/v2/profile', async (req, res) => {
			const result = await Security.profile(req);
			const member = await Member.findOne({ account: req.ctx.account, user: req.ctx.user }).lean();
			res.json({ ...result, avatar: pug.renderFile('./views/ajax/avatar.pug', { profile: result }), member: { id: String(member._id), html: pug.renderFile('./views/ajax/member.pug', { member: { ...member, profile: result }, ctx: req.ctx }) } });
		});
		app.patch('/api/v2/account', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); await Account.updateOne({ _id: req.ctx.account }, { $set: { name: Support.text(req.body.name) } }); res.json({ name: req.body.name }); });
		app.get('/api/v2/forms/:kind', async (req, res) => {
			const kind = req.params.kind;
			if (kind === 'group') Billing.assertTeam(req.ctx);
			if (kind === 'import') Support.assert(Object.hasOwn(Libraries.importFormats, req.query.format || ''), 'Unknown import format');
			Support.assert(['library', 'snippet', 'group', 'conflict', 'move', 'snippetslab', 'import'].includes(kind), 'Unknown form');
			const library = req.query.library ? Libraries.view(req.ctx, await Libraries.get(req.ctx, req.query.library, null, true)) : null;
			const group = req.query.group ? await Group.findOne({ _id: Support.id(req.query.group), account: req.ctx.account }).lean() : null;
			const conflict = req.query.conflict ? await Conflict.findOne({ _id: Support.id(req.query.conflict), account: req.ctx.account, library: library?._id, resolved: false }).lean() : null;
			if (kind === 'conflict') Support.assert(conflict && library.permissions.edit, 'Conflict not found', 404);
			const current = library?.records.find(snippet => snippet.id === conflict?.snippet) || null;
			res.render('ajax/form', { kind, importFormat: Libraries.importFormats[kind === 'snippetslab' ? 'snippetslab' : req.query.format], destinations: library ? (await Libraries.list(req.ctx)).filter(item => item.permissions.edit && item._id !== library._id) : [], library, group, conflict, current, snippet: kind === 'conflict' ? (conflict.local ? Libraries.entry(conflict.local) : current) : library?.snippets.find(snippet => snippet.id === req.query.snippet), team: await Team.list(req.ctx), ctx: req.ctx });
		});
		app.get('/api/v2/editor/:id', async (req, res) => {
			const library = Libraries.view(req.ctx, await Libraries.get(req.ctx, req.params.id));
			if (req.query.format === 'json') return res.json({ library, html: pug.renderFile('./views/ajax/editor.pug', { library }), card: pug.renderFile('./views/ajax/library.pug', { library }) });
			res.render('ajax/editor', { library });
		});
		app.get('/api/v2/fragments/:type/:id', async (req, res) => {
			if (req.params.type === 'invitation') {
				Support.assert(Support.admin(req.ctx), 'Admin required', 403);
				const invitation = await Ticket.findOne({ _id: Support.id(req.params.id), account: req.ctx.account, kind: 'invite', expires: { $gt: new Date() } }).select('_id email').lean();
				Support.assert(invitation, 'Invitation missing', 404);
				return res.render('ajax/invitation', { invitation });
			}
			if (req.params.type === 'device') {
				const device = await Device.findOne({ _id: Support.id(req.params.id), account: req.ctx.account, user: req.ctx.user, revoked: false }).lean();
				Support.assert(device, 'Device missing', 404);
				return res.render('ajax/device', { device });
			}
			if (req.params.type === 'conflict') {
				const conflict = await Conflict.findOne({ _id: Support.id(req.params.id), account: req.ctx.account, resolved: false }).lean();
				Support.assert(conflict, 'Conflict missing', 404);
				const library = await Libraries.get(req.ctx, String(conflict.library), null, true);
				Support.assert(Support.access(req.ctx, library).edit, 'Conflict not found', 404);
				return res.render('ajax/conflict', { conflict });
			}
			if (req.params.type === 'library') return res.render('ajax/library', { library: Libraries.view(req.ctx, await Libraries.get(req.ctx, req.params.id)) });
			Support.assert(req.params.type === 'group' || req.params.type === 'member', 'Unknown fragment', 404);
			const team = await Team.list(req.ctx);
			const record = team[req.params.type === 'group' ? 'groups' : 'members'].find(item => String(item._id) === req.params.id);
			Support.assert(record, 'Record missing', 404);
			res.render('ajax/' + req.params.type, { [req.params.type]: record, ctx: req.ctx });
		});
		app.use((error, req, res, next) => {
			if (res.headersSent) return next(error);
			const status = error.status || (error.code === 11000 ? 409 : 0) || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : 500);
			if (status === 500) console.error(error);
			res.status(status).json({ error: status === 500 ? 'Request failed; please retry' : (error.code === 11000 ? 'Abbreviation or name already exists' : error.message), ...(typeof error.code === 'string' && error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}), ...(error.settings ? { settings: error.settings, html: pug.renderFile('./views/ajax/white-label.pug', { whiteLabelSettings: error.settings }) } : {}) });
		});
		const server = app.listen(Number(process.env.PORT || 3040), '0.0.0.0');
		server.on('close', () => sessionStore.close());
		return server;
	}
	static requestOrigin(req) {
		const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
		const host = String(req.headers['x-forwarded-host'] || req.headers.host || new URL(Auth.origin).host).split(',')[0].trim();
		return `${protocol}://${host}`;
	}
	static whiteLabelResult(res, settings) { res.json({ settings, html: pug.renderFile('./views/ajax/white-label.pug', { whiteLabelSettings: settings }), brand_html: pug.renderFile('./views/ajax/brand.pug', { brandUrl: settings.logo_url }) }); }
	static presentation(library) {
		return { library, html: pug.renderFile('./views/ajax/library.pug', { library }), fragments: library.snippets.map(snippet => ({ id: snippet.id, revision: snippet.revision, html: pug.renderFile('./views/ajax/snippet.pug', { snippet, library }) })) };
	}
	static result(res, ctx, result) {
		if (result.libraries) return res.json({ ...result, updates: result.libraries.map(Server.presentation) });
		res.json(result.library ? { ...result, ...Server.presentation(result.library) } : result);
	}
}
if (process.env.NODE_ENV !== 'test') await Server.start();
