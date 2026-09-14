// Account membership and PKCE patterns adapted from Streamient (AGPL-3.0).
import nodemailer from 'nodemailer';
import { scopes } from '../api/catalog.js';
import { createHash } from 'node:crypto';
import { mongoose, User, Account, Member, Ticket, Device, Integration, IntegrationToken, OAuthClient } from '../model/index.js';
import { Support } from './support.js';

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
	static async login(email, name) {
		email = Support.text(email, 254).toLowerCase();
		Support.assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email');
		const token = Support.token();
		await Ticket.create({ hash: Support.hash(token), kind: 'login', email, data: name ? { name: Support.text(name) } : undefined, expires: new Date(Date.now() + 900000) });
		await Auth.mail.sendMail({ to: email, subject: 'Sign in to TypeRelay', text: Auth.origin + '/auth/callback?token=' + token });
	}
	static async consume(token) {
		let user;
		await mongoose.connection.transaction(async session => {
			const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(Support.text(token, 256)), kind: 'login', expires: { $gt: new Date() } }, { session }).lean();
			Support.assert(ticket, 'Link expired or already used', 401);
			user = await User.findOne({ email: ticket.email }).session(session).lean();
			if (!user) {
				[user] = await User.create([{ email: ticket.email, name: ticket.data?.name || ticket.email.split('@')[0] }], { session });
				const [account] = await Account.create([{ name: user.name + '’s team' }], { session });
				await Member.create([{ account: account._id, user: user._id, role: 'owner' }], { session });
			}
		});
		return String(user._id);
	}
	static redirect(uri) {
		const url = new URL(uri);
		Support.assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/callback' && !url.username && !url.password && !url.search && !url.hash, 'Desktop redirect must be an IPv4 loopback /callback URL');
		return url.href;
	}
	static async authorize(user, body) {
		const ctx = await Support.context(user, body.account);
		const redirect = Auth.redirect(body.redirect_uri);
		Support.assert(body.client_id === 'typerelay-desktop' && body.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(body.code_challenge), 'Invalid PKCE request');
		Support.assert(typeof body.state === 'string' && body.state.length >= 20 && body.state.length <= 256, 'Invalid state');
		const code = Support.token();
		await Ticket.create({ hash: Support.hash(code), kind: 'oauth', account: ctx.account, data: { user, redirect, challenge: body.code_challenge, name: Support.text(body.device_name || 'Desktop') }, expires: new Date(Date.now() + 300000) });
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
				Support.assert(body.client_id === 'typerelay-desktop' && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier), 'Invalid client or verifier');
				const ticket = await Ticket.findOne({ hash: Support.hash(Support.text(body.code, 256)), kind: 'oauth', expires: { $gt: new Date() } }).session(session).lean();
				Support.assert(ticket && ticket.data.redirect === Auth.redirect(body.redirect_uri) && ticket.data.challenge === createHash('sha256').update(body.code_verifier).digest('base64url'), 'Invalid authorization code', 401);
				await Support.context(ticket.data.user, String(ticket.account), session);
				await Ticket.deleteOne({ _id: ticket._id }, { session });
				[device] = await Device.create([{ account: ticket.account, user: ticket.data.user, name: ticket.data.name }], { session });
			} else {
				Support.assert(body.grant_type === 'refresh_token', 'Unsupported grant');
				device = await Device.findOne({ refresh: Support.hash(Support.text(body.refresh_token, 256)), refresh_expires: { $gt: new Date() }, revoked: false }).session(session).lean();
				Support.assert(device, 'Invalid refresh token', 401);
				await Support.context(String(device.user), String(device.account), session);
			}
			await Device.updateOne({ _id: device._id }, { $set: { access: Support.hash(access), access_expires: new Date(Date.now() + 900000), refresh: Support.hash(refresh), refresh_expires: new Date(Date.now() + 90 * 86400000) } }, { session });
		});
		return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, account: String(device.account), device: String(device._id) };
	}
	static async bearer(token) {
		const device = await Device.findOne({ access: Support.hash(token), access_expires: { $gt: new Date() }, revoked: false }).lean();
		Support.assert(device, 'Device authentication expired or revoked', 401);
		return { ...await Support.context(String(device.user), String(device.account)), device: String(device._id) };
	}
	static scopes = scopes;
	static apiResource() { return Auth.origin + '/api/v3'; }
	static mcpResource() { return (process.env.MCP_BASE_URL || 'http://localhost:3041').replace(/\/$/, '') + '/mcp'; }
	static integrationScopes(scopes) {
		Support.assert(Array.isArray(scopes) && scopes.length && scopes.every(scope => Auth.scopes.includes(scope)), 'Select valid scopes');
		return [...new Set(scopes)].sort();
	}
	static async createIntegration(ctx, body) {
		const days = Number(body.days || 90);
		Support.assert(Number.isInteger(days) && days >= 1 && days <= 365, 'Expiry must be 1–365 days');
		const token = 'tr_pat_' + Support.token();
		const grant = await Integration.create({ account: ctx.account, user: ctx.user, name: Support.text(body.name), kind: 'pat', scopes: Auth.integrationScopes(body.scopes), hash: Support.hash(token), expires: new Date(Date.now() + days * 86400000) });
		return { token, grant: grant.toObject() };
	}
	static async integration(header, resource = Auth.apiResource()) {
		Support.assert(typeof header === 'string' && /^(Token|Bearer) [^ ]+$/.test(header), 'Integration authentication required', 401);
		const token = header.split(' ')[1];
		let grant;
		if (token.startsWith('tr_pat_')) grant = await Integration.findOne({ hash: Support.hash(token), kind: 'pat', revoked: false, expires: { $gt: new Date() } }).lean();
		else {
			const access = await IntegrationToken.findOne({ hash: Support.hash(token), resource, expires: { $gt: new Date() } }).lean();
			if (access) grant = await Integration.findOne({ _id: access.grant, kind: 'oauth', revoked: false, expires: { $gt: new Date() } }).lean();
		}
		Support.assert(grant, 'Integration token expired, revoked or invalid for this resource', 401);
		const ctx = await Support.context(String(grant.user), String(grant.account));
		await Integration.updateOne({ _id: grant._id }, { $set: { last_used: new Date() } });
		return { ...ctx, credential: String(grant._id), scopes: grant.scopes, grant };
	}
	static requireScope(ctx, scope) { Support.assert(ctx.scopes.includes(scope), 'Required scope: ' + scope, 403); }
	static async registerIntegration(body) {
		Support.assert(body.token_endpoint_auth_method === 'none' && Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0 && body.redirect_uris.length <= 10, 'Public PKCE clients require redirect_uris and token_endpoint_auth_method none');
		const redirects = body.redirect_uris.map(uri => {
			let url; try { url = new URL(uri); } catch { Support.assert(false, 'Invalid redirect URI'); }
			Support.assert(!url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))), 'Use HTTPS or an IP loopback redirect');
			return url.href;
		});
		const client = await OAuthClient.create({ client_id: Support.token(), name: Support.text(body.client_name || 'Integration'), redirects });
		return { client_id: client.client_id, client_name: client.name, redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
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
		const code = Support.token();
		await Ticket.create({ hash: Support.hash(code), kind: 'integration-code', account: ctx.account, expires: new Date(Date.now() + 300000), data: { user, client: client.client_id, name: client.name, scopes, resource: body.resource, redirect: body.redirect_uri, challenge: body.code_challenge } });
		const url = new URL(body.redirect_uri); url.searchParams.set('code', code); url.searchParams.set('state', body.state);
		return url.href;
	}
	static async exchangeIntegration(body) {
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
				await Support.context(ticket.data.user, String(ticket.account), session);
				[grant] = await Integration.create([{ user: ticket.data.user, account: ticket.account, name: ticket.data.name, kind: 'oauth', client: body.client_id, resource: body.resource, scopes: ticket.data.scopes, expires: new Date(Date.now() + 90 * 86400000) }], { session });
			} else {
				Support.assert(body.grant_type === 'refresh_token', 'Unsupported grant');
				grant = await Integration.findOne({ refresh: Support.hash(String(body.refresh_token || '')), client: body.client_id, resource: body.resource, revoked: false, refresh_expires: { $gt: new Date() }, expires: { $gt: new Date() } }).session(session).lean();
				Support.assert(grant, 'Invalid refresh token or resource', 401);
				await Support.context(String(grant.user), String(grant.account), session);
				await Ticket.create([{ hash: Support.hash(body.refresh_token), kind: 'used-integration-refresh', data: { grant: grant._id }, expires: grant.expires }], { session });
			}
			await Integration.updateOne({ _id: grant._id }, { $set: { refresh: Support.hash(refresh), refresh_expires: grant.expires } }, { session });
			await IntegrationToken.create([{ hash: Support.hash(access), grant: grant._id, resource: body.resource, expires: new Date(Date.now() + 900000) }], { session });
		});
		return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, scope: grant.scopes.join(' ') };
	}

}
