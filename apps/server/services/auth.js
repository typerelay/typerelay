// Account membership and PKCE patterns adapted from Streamient (AGPL-3.0).
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { mongoose, User, Account, Member, Ticket, Device } from '../model/index.js';
import { Support } from './support.js';

export class Auth {
	static origin = process.env.ORIGIN || 'http://localhost:3040';
	static mail = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'mail', port: 1025 });
	static async login(email, name) {
		email = Support.text(email, 254).toLowerCase();
		Support.assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email');
		const token = Support.token();
		await Ticket.create({ hash: Support.hash(token), kind: 'login', email, data: name ? { name: Support.text(name) } : undefined, expires: new Date(Date.now() + 900000) });
		await Auth.mail.sendMail({ from: 'TypeRelay <login@typerelay.local>', to: email, subject: 'Sign in to TypeRelay', text: Auth.origin + '/auth/callback?token=' + token });
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
}
