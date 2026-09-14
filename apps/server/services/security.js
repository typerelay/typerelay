// Adapted from Streamient auth routes, profile/security views and passkey_service (AGPL-3.0).
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { mongoose, User, Ticket, Passkey } from '../model/index.js';
import { Auth } from './auth.js';
import { Support, Fault } from './support.js';

export class Security {
	static dummy = bcrypt.hashSync(Support.token(), 12);
	static email(value) { const email = Support.text(value, 254).toLowerCase(); Support.assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email address'); return email; }
	static fresh(req) { Support.assert((!req.ctx || (!req.ctx.device && req.ctx.user === req.session.user)) && req.session.user && req.session.auth_at > Date.now() - 15 * 60000, 'Please sign out and sign in again before changing security settings', 401); }
	static async establish(req, id, verifiedFactor = false) {
		const user = await User.findById(id).lean();
		Support.assert(user, 'Sign-in failed', 401);
		const destination = req.session.return_to || '/';
		await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
		req.session.csrf = Support.token();
		req.session.return_to = destination;
		let result;
		if (user.totp_enabled && !verifiedFactor) {
			req.session.pending_factor = { user: String(id), version: user.auth_version || 0, expires: Date.now() + 300000 };
			result = { requires2FA: true, csrf: req.session.csrf, redirect: '/auth/two-factor' };
		} else {
			req.session.user = String(id);
			req.session.auth_version = user.auth_version || 0;
			req.session.auth_at = Date.now();
			delete req.session.return_to;
			result = { redirect: destination, csrf: req.session.csrf };
		}
		// Persist before redirect headers expose the new cookie to a follow-up request.
		await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
		return result;
	}

	static async passwordLogin(req) {
		const email = Security.email(req.body.email);
		Support.assert(typeof req.body.password === 'string' && req.body.password.length <= 256, 'Invalid email or password', 401);
		const user = await User.findOne({ email }).select('+password').lean();
		const matches = await bcrypt.compare(req.body.password, user?.password || Security.dummy);
		Support.assert(user?.password && matches, 'Invalid email or password', 401);
		return Security.establish(req, user._id);
	}
	static async verifyCode(user, code) {
		Support.assert(typeof code === 'string' && /^\d{6}$/.test(code), 'Enter a six-digit authentication code');
		Support.assert(user?.totp_secret && verifySync({ secret: user.totp_secret, token: code }).valid, 'Invalid authentication code', 401);
		const step = Math.floor(Date.now() / 30000);
		const result = await User.updateOne({ _id: user._id, $or: [{ totp_step: { $lt: step } }, { totp_step: { $exists: false } }] }, { $set: { totp_step: step } });
		Support.assert(result.modifiedCount === 1, 'Code already used; wait for the next code', 401);
	}
	static async factor(req) {
		const pending = req.session.pending_factor;
		Support.assert(pending?.expires > Date.now(), 'Sign-in expired; start again', 401);
		const user = await User.findById(pending.user).select('+totp_secret').lean();
		Support.assert(user?.totp_enabled && (user.auth_version || 0) === pending.version, 'Sign-in expired; start again', 401);
		await Security.verifyCode(user, req.body.code);
		return Security.establish(req, user._id, true);
	}
	static async issue(email, kind, data, path, subject) {
		const token = Support.token();
		await Ticket.create({ hash: Support.hash(token), kind, email, data, expires: new Date(Date.now() + 900000) });
		await Auth.mail.sendMail({ from: 'TypeRelay <security@typerelay.local>', to: email, subject, text: Auth.origin + path + '?token=' + token });
	}
	static async profile(req) {
		const name = Support.text(req.body.name);
		const user = await User.findById(req.ctx.user).lean();
		const email = req.body.email === undefined ? user.email : Security.email(req.body.email);
		if (email !== user.email) {
			Security.fresh(req);
			Support.assert(!await User.exists({ email }), 'Email address unavailable', 409);
			await Security.issue(email, 'email-change', { user: String(user._id), old: user.email, version: user.auth_version || 0 }, '/auth/email', 'Confirm your TypeRelay email address');
		}
		await User.updateOne({ _id: user._id }, { $set: { name } });
		return { name, email: user.email, pending_email: email !== user.email ? email : null };
	}
	static async confirmEmail(req) {
		Support.assert(req.session.user, 'Sign in to confirm your email', 401);
		await mongoose.connection.transaction(async session => {
			const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(Support.text(req.body.token, 256)), kind: 'email-change', 'data.user': req.session.user, expires: { $gt: new Date() } }, { session }).lean();
			Support.assert(ticket, 'Email link expired or already used', 400);
			const user = await User.findById(req.session.user).session(session).lean();
			Support.assert(user.email === ticket.data.old && (user.auth_version || 0) === ticket.data.version, 'Email link no longer valid');
			Support.assert(!await User.exists({ email: ticket.email }).session(session), 'Email address unavailable', 409);
			await User.updateOne({ _id: user._id }, { $set: { email: ticket.email } }, { session });
			await Ticket.deleteMany({ email: user.email, kind: { $in: ['login', 'password-reset', 'email-change'] } }, { session });
		});
		return { redirect: '/' };
	}
	static async resetPassword(userId, session) {
		const password = Support.token().slice(0, 22);
		const hash = await bcrypt.hash(password, 12);
		const user = await User.findOneAndUpdate({ _id: userId }, { $set: { password: hash }, $inc: { auth_version: 1 } }, { returnDocument: 'after', session }).lean();
		Support.assert(user, 'Account missing', 401);
		return { password, version: user.auth_version };
	}
	static async forgot(email) {
		email = Security.email(email);
		const user = await User.findOne({ email }).lean();
		if (user) await Security.issue(email, 'password-reset', { user: String(user._id), version: user.auth_version || 0 }, '/auth/reset-password', 'Reset your TypeRelay password');
		return { message: 'If an account exists, a password reset link has been sent.' };
	}
	static async redeemReset(req) {
		let result;
		await mongoose.connection.transaction(async session => {
			const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(Support.text(req.body.token, 256)), kind: 'password-reset', expires: { $gt: new Date() } }, { session }).lean();
			Support.assert(ticket, 'Reset link expired or already used');
			const user = await User.findById(ticket.data.user).session(session).lean();
			Support.assert(user && user.email === ticket.email && (user.auth_version || 0) === ticket.data.version, 'Reset link no longer valid');
			result = await Security.resetPassword(user._id, session);
			await Ticket.deleteMany({ email: user.email, kind: 'login' }, { session });
		});
		return { password: result.password };
	}
	static async passkeyOptions(req, register) {
		const rpID = new URL(Auth.origin).hostname;
		let options;
		if (register) {
			Security.fresh(req);
			const user = await User.findById(req.ctx.user).lean();
			const keys = await Passkey.find({ user: user._id }).lean();
			options = await generateRegistrationOptions({ rpName: 'TypeRelay', rpID, userID: new TextEncoder().encode(String(user._id)), userName: user.email, userDisplayName: user.name, attestationType: 'none', excludeCredentials: keys.map(key => ({ id: key.credential_id, transports: key.transports })), authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, supportedAlgorithmIDs: [-7, -257] });
		} else options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
		const token = Support.token();
		await Ticket.create({ hash: Support.hash(token), kind: register ? 'passkey-register' : 'passkey-login', data: { challenge: options.challenge, user: register ? req.ctx.user : null }, expires: new Date(Date.now() + 300000) });
		req.session.passkey = token;
		return options;
	}
	static passkeyFailure() { throw new Fault(400, 'Passkey response could not be verified. Try again.'); }
	static async passkeyVerify(req, register) {
		if (register) Security.fresh(req);
		Support.assert(req.session.passkey, 'Passkey challenge expired; try again');
		const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(req.session.passkey), kind: register ? 'passkey-register' : 'passkey-login', expires: { $gt: new Date() } }).lean();
		delete req.session.passkey;
		Support.assert(ticket && (!register || ticket.data.user === req.ctx.user), 'Passkey challenge expired; try again');
		const response = req.body.response;
		const expected = { response, expectedChallenge: ticket.data.challenge, expectedOrigin: Auth.origin, expectedRPID: new URL(Auth.origin).hostname, requireUserVerification: true };
		if (register) {
			const verification = await verifyRegistrationResponse(expected).catch(Security.passkeyFailure);
			Support.assert(verification.verified && verification.registrationInfo, 'Passkey registration failed', 401);
			const credential = verification.registrationInfo.credential;
			const key = await Passkey.create({ user: req.ctx.user, credential_id: credential.id, public_key: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, transports: credential.transports || [], name: Support.text(req.body.name || 'Passkey') });
			return { key: { _id: String(key._id), name: key.name } };
		}
		Support.assert(typeof response?.id === 'string', 'Passkey response missing');
		const key = await Passkey.findOne({ credential_id: response.id }).select('+public_key').lean();
		Support.assert(key, 'Passkey not recognized', 401);
		const verification = await verifyAuthenticationResponse({ ...expected, credential: { id: key.credential_id, publicKey: Buffer.from(key.public_key, 'base64url'), counter: key.counter, transports: key.transports } }).catch(Security.passkeyFailure);
		Support.assert(verification.verified, 'Passkey verification failed', 401);
		const updated = await Passkey.updateOne({ _id: key._id, counter: key.counter }, { $set: { counter: verification.authenticationInfo.newCounter } });
		Support.assert(updated.matchedCount === 1, 'Passkey changed; try again', 409);
		return Security.establish(req, key.user, true);
	}
	static mount(app, limit) {
		app.use('/auth', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
		app.get('/login', (req, res) => res.render('login'));
		app.get('/signup', (req, res) => res.render('auth', { kind: 'signup' }));
		app.post('/auth/signup', limit, async (req, res) => { await Auth.login(Security.email(req.body.email), req.body.name); res.json({ message: 'Check your email to finish creating your account.' }); });
		app.post('/auth/password', limit, async (req, res) => res.json(await Security.passwordLogin(req)));
		app.get('/auth/two-factor', (req, res) => res.render('auth', { kind: 'factor' }));
		app.post('/auth/two-factor', limit, async (req, res) => res.json(await Security.factor(req)));
		app.get('/forgot-password', (req, res) => res.render('auth', { kind: 'forgot' }));
		app.post('/auth/forgot-password', limit, async (req, res) => res.json(await Security.forgot(req.body.email)));
		app.get('/auth/reset-password', (req, res) => res.render('auth', { kind: 'reset', token: req.query.token }));
		app.post('/auth/reset-password', limit, async (req, res) => res.json(await Security.redeemReset(req)));
		app.get('/auth/email', (req, res) => {
			if (!req.session.user) { req.session.return_to = req.originalUrl; return res.render('login'); }
			res.render('auth', { kind: 'email', token: req.query.token });
		});
		app.post('/auth/email', limit, async (req, res) => res.json(await Security.confirmEmail(req)));
		app.post('/auth/passkey/options', limit, async (req, res) => res.json(await Security.passkeyOptions(req, false)));
		app.post('/auth/passkey/verify', limit, async (req, res) => res.json(await Security.passkeyVerify(req, false)));
	}
	static mountPrivate(app, limit) {
		app.use('/api/v2/security', limit, (req, res, next) => { if (req.method !== 'GET') Security.fresh(req); res.setHeader('Cache-Control', 'no-store'); next(); });
		app.get('/api/v2/security', async (req, res) => {
			const user = await User.findById(req.ctx.user).lean();
			res.json({ totp_enabled: user.totp_enabled, keys: await Passkey.find({ user: user._id }).select('_id name').lean() });
		});
		app.post('/api/v2/security/password', async (req, res) => {
			const result = await Security.resetPassword(req.ctx.user);
			req.session.auth_version = result.version;
			res.json({ password: result.password });
		});
		app.post('/api/v2/security/totp/setup', async (req, res) => {
			const user = await User.findById(req.ctx.user).lean();
			Support.assert(!user.totp_enabled, 'Two-factor authentication is already enabled');
			const secret = generateSecret();
			req.session.totp_setup = { secret, expires: Date.now() + 300000 };
			const uri = generateURI({ issuer: 'TypeRelay', label: user.email, secret });
			res.json({ secret, qr: await QRCode.toDataURL(uri) });
		});
		app.post('/api/v2/security/totp/confirm', async (req, res) => {
			const pending = req.session.totp_setup;
			Support.assert(pending?.expires > Date.now(), 'Setup expired; start again');
			Support.assert(typeof req.body.code === 'string' && /^\d{6}$/.test(req.body.code) && verifySync({ secret: pending.secret, token: req.body.code }).valid, 'Invalid authentication code');
			const result = await User.updateOne({ _id: req.ctx.user, totp_enabled: { $ne: true } }, { $set: { totp_secret: pending.secret, totp_enabled: true }, $unset: { totp_step: 1 } });
			Support.assert(result.modifiedCount === 1, 'Two-factor authentication is already enabled');
			delete req.session.totp_setup;
			res.json({ enabled: true });
		});
		app.post('/api/v2/security/totp/disable', async (req, res) => {
			const user = await User.findById(req.ctx.user).select('+totp_secret').lean();
			await Security.verifyCode(user, req.body.code);
			await User.updateOne({ _id: user._id }, { $set: { totp_enabled: false }, $unset: { totp_secret: 1, totp_step: 1 } });
			res.json({ enabled: false });
		});
		app.post('/api/v2/security/passkeys/options', async (req, res) => res.json(await Security.passkeyOptions(req, true)));
		app.post('/api/v2/security/passkeys/verify', async (req, res) => res.json(await Security.passkeyVerify(req, true)));
		app.get('/api/v2/security/passkeys/:id', async (req, res) => {
			const key = await Passkey.findOne({ _id: Support.id(req.params.id), user: req.ctx.user }).select('_id name').lean();
			Support.assert(key, 'Passkey not found', 404);
			res.render('ajax/passkey', { key });
		});
		app.delete('/api/v2/security/passkeys/:id', async (req, res) => { await Passkey.deleteOne({ _id: Support.id(req.params.id), user: req.ctx.user }); res.json({ deleted: req.params.id }); });
	}
}
