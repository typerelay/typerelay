// Adapted from Streamient auth routes, profile/security views and passkey_service (AGPL-3.0).
import bcrypt from 'bcryptjs';
import { avatarStyles } from '../model/avatar_styles.js';
import { AdminSettings } from './admin_settings.js';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { SAML } from '@node-saml/node-saml';
import { X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import pug from 'pug';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { mongoose, User, Ticket, Passkey, Member, Account, SsoLog } from '../model/index.js';
import { Auth } from './auth.js';
import { Support, Fault } from './support.js';
import { Billing } from './billing.js';
import { AccountAccess } from './account_access.js';
import { WhiteLabel } from './white_label.js';

export class Security {
	static dummy = bcrypt.hashSync(Support.token(), 12);
	static signupEnabled() { return process.env.ENABLE_SIGNUP === 'true'; }
	static email(value) { const email = Support.text(value, 254).toLowerCase(); Support.assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email address'); return email; }
	static generatedPassword(length = 32) { return Support.token().slice(0, length); }
	static async password(value = '') {
		Support.assert(typeof value === 'string' && value.length <= 256, 'Invalid password');
		const password = value || Security.generatedPassword(22);
		Support.assert(password.length >= 8, 'Password must be at least 8 characters');
		return { password, hash: await bcrypt.hash(password, 12) };
	}
	static browserSession(req) { Support.assert((!req.ctx || (!req.ctx.device && req.ctx.user === req.session.user)) && req.session.user, 'Sign in to change security settings', 401); Support.assert(!req.session.sso, 'Sign in with password, Magic Link or passkey to change personal security settings', 403); }
	static async establish(req, id, verifiedFactor = false, sso = null) {
		const user = await User.findById(id).lean();
		Support.assert(user && !user.deletion?.requested_at, 'Sign-in unavailable: account deletion requested', 401);
		const destination = req.session.return_to || '/';
		await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
		req.session.csrf = Support.token();
		req.session.return_to = destination;
		let result;
		if (user.totp_enabled && !verifiedFactor) {
			req.session.pending_factor = { user: String(id), version: user.auth_version || 0, expires: Date.now() + 300000, sso };
			result = { requires2FA: true, csrf: req.session.csrf, redirect: '/auth/two-factor' };
		} else {
			await User.updateOne({ _id: id }, { $set: { last_login: new Date() } });
			req.session.user = String(id);
			req.session.auth_version = user.auth_version || 0;
			req.session.auth_at = Date.now();
			if (sso) req.session.sso = sso;
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
		if (req.boundAccount) Support.assert(await Member.exists({ account: req.boundAccount, user: user._id }), 'Account access denied', 403);
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
		if (pending.sso) await Security.checkSso(await Billing.account(pending.sso.account), pending.sso.revision);
		return Security.establish(req, user._id, true, pending.sso);
	}
	static async issue(email, kind, data, path, name) {
		const token = Support.token();
		await mongoose.connection.transaction(async session => {
			if (data.user) { const user = await User.updateOne({ _id: data.user }, { $inc: { activity_sequence: 1 } }, { session }); Support.assert(user.matchedCount, 'User no longer exists', 409); }
			await Ticket.create([{ hash: Support.hash(token), kind, email, data, expires: new Date(Date.now() + 900000) }], { session });
		});
		await AdminSettings.send(kind, email, { url: Auth.origin + path + '?token=' + token, name });
	}
	static async profile(req) {
		Support.assert(!req.session?.sso && req.ctx.sso_revision == null, 'Sign in with password, Magic Link or passkey to change your personal profile', 403);
		if (req.body.avatar_style !== undefined) Support.assert(typeof req.body.avatar_style === 'string' && Object.hasOwn(avatarStyles, req.body.avatar_style), 'Unsupported avatar style');
		const user = await User.findById(req.ctx.user).lean();
		const name = req.body.name === undefined ? user.name : Support.text(req.body.name);
		const email = req.body.email === undefined ? user.email : Security.email(req.body.email);
		if (email !== user.email) {
			Security.browserSession(req);
			Support.assert(!await User.exists({ email }), 'Email address unavailable', 409);
			await Security.issue(email, 'email-change', { user: String(user._id), old: user.email, version: user.auth_version || 0 }, '/auth/email', name);
		}
		const updated = await User.findOneAndUpdate({ _id: user._id }, { $set: { ...(req.body.name !== undefined ? { name } : {}), ...(req.body.avatar_style !== undefined ? { avatar_style: req.body.avatar_style } : {}) } }, { returnDocument: 'after' }).lean();
		return { name: updated.name, avatar_style: updated.avatar_style || 'initials', email: user.email, pending_email: email !== user.email ? email : null };
	}
	static async confirmEmail(req) {
		Security.browserSession(req);
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
		const { password, hash } = await Security.password();
		const user = await User.findOneAndUpdate({ _id: userId }, { $set: { password: hash }, $inc: { auth_version: 1 } }, { returnDocument: 'after', session }).lean();
		Support.assert(user, 'Account missing', 401);
		return { password, version: user.auth_version };
	}
	static async forgot(email) {
		email = Security.email(email);
		const user = await User.findOne({ email }).lean();
		if (user) await Security.issue(email, 'password-reset', { user: String(user._id), version: user.auth_version || 0 }, '/auth/reset-password', user.name);
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
		Support.assert(!req.boundAccount, 'Use app.typerelay.com for passkeys', 403);
		const rpID = new URL(Auth.origin).hostname;
		let options;
		if (register) {
			Security.browserSession(req);
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
		Support.assert(!req.boundAccount, 'Use app.typerelay.com for passkeys', 403);
		if (register) Security.browserSession(req);
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
	static ssoUrls(account) {
		const branded = WhiteLabel.enabled() && Billing.entitlements(account).capabilities.white_label && account.white_label?.state === 'active' && account.white_label?.hostname;
		const origin = branded ? `https://${account.white_label.hostname}` : Auth.origin;
		const base = `${origin}/auth/sso/${account._id}`;
		return { origin, login: base + '/login', metadata: base + '/metadata', callback: base + '/callback', recovery: base + '/recovery' };
	}
	static ssoActive(account) { return Boolean(account?.sso?.enabled && Billing.entitlements(account).capabilities.sso); }
	static ssoFingerprint(account) { return Support.hash(JSON.stringify([account.sso?.issuer, account.sso?.login_url, account.sso?.certificate, Security.ssoUrls(account).callback])); }
	static checkSso(account, revision) {
		AccountAccess.assert(account);
		if (revision !== undefined && revision !== null) Support.assert(Security.ssoActive(account) && revision === account.sso.revision, 'SSO configuration changed; sign in again', 401);
		else if (Security.ssoActive(account) && account.sso.enforce) throw new Fault(403, 'Sign in with SSO to access this account', 'sso_required', { login_url: Security.ssoUrls(account).login, recovery_url: Security.ssoUrls(account).recovery });
	}
	static async context(req, id) {
		if (req.session.sso) Support.assert(req.session.sso.account === String(id), 'SSO sessions can only access their account', 403);
		const ctx = await Support.context(req.session.user, id);
		Security.checkSso(await Billing.account(id), req.session.sso?.revision);
		return { ...ctx, ...(req.session.sso ? { sso_revision: req.session.sso.revision } : {}) };
	}
	static async credential(ctx, credential) { Support.assert(await User.exists({ _id: ctx.user, 'deletion.requested_at': null }), 'Account deletion requested', 401); Security.checkSso(await Billing.account(ctx.account), credential.sso_revision); return ctx; }
	static async ssoAccount(id, secrets = false) {
		Support.id(String(id));
		let query = Account.findById(id);
		if (secrets) query = query.select('+sso.certificate +sso.recovery_hash');
		const account = await query.lean();
		AccountAccess.assert(account);
		return account;
	}
	static async ssoAdmin(req, paid = true) {
		Support.assert(req.session.user && !req.ctx.device && req.ctx.user === req.session.user && Support.admin(req.ctx), 'Owner or admin browser session required', 403);
		const account = await Security.ssoAccount(req.ctx.account, true);
		if (paid) Billing.assertCapability({ entitlements: Billing.entitlements(account) }, 'sso', 'SSO requires Pro or Team');
		return account;
	}
	static async ssoLog(account, event, user) { await SsoLog.create({ account, event, ...(user ? { user } : {}), expires: new Date(Date.now() + 30 * 86400000) }); }
	static async ssoSettings(req) {
		const account = await Security.ssoAdmin(req, false);
		const settings = { account: String(account._id), ...account.sso, recovery_hash: undefined, entitled: Billing.entitlements(account).capabilities.sso, urls: Security.ssoUrls(account), tested: account.sso?.tested_fingerprint === Security.ssoFingerprint(account), owner: req.ctx.role === 'owner' };
		delete settings.tested_fingerprint;
		return { revision: settings.revision || 0, html: pug.renderFile('./views/ajax/sso.pug', { settings }) };
	}
	static async saveSso(req) {
		const account = await Security.ssoAdmin(req);
		const body = req.body;
		for (const key of ['enabled', 'enforce', 'provision']) Support.assert(typeof body[key] === 'boolean', 'Invalid SSO setting');
		const issuer = Support.text(body.issuer, 2048);
		let login; try { login = new URL(Support.text(body.login_url, 2048)); } catch { throw new Fault(400, 'Enter a valid identity provider login URL'); }
		Support.assert(login.protocol === 'https:' && !login.username && !login.password && !login.hash, 'Identity provider login URL must use HTTPS');
		const certificate = Support.text(body.certificate, 16384);
		Support.assert((certificate.match(/-----BEGIN CERTIFICATE-----/g) || []).length === 1, 'Enter one PEM signing certificate');
		let cert; try { cert = new X509Certificate(certificate); } catch { throw new Fault(400, 'Invalid X.509 signing certificate'); }
		Support.assert(Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now(), 'Signing certificate is not currently valid');
		Support.assert(cert.publicKey.asymmetricKeyType === 'rsa' && cert.publicKey.asymmetricKeyDetails.modulusLength >= 2048, 'Use an RSA signing certificate with at least 2048 bits');
		const sso = { ...account.sso, enabled: body.enabled, enforce: body.enabled && body.enforce, provision: body.provision, issuer, login_url: login.href, certificate: cert.toString(), revision: (account.sso?.revision || 0) + 1 };
		if (sso.enforce || sso.provision) Support.assert(sso.tested_fingerprint === Security.ssoFingerprint({ ...account, sso }), 'Save the provider and complete Test login before enabling enforcement or provisioning');
		if (sso.enforce) Support.assert(sso.recovery_ready && sso.recovery_hash, 'The account owner must generate a recovery code before enforcing SSO');
		await AccountAccess.write(account._id, async session => {
			Support.assert(Number.isInteger(body.revision) && body.revision >= 0, 'Invalid settings revision');
			const fields = Object.fromEntries(['enabled', 'enforce', 'provision', 'issuer', 'login_url', 'certificate', 'revision'].map(key => ['sso.' + key, sso[key]]));
			const updated = await Account.updateOne({ _id: account._id, ...(body.revision === 0 ? { $or: [{ 'sso.revision': 0 }, { 'sso.revision': { $exists: false } }] } : { 'sso.revision': body.revision }) }, { $set: fields }, { session });
			Support.assert(updated.matchedCount, 'SSO settings changed; reopen Single sign-on and retry', 409);
		});
		if (req.session.sso) req.session.sso.revision = sso.revision;
		await Security.ssoLog(account._id, 'settings_saved', req.ctx.user);
		return Security.ssoSettings(req);
	}
	static async ssoRecoveryCode(req) {
		const account = await Security.ssoAdmin(req);
		Security.browserSession(req);
		Support.assert(req.ctx.role === 'owner', 'Only the owner can generate a recovery code', 403);
		const code = Support.token();
		await AccountAccess.write(account._id, session => Account.updateOne({ _id: account._id }, { $set: { 'sso.recovery_hash': Support.hash(code), 'sso.recovery_ready': true } }, { session }));
		await Security.ssoLog(account._id, 'recovery_generated', req.ctx.user);
		return { ...await Security.ssoSettings(req), secret_html: pug.renderFile('./views/ajax/sso-recovery-code.pug', { code }) };
	}
	static ssoDestination(value, account) {
		if (!value) return `/?account=${account}`;
		Support.assert(typeof value === 'string' && value.length <= 8192 && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value), 'Invalid SSO return address');
		const url = new URL(value, Auth.origin);
		Support.assert(url.origin === new URL(Auth.origin).origin && ['/', '/oauth/authorize', '/integrations/authorize'].includes(url.pathname), 'Invalid SSO return address');
		if (url.pathname === '/') url.searchParams.set('account', String(account));
		return url.pathname + url.search + url.hash;
	}
	static saml(account, flow) {
		const urls = Security.ssoUrls(account);
		const certificate = new X509Certificate(account.sso.certificate);
		Support.assert(Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(), 'Signing certificate is not currently valid');
		return new SAML({ callbackUrl: urls.callback, issuer: urls.metadata, audience: urls.metadata, entryPoint: account.sso.login_url, idpCert: account.sso.certificate, idpIssuer: account.sso.issuer, signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256', wantAssertionsSigned: false, wantAuthnResponseSigned: true, validateInResponseTo: 'always', requestIdExpirationPeriodMs: 600000, acceptedClockSkewMs: 30000, maxAssertionAgeMs: 300000, disableRequestedAuthnContext: true, cacheProvider: {
			saveAsync: async (key, value) => { await Ticket.create({ hash: Support.hash(`saml:${account._id}:${key}`), kind: 'saml-request', account: account._id, data: { flow: String(flow._id), value }, expires: flow.expires }); return { value, createdAt: Date.now() }; },
			getAsync: async key => (await Ticket.findOne({ hash: Support.hash(`saml:${account._id}:${key}`), kind: 'saml-request', 'data.flow': String(flow._id), expires: { $gt: new Date() } }).lean())?.data.value || null,
			removeAsync: async key => key ? (await Ticket.findOneAndDelete({ hash: Support.hash(`saml:${account._id}:${key}`), kind: 'saml-request', 'data.flow': String(flow._id) }).lean())?.data.value || null : null,
		} });
	}
	static async ssoBegin(req, res) {
		const account = await Security.ssoAccount(req.params.account, true);
		Billing.assertCapability({ entitlements: Billing.entitlements(account) }, 'sso', 'SSO requires Pro or Team');
		const urls = Security.ssoUrls(account);
		const destination = Security.ssoDestination(req.query.return_to || req.session.return_to, account._id);
		if (req.hostname !== new URL(urls.origin).hostname) return res.redirect(urls.login + '?return_to=' + encodeURIComponent(destination) + (req.query.test === 'true' ? '&test=true' : ''));
		if (req.boundAccount) Support.assert(req.boundAccount === String(account._id), 'Account access denied', 403);
		const test = req.query.test === 'true';
		if (test && !req.session.user) { req.session.return_to = req.originalUrl; await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve())); return res.redirect('/login'); }
		if (test) { req.ctx = await Security.context(req, String(account._id)); await Security.ssoAdmin(req); }
		Support.assert((account.sso?.enabled || test) && account.sso?.certificate && account.sso?.login_url, 'SSO is not configured for this account', 403);
		const state = Support.token();
		const flow = await Ticket.create({ hash: Support.hash(state), kind: 'saml-flow', account: account._id, expires: new Date(Date.now() + 600000), data: { browser: Support.hash(req.sessionID), revision: account.sso.revision, fingerprint: Security.ssoFingerprint(account), destination, test, user: test ? req.session.user : null } });
		await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
		res.redirect(await Security.saml(account, flow).getAuthorizeUrlAsync(state, {}));
	}
	static async ssoCallback(req, res) {
		const account = await Security.ssoAccount(req.params.account, true);
		const urls = Security.ssoUrls(account);
		try {
			Billing.assertCapability({ entitlements: Billing.entitlements(account) }, 'sso', 'SSO requires Pro or Team');
			Support.assert(req.hostname === new URL(urls.origin).hostname && (!req.boundAccount || req.boundAccount === String(account._id)), 'SSO callback host mismatch', 400);
			Support.assert(typeof req.body.SAMLResponse === 'string' && req.body.SAMLResponse.length <= 180000 && typeof req.body.RelayState === 'string' && /^[A-Za-z0-9_-]{43}$/.test(req.body.RelayState), 'Invalid SAML response');
			const flow = await Ticket.findOne({ hash: Support.hash(req.body.RelayState), account: account._id, kind: 'saml-flow', expires: { $gt: new Date() } }).lean();
			Support.assert(flow && (account.sso.enabled || flow.data.test) && flow.data.revision === account.sso.revision && flow.data.fingerprint === Security.ssoFingerprint(account), 'SSO request expired or configuration changed', 401);
			const xml = Buffer.from(req.body.SAMLResponse, 'base64').toString('utf8');
			Support.assert(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'Invalid SAML XML');
			const { profile, loggedOut } = await Security.saml(account, flow).validatePostResponseAsync(req.body);
			Support.assert(profile && !loggedOut && profile.issuer === account.sso.issuer, 'Invalid SAML issuer', 401);
			const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
			Support.assert(root.localName === 'Response' && root.namespaceURI === 'urn:oasis:names:tc:SAML:2.0:protocol' && root.getAttribute('Destination') === urls.callback, 'Invalid SAML destination', 401);
			Support.assert(root.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:protocol', 'StatusCode')[0]?.getAttribute('Value') === 'urn:oasis:names:tc:SAML:2.0:status:Success', 'SAML authentication was not successful', 401);
			Support.assert(!Array.from(root.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', '*')).some(node => /(?:SignatureMethod|DigestMethod)/.test(node.localName) && /sha1$/i.test(node.getAttribute('Algorithm'))), 'SAML requires SHA-256 or stronger signatures', 401);
			const assertion = profile.getAssertion().Assertion;
			const confirmation = assertion.Subject?.[0]?.SubjectConfirmation;
			const data = confirmation?.[0]?.SubjectConfirmationData?.[0]?.$;
			Support.assert(confirmation?.length === 1 && confirmation[0].$?.Method === 'urn:oasis:names:tc:SAML:2.0:cm:bearer' && data?.Recipient === urls.callback && data?.InResponseTo === profile.inResponseTo && Number.isFinite(Date.parse(data?.NotOnOrAfter)) && Number.isFinite(Date.parse(assertion.Conditions?.[0]?.$?.NotOnOrAfter)), 'Invalid SAML subject confirmation', 401);
			const email = Security.email(profile.nameID);
			const name = typeof profile.displayName === 'string' ? profile.displayName.slice(0, 100) : email.split('@')[0];
			// The separate atomic flow receipt also stops simultaneous replays with older cache-provider APIs.
			Support.assert(await Ticket.findOneAndDelete({ _id: flow._id, expires: { $gt: new Date() } }).lean(), 'SSO response already used', 401);
			const code = Support.token();
			await Ticket.create({ hash: Support.hash(code), kind: 'saml-finish', account: account._id, data: { ...flow.data, email, name }, expires: new Date(Date.now() + 60000) });
			// The GET restores the original SameSite=Lax browser cookie; never authenticate the cross-site POST's session.
			res.set('Referrer-Policy', 'no-referrer').redirect(303, urls.origin + '/auth/sso/finish?ticket=' + code);
		} catch (error) {
			await Security.ssoLog(account._id, 'login_failed');
			throw new Fault(error.code === 'plan_required' ? 403 : 401, 'SSO sign-in failed. Check the provider configuration or start a new sign-in.', 'sso_failed');
		}
	}
	static async ssoFinish(req, res) {
		const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(Support.text(req.query.ticket, 256)), kind: 'saml-finish', 'data.browser': Support.hash(req.sessionID), expires: { $gt: new Date() } }).lean();
		Support.assert(ticket, 'SSO sign-in expired or was opened in another browser. Start again.', 401);
		const account = await Security.ssoAccount(ticket.account, true);
		const data = ticket.data;
		Billing.assertCapability({ entitlements: Billing.entitlements(account) }, 'sso', 'SSO requires Pro or Team');
		Support.assert((account.sso.enabled || data.test) && data.revision === account.sso.revision && data.fingerprint === Security.ssoFingerprint(account), 'SSO configuration changed; start again', 401);
		if (data.test) {
			Support.assert(req.session.user === data.user, 'Test session changed', 401);
			const user = await User.findById(data.user).lean();
			Support.assert(user?.email === data.email && await Member.exists({ user: data.user, account: account._id, role: { $in: ['owner', 'admin'] } }), 'Test login must use your own administrator identity', 403);
			await Account.updateOne({ _id: account._id, 'sso.revision': data.revision }, { $set: { 'sso.tested_fingerprint': data.fingerprint, 'sso.tested_at': new Date() } });
			await Security.ssoLog(account._id, 'test_success', data.user);
			return res.render('sso-message', { title: 'SSO test successful', message: 'Your identity provider verified your administrator identity. Return to Single sign-on settings to enable SSO or update its policy.', destination: `/?account=${account._id}#settings-sso` });
		}
		const user = await AccountAccess.write(account._id, async session => {
			const current = await Account.findById(account._id).session(session).lean();
			Security.checkSso(current, data.revision);
			let user = await User.findOneAndUpdate({ email: data.email, 'deletion.requested_at': null }, { $inc: { activity_sequence: 1 } }, { session, returnDocument: 'after' }).lean();
			Support.assert(user || !await User.exists({ email: data.email }).session(session), 'Account deletion is in progress', 403);
			if (!user || !await Member.exists({ account: account._id, user: user._id }).session(session)) {
				Support.assert(current.sso.provision, 'Ask an administrator to add you to this account', 403);
				// Existing TypeRelay users join only by accepting a team invitation; the IdP admin can also mint invites, so neither alone may claim them.
				if (user) throw new Fault(403, 'This email already has a TypeRelay account. Accept the team invitation from your email first, then sign in with SSO.', 'sso_invite_required');
				const ctx = { account: String(account._id), entitlements: Billing.entitlements(current) };
				await Ticket.deleteMany({ account: account._id, kind: 'invite', email: data.email }, { session });
				await Billing.assertSeatCapacity(ctx, 1, session);
				if (!user) [user] = await User.create([{ email: data.email, name: data.name }], { session });
				await Member.create([{ account: account._id, user: user._id, role: 'member' }], { session });
				await Support.change(account._id, null, 'membership', session);
			}
			return user;
		}).catch(async error => { if (error.code === 'sso_invite_required') await Security.ssoLog(account._id, 'invite_required').catch(() => console.error('SSO invitation failure could not be logged')); throw error; });
		await Security.ssoLog(account._id, 'login_success', user._id);
		req.session.return_to = data.destination;
		const result = await Security.establish(req, user._id, false, { account: String(account._id), revision: data.revision });
		res.redirect(result.redirect);
	}
	static async ssoRecover(req) {
		Security.browserSession(req);
		const account = await Security.ssoAccount(req.params.account, true);
		Support.assert(await Member.exists({ account: account._id, user: req.session.user, role: 'owner' }), 'Only the account owner can recover SSO', 403);
		const hash = Support.hash(Support.text(req.body.code, 256));
		const updated = await AccountAccess.write(account._id, session => Account.updateOne({ _id: account._id, 'sso.recovery_hash': hash }, { $set: { 'sso.enforce': false, 'sso.recovery_ready': false }, $unset: { 'sso.recovery_hash': '' }, $inc: { 'sso.revision': 1 } }, { session }));
		Support.assert(updated.matchedCount, 'Invalid or already used recovery code', 401);
		await Security.ssoLog(account._id, 'recovered', req.session.user);
		return { redirect: `/?account=${account._id}#settings-sso` };
	}
	static async authorizeWithSso(req, res, integration = false) {
		Support.assert(req.session.user, 'Sign in required', 401);
		if (integration && req.body.decision === 'deny') return res.redirect(await Auth.approveIntegration(req.session.user, req.body));
		try {
			const ctx = await Security.context(req, req.body.account);
			res.redirect(integration ? await Auth.approveIntegration(req.session.user, req.body, ctx) : await Auth.authorize(req.session.user, req.body, ctx));
		} catch (error) {
			if (error.code !== 'sso_required') throw error;
			const query = new URLSearchParams(Object.entries(req.body).filter(([key, value]) => key !== '_csrf' && typeof value === 'string'));
			const destination = (integration ? '/integrations/authorize?' : '/oauth/authorize?') + query;
			req.session.return_to = Security.ssoDestination(destination, req.body.account);
			await new Promise((resolve, reject) => req.session.save(failure => failure ? reject(failure) : resolve()));
			res.redirect(error.details.login_url + '?return_to=' + encodeURIComponent(req.session.return_to));
		}
	}
	static mount(app, limit) {
		app.use('/auth', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
		app.post('/auth/sso/start', limit, async (req, res) => {
			let id = Support.text(req.body.account, 2048);
			if (!/^[a-f0-9]{24}$/.test(id)) { let url; try { url = new URL(id); } catch { throw new Fault(400, 'Enter the SSO sign-in link from your administrator'); } id = url.pathname.match(/^\/auth\/sso\/([a-f0-9]{24})\/login$/)?.[1]; }
			const account = await Security.ssoAccount(Support.id(id));
			Support.assert(Security.ssoActive(account), 'SSO is not available for this account', 403);
			res.json({ redirect: Security.ssoUrls(account).login + '?return_to=' + encodeURIComponent(Security.ssoDestination(req.session.return_to, account._id)) });
		});
		app.get('/auth/sso/finish', limit, Security.ssoFinish);
		app.get('/auth/sso/:account/login', limit, Security.ssoBegin);
		app.post('/auth/sso/:account/callback', limit, Security.ssoCallback);
		app.get('/auth/sso/:account/metadata', limit, async (req, res) => { const account = await Security.ssoAccount(req.params.account, true); Billing.assertCapability({ entitlements: Billing.entitlements(account) }, 'sso', 'SSO requires Pro or Team'); Support.assert(account.sso?.certificate, 'Save the identity provider configuration first'); res.type('application/xml').send(Security.saml(account).generateServiceProviderMetadata(null, null)); });
		app.get('/auth/sso/:account/recovery', limit, (req, res) => res.render('sso-recovery', { account: Support.id(req.params.account), signedIn: Boolean(req.session.user && !req.session.sso) }));
		app.post('/auth/sso/:account/recovery', limit, async (req, res) => res.json(await Security.ssoRecover(req)));
		app.get('/login', (req, res) => res.render('login'));
		app.get('/signup', (req, res) => {
			if (req.boundAccount) return res.redirect(new URL('/signup', Auth.origin).toString());
			if (Auth.adsEnabled(req)) {
				const attribution = Auth.attribution(req.query);
				if (Object.keys(attribution).length) req.session.signupAttribution = { ...attribution, captured_at: Date.now() };
			}
			res.render('auth', { kind: 'signup' });
		});
		app.post('/auth/signup', limit, async (req, res) => {
			Support.assert(Security.signupEnabled(), 'Signup is disabled', 403); Support.assert(!req.boundAccount, 'Create accounts at app.typerelay.com', 403);
			const acquisition = Auth.adsEnabled(req) && req.session.signupAttribution?.captured_at > Date.now() - 30 * 86400000 ? Auth.attribution(req.session.signupAttribution) : undefined;
			await Auth.login(Security.email(req.body.email), req.body.name, { acquisition });
			res.json({ message: 'Check your email to finish creating your account.' });
		});
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
		app.use('/api/v2/sso', limit, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
		app.get('/api/v2/sso', async (req, res) => res.json(await Security.ssoSettings(req)));
		app.put('/api/v2/sso', async (req, res) => res.json(await Security.saveSso(req)));
		app.post('/api/v2/sso/recovery-code', async (req, res) => res.json(await Security.ssoRecoveryCode(req)));
		app.get('/api/v2/sso/logs', async (req, res) => { await Security.ssoAdmin(req, false); const logs = await SsoLog.find({ account: req.ctx.account, expires: { $gt: new Date() } }).sort({ createdAt: -1, _id: -1 }).limit(50).lean(); res.json({ html: pug.renderFile('./views/ajax/sso-logs.pug', { logs }) }); });
		app.use('/api/v2/security', limit, (req, res, next) => { if (req.method !== 'GET') Security.browserSession(req); res.setHeader('Cache-Control', 'no-store'); next(); });
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
