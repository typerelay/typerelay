import express from 'express';
import pug from 'pug';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { readFileSync, writeFileSync } from 'node:fs';
import { mongoose, User, Account, Member, Device, Conflict, Group, Ticket } from './model/index.js';
import { Auth } from './services/auth.js';
import { Support, Yaml } from './services/support.js';
import { Libraries } from './services/libraries.js';
import { Team } from './services/team.js';

export class Server {
	static async start() {
		await mongoose.connect(process.env.MONGODB_URI);
		await Promise.all(Object.values(mongoose.models).map(model => model.init()));
		const secretPath = process.env.SESSION_SECRET_FILE || '/data/session-secret';
		try { writeFileSync(secretPath, Support.token(), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
		const app = express();
		app.set('view engine', 'pug');
		app.set('views', './views');
		app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'] } } }));
		app.use(express.json({ limit: '2mb' }), express.urlencoded({ extended: false, limit: '32kb' }));
		app.use('/assets', express.static('public'));
		app.use('/vendor/bootstrap', express.static('node_modules/bootstrap/dist'));
		app.use('/vendor/sweetalert2', express.static('node_modules/sweetalert2/dist'));
		const sessionStore = MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'web_sessions' });
		app.use(session({ name: 'typerelay.sid', secret: readFileSync(secretPath, 'utf8'), store: sessionStore, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: Auth.origin.startsWith('https:'), maxAge: 7 * 86400000 } }));
		app.use((req, res, next) => {
			res.locals.csrf = req.session.csrf ||= Support.token();
			if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/oauth/token' && !req.headers.authorization) Support.assert((req.headers['x-csrf-token'] || req.body._csrf) === req.session.csrf, 'Session expired; reload and retry', 403);
			next();
		});
		app.get('/health', (req, res) => res.json({ ok: true }));
		const authLimit = rateLimit({ windowMs: 900000, limit: 30 });
		app.post('/auth/login', authLimit, async (req, res) => { await Auth.login(req.body.email); res.json({ message: 'Check your email for a sign-in link.' }); });
		app.get('/auth/callback', async (req, res) => {
			const user = await Auth.consume(req.query.token);
			const destination = req.session.return_to || '/';
			await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
			req.session.user = user;
			res.redirect(destination);
		});
		app.post('/auth/logout', async (req, res) => { await new Promise(resolve => req.session.destroy(resolve)); res.json({ signed_out: true }); });
		app.post('/oauth/token', authLimit, async (req, res) => res.json(await Auth.exchange(req.body)));
		app.get('/oauth/authorize', async (req, res) => {
			if (!req.session.user) { req.session.return_to = req.originalUrl; return res.render('login', { returnTo: req.originalUrl }); }
			const redirectOrigin = new URL(Auth.redirect(req.query.redirect_uri)).origin;
			res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy')).replace("form-action 'self'", "form-action 'self' " + redirectOrigin));
			const memberships = await Member.find({ user: req.session.user }).lean();
			const accounts = await Account.find({ _id: { $in: memberships.map(member => member.account) } }).lean();
			res.render('authorize', { accounts, request: req.query });
		});
		app.post('/oauth/authorize', async (req, res) => { Support.assert(req.session.user, 'Sign in required', 401); res.redirect(await Auth.authorize(req.session.user, req.body)); });
		app.get('/', async (req, res) => {
			if (!req.session.user) { if (req.query.invite) req.session.return_to = '/?invite=' + encodeURIComponent(req.query.invite); return res.render('login'); }
			const memberships = await Member.find({ user: req.session.user }).lean();
			const accounts = await Account.find({ _id: { $in: memberships.map(member => member.account) } }).lean();
			const account = accounts.find(account => String(account._id) === req.query.account) || accounts[0];
			const ctx = await Support.context(req.session.user, String(account._id));
			res.render('app', { accounts, account, ctx, libraries: await Libraries.list(ctx), team: await Team.list(ctx), profile: await User.findById(ctx.user).lean() });
		});
		app.use('/api/v1', async (req, res, next) => {
			req.ctx = req.headers.authorization ? await Auth.bearer(req.headers.authorization.replace(/^Bearer /, '')) : await Support.context(req.session.user, req.headers['x-account-id']);
			next();
		});
		app.get('/api/v1/library-view/:id', async (req, res) => Server.result(res, req.ctx, { library: Libraries.view(req.ctx, await Libraries.get(req.ctx, req.params.id)) }));
		app.get('/api/v1/libraries', async (req, res) => res.json(await Libraries.list(req.ctx)));
		app.post('/api/v1/import/preview', async (req, res) => res.json(await Yaml.run(req.body.yaml)));
		app.post('/api/v1/libraries', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, async (ctx, session) => ({ library: await Libraries.create(ctx, req.body, session) }))));
		app.patch('/api/v1/libraries/:id', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.settings(ctx, req.params.id, req.body, session))));
		app.post('/api/v1/libraries/:id/snippets', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.upload(ctx, req.params.id, req.body, session))));
		app.get('/api/v1/sync', async (req, res) => res.json(await Libraries.download(req.ctx, Number(req.query.cursor || 0))));
		app.post('/api/v1/conflicts/:id', async (req, res) => Server.result(res, req.ctx, await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Libraries.resolve(ctx, req.params.id, req.body, session))));
		app.get('/api/v1/team', async (req, res) => res.json(await Team.list(req.ctx)));
		app.post('/api/v1/team/invitations', async (req, res) => res.json(await Team.invite(req.ctx, req.body.email)));
		app.delete('/api/v1/team/invitations/:id', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); await Ticket.deleteOne({ _id: Support.id(req.params.id), account: req.ctx.account, kind: 'invite' }); res.json({ deleted: req.params.id }); });
		app.post('/api/v1/team/accept', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.accept(ctx, req.body.token, session))));
		app.patch('/api/v1/team/members/:id', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.member(ctx, req.params.id, req.body, session))));
		app.post('/api/v1/team/groups', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.group(ctx, null, req.body, session))));
		app.patch('/api/v1/team/groups/:id', async (req, res) => res.json(await Libraries.mutate(req.ctx, req.body.operation_id, req.body, (ctx, session) => Team.group(ctx, req.params.id, req.body, session))));
		app.delete('/api/v1/connection', async (req, res) => { Support.assert(req.ctx.device, 'Device authentication required', 401); await Device.updateOne({ _id: req.ctx.device, user: req.ctx.user, account: req.ctx.account }, { $set: { revoked: true } }); res.json({ disconnected: true }); });
		app.get('/api/v1/devices', async (req, res) => res.json(await Device.find({ account: req.ctx.account, user: req.ctx.user, revoked: false }).select('_id name createdAt').lean()));
		app.delete('/api/v1/devices/:id', async (req, res) => { await Device.updateOne({ _id: Support.id(req.params.id), account: req.ctx.account, user: req.ctx.user }, { $set: { revoked: true } }); res.json({ deleted: req.params.id }); });
		app.patch('/api/v1/profile', async (req, res) => { await User.updateOne({ _id: req.ctx.user }, { $set: { name: Support.text(req.body.name) } }); res.json({ name: req.body.name }); });
		app.patch('/api/v1/account', async (req, res) => { Support.assert(Support.admin(req.ctx), 'Admin required', 403); await Account.updateOne({ _id: req.ctx.account }, { $set: { name: Support.text(req.body.name) } }); res.json({ name: req.body.name }); });
		app.get('/api/v1/forms/:kind', async (req, res) => {
			const kind = req.params.kind;
			Support.assert(['library', 'snippet', 'group', 'conflict'].includes(kind), 'Unknown form');
			const library = req.query.library ? Libraries.view(req.ctx, await Libraries.get(req.ctx, req.query.library)) : null;
			const group = req.query.group ? await Group.findOne({ _id: Support.id(req.query.group), account: req.ctx.account }).lean() : null;
			const conflict = req.query.conflict ? await Conflict.findOne({ _id: Support.id(req.query.conflict), account: req.ctx.account, library: library?._id, resolved: false }).lean() : null;
			if (kind === 'conflict') Support.assert(conflict && library.permissions.edit, 'Conflict not found', 404);
			const current = library?.snippets.find(snippet => snippet.id === conflict?.snippet) || null;
			res.render('ajax/form', { kind, library, group, conflict, current, snippet: kind === 'conflict' ? (conflict.local || current) : library?.snippets.find(snippet => snippet.id === req.query.snippet), team: await Team.list(req.ctx) });
		});
		app.get('/api/v1/editor/:id', async (req, res) => res.render('ajax/editor', { library: Libraries.view(req.ctx, await Libraries.get(req.ctx, req.params.id)) }));
		app.get('/api/v1/fragments/:type/:id', async (req, res) => {
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
				const library = await Libraries.get(req.ctx, String(conflict.library));
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
			const status = error.status || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : 500);
			if (status === 500) console.error(error);
			res.status(status).json({ error: status === 500 ? 'Request failed; please retry' : error.message });
		});
		const server = app.listen(Number(process.env.PORT || 3040), '0.0.0.0');
		server.on('close', () => sessionStore.close());
		return server;
	}
	static result(res, ctx, result) {
		if (!result.library) return res.json(result);
		res.render('ajax/library', { library: result.library }, (error, html) => { if (error) return res.status(500).json({ error: 'Rendering failed' }); const fragments = result.library.snippets.map(snippet => ({ id: snippet.id, revision: snippet.revision, html: pug.renderFile('./views/ajax/snippet.pug', { snippet, library: result.library }) }));
				res.json({ ...result, html, fragments }); });
	}
}
if (process.env.NODE_ENV !== 'test') await Server.start();
