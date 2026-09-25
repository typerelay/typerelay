// Account membership and PKCE patterns adapted from Streamient (AGPL-3.0).
import nodemailer from 'nodemailer';
import { AdminSettings } from './admin_settings.js';
import { AccountAccess } from './account_access.js';
import { scopes } from '../api/catalog.js';
import { createHash } from 'node:crypto';
import { mongoose, User, Account, Member, Ticket, Device, Integration, IntegrationToken, OAuthClient } from '../model/index.js';
import { Support } from './support.js';
import { Billing } from './billing.js';
import { SignupNotifications } from './signup_notifications.js';
import { StarterContent } from './starter_content.js';
import bcrypt from 'bcryptjs';

export class Auth {
	static origin = process.env.APP_URL || 'http://localhost:3040';
	static smtpIndex = 0;
	static smtpTransports = new Map();
	static mail = { sendMail: message => Auth.sendMail(message) };
	static smtpServers(env = process.env) {
		const configured = String(env.SMTP_SERVERS || '').trim();
		if (!configured) return [{ name: 'mail', host: 'mail', port: 1025, secure: false, user: '', pass: '', from: env.SMTP_FROM || 'TypeRelay <noreply@localhost>' }];
		let servers;
		try { servers = JSON.parse(configured); } catch { Support.assert(false, 'SMTP_SERVERS must be valid JSON', 500); }
		Support.assert(Array.isArray(servers) && servers.length, 'SMTP_SERVERS must be a non-empty JSON array', 500);
		return servers.map((server, index) => {
			Support.assert(server && typeof server === 'object' && server.host, `SMTP_SERVERS[${index}].host is required`, 500);
			const port = Number(server.port || 587);
			Support.assert(Number.isInteger(port) && port > 0 && port <= 65535, `SMTP_SERVERS[${index}].port is invalid`, 500);
			return { name: server.name || `smtp-${index + 1}`, host: String(server.host), port, secure: server.secure === undefined ? port === 465 : Boolean(server.secure), user: String(server.user || ''), pass: String(server.pass || ''), from: String(server.from || env.SMTP_FROM || 'TypeRelay <noreply@localhost>') };
		});
	}
	static nextSmtpServer(servers) {
		const server = servers[Auth.smtpIndex % servers.length];
		Auth.smtpIndex = (Auth.smtpIndex + 1) % servers.length;
		return server;
	}
	static async sendMail(message) {
		const servers = Auth.smtpServers();
		const server = Auth.nextSmtpServer(servers);
		const key = `${server.name}:${server.host}:${server.port}:${server.user}`;
		if (!Auth.smtpTransports.has(key)) Auth.smtpTransports.set(key, nodemailer.createTransport({ host: server.host, port: server.port, secure: server.secure, auth: server.user ? { user: server.user, pass: server.pass } : undefined }));
		return Auth.smtpTransports.get(key).sendMail({ ...message, from: server.from });
	}
	static async login(email, name, options = {}) {
		email = Support.text(email, 254).toLowerCase();
		Support.assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email');
		const token = Support.token();
		const origin = options.origin || Auth.origin;
		if (options.account) { await AccountAccess.acquire(options.account); AccountAccess.assert(await Account.findById(options.account).lean()); }
		const continuation = options.return_to ? Auth.continuation(options.return_to) : undefined;
		const data = { ...(name ? { name: Support.text(name) } : {}), ...(options.account ? { account: String(options.account) } : {}), ...(continuation ? { return_to: continuation } : {}), origin };
		await mongoose.connection.transaction(async session => {
			if (options.account) await AccountAccess.fence(options.account, session);
			await User.updateOne({ email }, { $inc: { activity_sequence: 1 } }, { session });
			await Ticket.create([{ hash: Support.hash(token), kind: 'login', email, ...(options.account ? { account: options.account } : {}), data, expires: new Date(Date.now() + 900000) }], { session });
		});
		await AdminSettings.send(name ? 'signup' : 'login', email, { url: origin + '/auth/callback?token=' + token, name: data.name });
	}
	static continuation(value) {
		Support.assert(typeof value === 'string' && value.startsWith('/oauth/authorize?'), 'Invalid sign-in continuation');
		const url = new URL(value, Auth.origin);
		Support.assert(url.origin === new URL(Auth.origin).origin && url.pathname === '/oauth/authorize', 'Invalid sign-in continuation');
		Auth.redirect(url.searchParams.get('redirect_uri'), url.searchParams.get('client_id'));
		return url.pathname + url.search;
	}
	static async consume(token, details = false) {
		let user;
		let account;
		let signupNotification;
		let returnTo;
		await mongoose.connection.transaction(async session => {
			const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(Support.text(token, 256)), kind: 'login', expires: { $gt: new Date() } }, { session }).lean();
			Support.assert(ticket, 'Link expired or already used', 401);
			returnTo = ticket.data?.return_to;
			user = await User.findOne({ email: ticket.email }).session(session).lean();
			if (ticket.data?.account) AccountAccess.assert(await Account.findById(ticket.data.account).session(session).lean());
			if (ticket.data?.account) Support.assert(user && await Member.exists({ account: ticket.data.account, user: user._id }).session(session), 'Account access denied', 403);
			if (!user) {
				[user] = await User.create([{ email: ticket.email, name: ticket.data?.name || ticket.email.split('@')[0] }], { session });
				[account] = await Account.create([{ name: user.name + '’s team' }], { session });
				await Member.create([{ account: account._id, user: user._id, role: 'owner' }], { session });
				await StarterContent.create(account, user, session);
				if (Billing.hosted()) signupNotification = await SignupNotifications.create(user, account, session);
			}
		});
		if (account) await Billing.initializeAccount(account, user).catch(error => console.error(`Stripe setup failed for new TypeRelay account: ${error.message}`));
		if (signupNotification) { const sendMail = Auth.mail.sendMail; void SignupNotifications.deliver(signupNotification._id, message => sendMail(message)).catch(error => console.error(`Type Relay signup notification deferred: ${error.message}`)); }
		const result = { user: String(user._id), return_to: returnTo ? Auth.continuation(returnTo) : undefined };
		return details ? result : result.user;
	}
	static redirect(uri, client = 'typerelay-desktop') {
		let url;
		try { url = new URL(uri); } catch { Support.assert(false, client === 'typerelay-mobile' ? 'Invalid mobile callback URL' : 'Invalid desktop callback URL'); }
		const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/callback';
		const mobile = client === 'typerelay-mobile';
		const browser = client === 'typerelay-browser';
		Support.assert(['typerelay-desktop', 'typerelay-mobile', 'typerelay-browser'].includes(client), 'Invalid client');
		if (browser) { Support.assert(url.href === new URL('/oauth/browser-callback', Auth.origin).href, 'Invalid browser callback URL'); return url.href; }
		const preview = mobile && process.env.NODE_ENV === 'development' && process.env.TYPERELAY_MOBILE_PREVIEW_URL && url.href === process.env.TYPERELAY_MOBILE_PREVIEW_URL + '/oauth/callback';
		const app = url.protocol === (mobile ? 'com.typerelay.mobile:' : 'typerelay:') && url.hostname === 'oauth' && url.pathname === '/callback' && !url.port;
		Support.assert(((!mobile && loopback) || app || preview) && !url.username && !url.password && !url.search && !url.hash, mobile ? 'Invalid mobile callback URL' : 'Invalid desktop callback URL');
		return url.href;
	}
	static async authorize(user, body) {
		const ctx = await Support.context(user, body.account);
		await Billing.assertDeviceEnrollment(ctx, null, body.client_id);
		const redirect = Auth.redirect(body.redirect_uri, body.client_id);
		Support.assert(['typerelay-desktop', 'typerelay-mobile', 'typerelay-browser'].includes(body.client_id) && body.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(body.code_challenge), 'Invalid PKCE request');
		Support.assert(typeof body.state === 'string' && body.state.length >= 20 && body.state.length <= 256, 'Invalid state');
		const code = Support.token();
		Support.assert((body.client_id !== 'typerelay-mobile' && body.client_id !== 'typerelay-browser' && body.client_type === undefined) || (body.client_id === 'typerelay-mobile' ? ['mobile'] : body.client_id === 'typerelay-browser' ? ['browser'] : ['desktop', 'cli']).includes(body.client_type), 'Invalid client type');
		Support.assert((body.client_id !== 'typerelay-mobile' && body.client_id !== 'typerelay-browser' && body.os === undefined) || (body.client_id === 'typerelay-mobile' ? (redirect.startsWith('https:') || redirect.startsWith('http:') ? ['web'] : ['ios', 'android']) : body.client_id === 'typerelay-browser' ? ['web'] : ['macos', 'windows', 'linux']).includes(body.os), 'Invalid operating system');
		await Ticket.create({ hash: Support.hash(code), kind: 'oauth', account: ctx.account, data: { user, client: body.client_id, redirect, challenge: body.code_challenge, name: Support.text(body.device_name || (body.client_id === 'typerelay-mobile' ? 'TypeRelay mobile' : 'Desktop')), client_type: body.client_type, os: body.os }, expires: new Date(Date.now() + 300000) });
		const url = new URL(redirect);
		url.searchParams.set('code', code);
		url.searchParams.set('state', body.state);
		return url.href;
	}
	static async exchange(body) {
		const access = Support.token();
		const refresh = Support.token();
		let device;
		await mongoose.connection.transaction(async session => {
			if (body.grant_type === 'authorization_code') {
				Support.assert(['typerelay-desktop', 'typerelay-mobile', 'typerelay-browser'].includes(body.client_id) && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier), 'Invalid client or verifier');
				const ticket = await Ticket.findOne({ hash: Support.hash(Support.text(body.code, 256)), kind: 'oauth', expires: { $gt: new Date() } }).session(session).lean();
				Support.assert(ticket && (ticket.data.client || 'typerelay-desktop') === body.client_id && ticket.data.redirect === Auth.redirect(body.redirect_uri, body.client_id) && ticket.data.challenge === createHash('sha256').update(body.code_verifier).digest('base64url'), 'Invalid authorization code', 401);
				const ctx = await Support.context(ticket.data.user, String(ticket.account), session);
				await Billing.assertDeviceEnrollment(ctx, session, body.client_id);
				await Ticket.deleteOne({ _id: ticket._id }, { session });
				[device] = await Device.create([{ account: ticket.account, user: ticket.data.user, name: ticket.data.name, client_type: ticket.data.client_type, os: ticket.data.os, oauth_client: ticket.data.client || 'typerelay-desktop' }], { session });
			} else {
				Support.assert(body.grant_type === 'refresh_token', 'Unsupported grant');
				device = await Device.findOne({ refresh: Support.hash(Support.text(body.refresh_token, 256)), refresh_expires: { $gt: new Date() }, revoked: false }).session(session).lean();
				Support.assert(device, 'Invalid refresh token', 401);
				Support.assert(['typerelay-mobile', 'typerelay-browser'].includes(device.oauth_client) ? body.client_id === device.oauth_client : (!body.client_id || body.client_id === (device.oauth_client || 'typerelay-desktop')), 'Invalid refresh client', 401);
				const ctx = await Support.context(String(device.user), String(device.account), session);
				await Billing.assertDevice(ctx, device, session);
			}
			await Device.updateOne({ _id: device._id }, { $set: { access: Support.hash(access), access_expires: new Date(Date.now() + 900000), refresh: Support.hash(refresh), refresh_expires: new Date(Date.now() + 90 * 86400000) }, $max: { last_active: new Date() } }, { session });
		});
		return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, account: String(device.account), device: String(device._id) };
	}
	static async bearer(token) {
		const device = await Device.findOne({ access: Support.hash(token), access_expires: { $gt: new Date() }, revoked: false }).lean();
		Support.assert(device, 'Device authentication expired or revoked', 401);
		const ctx = await Support.context(String(device.user), String(device.account));
		await Billing.assertDevice(ctx, device);
		await Device.updateOne({ _id: device._id, revoked: false }, { $max: { last_active: new Date() } }, { timestamps: false });
		return { ...ctx, device: String(device._id) };
	}
	static scopes = scopes;
	static apiResource() { return Auth.origin + '/api/v3'; }
	static mcpResource() { return (process.env.MCP_BASE_URL || 'http://localhost:3041').replace(/\/$/, '') + '/mcp'; }
	static mcpMetadata() { const resource = new URL(Auth.mcpResource()); return resource.origin + '/.well-known/oauth-protected-resource' + resource.pathname; }
	static oauthConfig() { return { issuer: Auth.origin, authorization_endpoint: Auth.origin + '/integrations/authorize', token_endpoint: Auth.origin + '/integrations/token', registration_endpoint: Auth.origin + '/integrations/register', authorization_server_metadata_url: Auth.origin + '/.well-known/oauth-authorization-server', resource_metadata_url: Auth.mcpMetadata(), api_resource: Auth.apiResource(), mcp_endpoint: Auth.mcpResource(), client_registration: { dynamic_registration_supported: true, pre_registration_supported: true } }; }
	static integrationScopes(scopes) {
		Support.assert(Array.isArray(scopes) && scopes.length && scopes.every(scope => Auth.scopes.includes(scope)), 'Select valid scopes');
		return [...new Set(scopes)].sort();
	}
	static async createIntegration(ctx, body) {
		Billing.assertApi(ctx);
		const token = 'tr_pat_' + Support.token();
		const grant = await AccountAccess.write(ctx.account, async session => (await Integration.create([{ account: ctx.account, user: ctx.user, name: Support.text(body.name), kind: 'pat', scopes: Auth.scopes, hash: Support.hash(token), expires: null }], { session }))[0]);
		return { token, grant: grant.toObject() };
	}
	static async integration(header, resource = Auth.apiResource()) {
		Support.assert(typeof header === 'string' && /^(Token|Bearer) [^ ]+$/.test(header), 'Integration authentication required', 401);
		const token = header.split(' ')[1];
		let grant;
		if (token.startsWith('tr_pat_')) grant = await Integration.findOne({ hash: Support.hash(token), kind: 'pat', revoked: false, $or: [{ expires: { $gt: new Date() } }, { expires: { $type: 'null' } }] }).lean();
		else {
			const access = await IntegrationToken.findOne({ hash: Support.hash(token), resource, expires: { $gt: new Date() } }).lean();
			if (access) grant = await Integration.findOne({ _id: access.grant, kind: 'oauth', revoked: false, expires: { $gt: new Date() } }).lean();
		}
		Support.assert(grant, 'Integration token expired, revoked or invalid for this resource', 401);
		const ctx = await Support.context(String(grant.user), String(grant.account));
		Billing.assertApi(ctx);
		await Integration.updateOne({ _id: grant._id }, { $set: { last_used: new Date() } });
		return { ...ctx, credential: String(grant._id), scopes: grant.scopes, grant };
	}
	static requireScope(ctx, scope) { Support.assert(ctx.scopes.includes(scope), 'Required scope: ' + scope, 403); }
	static integrationRedirects(body) {
		Support.assert(Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0 && body.redirect_uris.length <= 10, 'OAuth clients require 1–10 redirect URIs');
		const redirects = body.redirect_uris.map(uri => {
			let url; try { url = new URL(uri); } catch { Support.assert(false, 'Invalid redirect URI'); }
			Support.assert(!url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))), 'Use HTTPS or an IP loopback redirect');
			return url.href;
		});
		return [...new Set(redirects)];
	}
	static integrationClient(client) {
		return { id: String(client._id), client_id: client.client_id, client_name: client.name, client_uri: client.client_uri || null, redirect_uris: client.redirects, token_endpoint_auth_method: client.token_endpoint_auth_method || 'none', registration_source: client.registration_source || 'dynamic', created_at: client.createdAt || null };
	}
	static async registerIntegration(body, options = {}) {
		const method = body.token_endpoint_auth_method || 'none';
		Support.assert(options.manual ? ['none', 'client_secret_post'].includes(method) : method === 'none', options.manual ? 'Unsupported token endpoint authentication method' : 'Public PKCE clients require token_endpoint_auth_method none');
		const redirects = Auth.integrationRedirects(body);
		let clientUri = '';
		if (body.client_uri) {
			let url; try { url = new URL(body.client_uri); } catch { Support.assert(false, 'Invalid client website'); }
			Support.assert(!url.username && !url.password && !url.hash && url.protocol === 'https:', 'Client website must use HTTPS');
			clientUri = url.href;
		}
		const secret = method === 'client_secret_post' ? Support.token() : null;
		const client = await OAuthClient.create({ account: options.ctx?.account, created_by: options.ctx?.user, client_id: 'tr_oauth_' + Support.token(), name: Support.text(body.client_name || 'Integration'), client_uri: clientUri || undefined, redirects, registration_source: options.manual ? 'manual' : 'dynamic', token_endpoint_auth_method: method, secret_hash: secret ? await bcrypt.hash(secret, 12) : undefined });
		const serialized = Auth.integrationClient(client);
		if (options.manual) return { ...serialized, ...(secret ? { client_secret: secret } : {}), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
		return { client_id: serialized.client_id, client_name: serialized.client_name, redirect_uris: serialized.redirect_uris, token_endpoint_auth_method: serialized.token_endpoint_auth_method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
	}
	static async createOAuthClient(ctx, body) {
		Billing.assertApi(ctx); Support.assert(Support.admin(ctx), 'Owner or admin access required', 403);
		return Auth.registerIntegration(body, { manual: true, ctx });
	}
	static async authenticateOAuthClient(body) {
		const client = await OAuthClient.findOne({ client_id: body.client_id }).select('+secret_hash').lean();
		Support.assert(client, 'Unregistered client', 401);
		const method = client.token_endpoint_auth_method || 'none';
		if (method === 'client_secret_post') Support.assert(typeof body.client_secret === 'string' && await bcrypt.compare(body.client_secret, client.secret_hash || ''), 'Invalid client secret', 401);
		return client;
	}
	static async integrationRequest(body) {
		const client = await OAuthClient.findOne({ client_id: body.client_id }).lean();
		Support.assert(client && client.redirects.includes(body.redirect_uri), 'Unregistered client or redirect');
		Support.assert(body.response_type === 'code' && body.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(body.code_challenge || ''), 'S256 PKCE required');
		Support.assert(typeof body.state === 'string' && body.state.length >= 20 && body.state.length <= 256, 'Invalid state');
		Support.assert([Auth.apiResource(), Auth.mcpResource()].includes(body.resource), 'Invalid resource');
		const scopes = Auth.integrationScopes(typeof body.scope === 'string' ? body.scope.split(' ') : ['content:read']);
		return { client, scopes };
	}
	static async approveIntegration(user, body) {
		const { client, scopes } = await Auth.integrationRequest(body);
		if (body.decision === 'deny') { const redirect = new URL(body.redirect_uri); redirect.searchParams.set('error', 'access_denied'); redirect.searchParams.set('state', body.state); return redirect.href; }
		const ctx = await Support.context(user, body.account);
		Billing.assertApi(ctx);
		if (client.account) Support.assert(Support.equal(client.account, ctx.account), 'OAuth client is registered for another account', 403);
		const code = Support.token();
		await Ticket.create({ hash: Support.hash(code), kind: 'integration-code', account: ctx.account, expires: new Date(Date.now() + 300000), data: { user, client: client.client_id, name: client.name, scopes, resource: body.resource, redirect: body.redirect_uri, challenge: body.code_challenge } });
		const url = new URL(body.redirect_uri); url.searchParams.set('code', code); url.searchParams.set('state', body.state);
		return url.href;
	}
	static async exchangeIntegration(body) {
		await Auth.authenticateOAuthClient(body);
		const access = Support.token(); const refresh = Support.token();
		let grant;
		// Replayed refresh tokens invalidate the entire grant, including delegated access.
		if (body.grant_type === 'refresh_token') {
			const used = await Ticket.findOne({ kind: 'used-integration-refresh', hash: Support.hash(String(body.refresh_token || '')) }).lean();
			if (used) { await Integration.updateOne({ _id: used.data.grant }, { $set: { revoked: true } }); Support.assert(false, 'Refresh token replay detected', 401); }
		}
		await mongoose.connection.transaction(async session => {
			if (body.grant_type === 'authorization_code') {
				Support.assert(/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || ''), 'Invalid verifier');
				const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(String(body.code || '')), kind: 'integration-code', expires: { $gt: new Date() } }, { session }).lean();
				Support.assert(ticket && ticket.data.client === body.client_id && ticket.data.redirect === body.redirect_uri && ticket.data.resource === body.resource && ticket.data.challenge === createHash('sha256').update(body.code_verifier).digest('base64url'), 'Invalid authorization code, resource or verifier', 401);
				const ctx = await Support.context(ticket.data.user, String(ticket.account), session);
				Billing.assertApi(ctx);
				[grant] = await Integration.create([{ user: ticket.data.user, account: ticket.account, name: ticket.data.name, kind: 'oauth', client: body.client_id, resource: body.resource, scopes: ticket.data.scopes, expires: new Date(Date.now() + 90 * 86400000) }], { session });
			} else {
				Support.assert(body.grant_type === 'refresh_token', 'Unsupported grant');
				grant = await Integration.findOne({ refresh: Support.hash(String(body.refresh_token || '')), client: body.client_id, resource: body.resource, revoked: false, refresh_expires: { $gt: new Date() }, expires: { $gt: new Date() } }).session(session).lean();
				Support.assert(grant, 'Invalid refresh token or resource', 401);
				const ctx = await Support.context(String(grant.user), String(grant.account), session);
				Billing.assertApi(ctx);
				await Ticket.create([{ hash: Support.hash(body.refresh_token), kind: 'used-integration-refresh', data: { grant: grant._id }, expires: grant.expires }], { session });
			}
			await Integration.updateOne({ _id: grant._id }, { $set: { refresh: Support.hash(refresh), refresh_expires: grant.expires } }, { session });
			await IntegrationToken.create([{ hash: Support.hash(access), grant: grant._id, resource: body.resource, expires: new Date(Date.now() + 900000) }], { session });
		});
		return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, scope: grant.scopes.join(' ') };
	}

}
