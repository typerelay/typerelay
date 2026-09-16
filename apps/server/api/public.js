import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import pug from 'pug';
import Ajv from 'ajv/dist/2020.js';
import { ApiSchema } from './openapi.js';
import { Auth } from '../services/auth.js';
import { Support, Yaml } from '../services/support.js';
import { Libraries } from '../services/libraries.js';
import { Team } from '../services/team.js';
import { Integration, IntegrationToken, ApiAudit, Member, Account, Device, Conflict, Operation } from '../model/index.js';
import { operations } from './catalog.js';
import { Billing } from '../services/billing.js';
import { ApiRateLimit } from '../rate_limit.js';
import { Assets } from '../services/assets.js';
import { Bundles } from '../services/bundles.js';

export class PublicApi {
	static clean(value) {
		if (value == null || typeof value !== 'object') return value;
		if (value instanceof Date) return value.toISOString();
		if (value._bsontype === 'ObjectId') return String(value);
		if (Array.isArray(value)) return value.map(item => PublicApi.clean(item));
		const result = {};
		for (const [key, item] of Object.entries(value)) {
			if (['__v', 'records', 'replace', 'purge_readers', 'hash', 'refresh', 'api_scope'].includes(key) || (key === 'snippets' && value.creator)) continue;
			if (key === '_id') { if (!value.id) result.id = String(item); } else result[key] = PublicApi.clean(item);
		}
		return result;
	}
	static page(rows, query) {
		const limit = Number(query.limit || 50);
		Support.assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Limit must be 1–100');
		const sorted = rows.map(PublicApi.clean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
		const rest = sorted.filter(row => !query.cursor || String(row.id) > String(query.cursor));
		return { items: rest.slice(0, limit), next_cursor: rest.length > limit ? String(rest[limit - 1].id) : null };
	}
	static async mount(app, authLimit) {
		const validators = new Map(operations.filter(operation => operation.method !== 'get').map(operation => [operation.id, new Ajv({ strict: false }).compile(ApiSchema.body(operation))]));
		app.use('/api/v3', (req, res, next) => {
			const origins = [Auth.origin, 'http://localhost:5173', ...(process.env.API_ALLOWED_ORIGINS || '').split(',')];
			if (req.headers.origin && origins.includes(req.headers.origin)) { res.set('Access-Control-Allow-Origin', req.headers.origin); res.vary('Origin'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Operation-Id'); res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS'); }
			if (req.method === 'OPTIONS') return res.sendStatus(204);
			next();
		});
		app.get('/.well-known/oauth-authorization-server', (req, res) => res.json({ issuer: Auth.origin, authorization_endpoint: Auth.origin + '/integrations/authorize', token_endpoint: Auth.origin + '/integrations/token', registration_endpoint: Auth.origin + '/integrations/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: Auth.scopes }));
		app.get('/.well-known/oauth-protected-resource/api/v3', (req, res) => res.json({ resource: Auth.apiResource(), authorization_servers: [Auth.origin], scopes_supported: Auth.scopes, bearer_methods_supported: ['header'] }));
		app.post('/integrations/register', authLimit, async (req, res) => res.status(201).json(await Auth.registerIntegration(req.body)));
		app.post('/integrations/token', authLimit, async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await Auth.exchangeIntegration(req.body)); });
		app.get('/integrations/authorize', async (req, res) => {
			const { client, scopes } = await Auth.integrationRequest(req.query);
			if (!req.session.user) { req.session.return_to = req.originalUrl; return res.render('login', { returnTo: req.originalUrl }); }
			res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy') || '').replace("form-action 'self'", "form-action 'self' " + new URL(req.query.redirect_uri).origin));
			const members = await Member.find({ user: req.session.user }).lean();
			const accounts = (await Account.find({ _id: { $in: members.map(member => member.account) } }).lean()).filter(account => (!req.boundAccount || String(account._id) === req.boundAccount) && Billing.entitlements(account).capabilities.api);
			Support.assert(accounts.length, 'API and MCP access require Pro or Team', 403);
			res.render('integration-authorize', { client, scopes, request: req.query, accounts });
		});
		app.post('/integrations/authorize', async (req, res) => { Support.assert(req.session.user, 'Sign in required', 401); res.redirect(await Auth.approveIntegration(req.session.user, req.body)); });
		app.post('/integrations/delegate', authLimit, async (req, res) => {
			const expected = Buffer.from(process.env.JWT_SECRET || 'change-me');
			const supplied = Buffer.from(String(req.headers['x-mcp-secret'] || ''));
			Support.assert(expected.length === supplied.length && timingSafeEqual(expected, supplied), 'Invalid MCP client', 401);
			const ctx = await Auth.integration(req.headers.authorization, Auth.mcpResource());
			if (ctx.grant.kind === 'pat') return res.json({ access_token: req.headers.authorization.split(' ')[1], expires_in: 60 });
			const token = Support.token();
			await IntegrationToken.create({ hash: Support.hash(token), grant: ctx.credential, resource: Auth.apiResource(), expires: new Date(Date.now() + 60000) });
			res.set('Cache-Control', 'no-store').json({ access_token: token, expires_in: 60 });
		});
		app.use('/api/v3', ...ApiRateLimit.createApiLimiters(), async (req, res, next) => {
			res.set('Cache-Control', 'no-store');
			try { req.ctx = await Auth.integration(req.headers.authorization); } catch (error) { if (error.status === 401) res.set('WWW-Authenticate', 'Bearer resource_metadata="' + Auth.origin + '/.well-known/oauth-protected-resource/api/v3"'); throw error; }
			if (req.boundAccount) Support.assert(req.ctx.account === req.boundAccount, 'Custom domain account mismatch', 403);
			next();
		});
		app.post('/api/v3/assets', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: '5mb' }), async (req, res) => { Auth.requireScope(req.ctx, 'content:write'); res.json(await Assets.put(req.ctx, req.body)); });
		app.post('/api/v3/assets/presence', async (req, res) => { Auth.requireScope(req.ctx, 'content:read'); res.json(await Assets.presence(req.ctx, req.body.ids)); });
		app.get('/api/v3/assets/:id', async (req, res) => { Auth.requireScope(req.ctx, 'content:read'); const asset = await Assets.get(req.ctx, req.params.id, true); res.set({ 'Content-Type': asset.mime_type, 'Content-Length': String(asset.size), ETag: `"${asset.id}"`, 'Cache-Control': 'private, max-age=31536000, immutable' }).send(asset.data); });
		app.post('/api/v3/assets/remote', async (req, res) => { Auth.requireScope(req.ctx, 'content:write'); res.json(await Assets.remote(req.ctx, req.body.url)); });
		app.post('/api/v3/assets/:id/refresh', async (req, res) => { Auth.requireScope(req.ctx, 'content:write'); const asset = await Assets.get(req.ctx, req.params.id); Support.assert(asset.source_urls?.length, 'Asset has no remote source', 409); res.json(await Assets.remote(req.ctx, asset.source_urls.at(-1))); });
		app.get('/api/v3/libraries/:id/export-bundle', async (req, res) => { Auth.requireScope(req.ctx, 'content:read'); const bundle = await Bundles.export(req.ctx, req.params.id); res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${bundle.name}"`, 'Content-Length': String(bundle.bytes.length) }).send(bundle.bytes); });
		app.post('/api/v3/imports/bundle', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '16mb' }), async (req, res) => { Auth.requireScope(req.ctx, 'content:write'); const operation = String(req.headers['x-operation-id'] || ''); const bundle = await Bundles.import(req.ctx, req.body); const result = await Libraries.mutate(req.ctx, operation, { bundle: Support.hash(req.body) }, async (ctx, session) => ({ library: await Libraries.create(ctx, bundle, session), api_scope: 'content:write' })); res.json(PublicApi.clean(result)); });
		for (const operation of operations) app[operation.method]('/api/v3' + operation.path, async (req, res) => {
			res.on('finish', () => ApiAudit.create({ account: req.ctx.account, user: req.ctx.user, credential: req.ctx.credential, operation: operation.id, status: res.statusCode, expires: new Date(Date.now() + 90 * 86400000) }).catch(() => console.error('API audit write failed')));
			Auth.requireScope(req.ctx, operation.scope);
			if (operation.scope.startsWith('team:')) Billing.assertTeam(req.ctx);
			if (operation.scope === 'sharing:write') Billing.assertTeam(req.ctx, 'sharing');
			const validate = validators.get(operation.id);
			Support.assert(!validate || validate(req.body), 'Invalid request: ' + (validate?.errors?.map(error => error.instancePath + " " + error.message).join('; ') || 'body required'));
			const result = operation.mutation ? await Libraries.mutate(req.ctx, req.body.operation_id, { operation: operation.id, params: req.params, body: req.body }, async (ctx, session) => {
				// Recheck grant revocation/scopes inside the same write transaction.
				const grant = await Integration.findOne({ _id: req.ctx.credential, revoked: false, expires: { $gt: new Date() } }).session(session).lean();
				Support.assert(grant?.scopes.includes(operation.scope), 'Integration revoked or scope removed', 403);
				return { ...await PublicApi.run(operation.id, ctx, req.params, req.body, req.query, session), api_scope: operation.scope };
			}) : await PublicApi.run(operation.id, req.ctx, req.params, req.body, req.query);
			res.json(PublicApi.clean(result));
		});
	}
	static mountSettings(app) {
		app.use('/api/v2/access-tokens', (req, res, next) => { Support.assert(req.session.user && !req.headers.authorization && Date.now() - Number(req.session.auth_at || 0) < 900000, 'Sign in again to manage access tokens', 401); next(); });
		app.get('/api/v2/access-tokens', async (req, res) => {
			const grants = await Integration.find({ user: req.ctx.user, account: req.ctx.account, revoked: false }).sort({ createdAt: 1 }).lean();
			res.json(grants.map(grant => ({ id: String(grant._id), html: pug.renderFile('./views/ajax/access-token.pug', { grant }) })));
		});
		app.post('/api/v2/access-tokens', async (req, res) => { const { token, grant } = await Auth.createIntegration(req.ctx, req.body); res.set('Cache-Control', 'no-store').json({ token, id: String(grant._id), html: pug.renderFile('./views/ajax/access-token.pug', { grant }) }); });
		app.delete('/api/v2/access-tokens/:id', async (req, res) => { await Integration.updateOne({ _id: Support.id(req.params.id), user: req.ctx.user, account: req.ctx.account }, { $set: { revoked: true } }); res.json({ revoked: req.params.id }); });
	}
	static async run(operation, ctx, params, body, query, session) {
		const id = params.id;
		switch (operation) {
			case 'get_identity': return { user: ctx.user, account: ctx.account, scopes: ctx.scopes };
			case 'list_libraries': return PublicApi.page(await Libraries.list(ctx), query);
			case 'get_library': return Libraries.view(ctx, await Libraries.get(ctx, id));
			case 'create_library': return { library: await Libraries.create(ctx, body, session) };
			case 'update_library': return Libraries.settings(ctx, id, body, session);
			case 'list_snippets': return PublicApi.page((await Libraries.get(ctx, id)).snippets, query);
			case 'get_snippet': { const snippet = (await Libraries.get(ctx, id)).snippets.find(item => item.id === params.snippet); Support.assert(snippet, 'Snippet not found', 404); return snippet; }
			case 'create_snippet':
			case 'update_snippet': {
				Support.assert(Number.isInteger(body.base_revision), 'Library base_revision required');
				const snippet = operation === 'create_snippet' ? body.id : params.snippet;
				Support.assert(operation === 'create_snippet' || Number.isInteger(body.snippet_revision), 'snippet_revision required');
				return Libraries.upload(ctx, id, { base_revision: body.base_revision, changes: [{ id: snippet, base_revision: operation === 'create_snippet' ? null : body.snippet_revision, base: body.base, value: body.value }] }, session);
			}
			case 'batch_snippets': return Libraries.batch(ctx, body, session);
			case 'search_snippets': {
				const text = Support.text(query.q, 200).toLowerCase();
				const items = (await Libraries.list(ctx)).flatMap(library => library.snippets.filter(snippet => [snippet.trigger, snippet.title, snippet.content.text].some(value => value?.toLowerCase().includes(text))).map(snippet => ({ ...snippet, library_name: library.name })));
				return PublicApi.page(items, query);
			}
			case 'get_asset_metadata': return Assets.metadata(await Assets.get(ctx, id));
			case 'export_library': return Yaml.export((await Libraries.get(ctx, id)).snippets.map(Libraries.exportEntry));
			case 'preview_import': return Libraries.previewImport(params.format, body);
			case 'commit_import': return Libraries.commitImport(ctx, params.format, body, session);
			case 'list_trash': return PublicApi.page(await Libraries.trash(ctx), query);
			case 'change_trash': Support.assert(['trash', 'restore'].includes(body.action), 'Use the purge endpoint for permanent deletion'); return Libraries.trashAction(ctx, body.target, body.action, session);
			case 'purge_item': return Libraries.trashAction(ctx, body.target, 'purge', session);
			case 'empty_trash': return Libraries.empty(ctx, body.targets, session);
			case 'list_conflicts': {
				const libraries = (await Libraries.list(ctx)).filter(library => library.permissions.edit);
				return PublicApi.page(await Conflict.find({ account: ctx.account, library: { $in: libraries.map(library => library._id) }, resolved: false }).lean(), query);
			}
			case 'resolve_conflict': return Libraries.resolve(ctx, id, body, session);
			case 'get_operation': { const prior = await Operation.findOne({ account: ctx.account, user: ctx.user, operation: id }).lean(); if (prior) Auth.requireScope(ctx, prior.result.api_scope || 'internal:receipt'); return prior ? { found: true, ...await Libraries.receipt(ctx, prior.result) } : { found: false }; }
			case 'get_team': return Team.list(ctx);
			case 'create_group': return Team.group(ctx, null, body, session);
			case 'update_group': return Team.group(ctx, id, body, session);
			case 'update_member': return Team.member(ctx, id, body, session);
			case 'list_devices': return PublicApi.page(await Device.find({ account: ctx.account, user: ctx.user, revoked: false }).select('_id name createdAt').lean(), query);
			case 'revoke_device': await Device.updateOne({ _id: Support.id(id), account: ctx.account, user: ctx.user }, { $set: { revoked: true } }, { session }); return { revoked: id };
			default: Support.assert(false, 'Unknown operation', 404);
		}
	}
}
