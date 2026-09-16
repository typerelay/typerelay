import { AccountAccess } from './account_access.js';
import { resolveCname } from 'node:dns/promises';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { domainToASCII } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileTypeFromFile } from 'file-type';
import sharp from 'sharp';
import { Account } from '../model/index.js';
import { Billing } from './billing.js';

export class WhiteLabel {
	static maximumFileSize = 5 * 1024 * 1024;
	static pendingDelay = 5 * 60 * 1000;
	static activeDelay = 15 * 60 * 1000;
	static assets = {
		logo: { width: 260, height: 48, fit: 'inside' },
		favicon: { width: 64, height: 64, fit: 'contain' },
		login_logo: { width: 500, height: 120, fit: 'inside' },
	};
	static imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon']);

	static enabled() { return Billing.hosted() && process.env.WHITE_LABEL_ENABLED === 'true'; }
	static cnameTarget() { return String(process.env.WHITE_LABEL_CNAME_TARGET || 'custom.typerelay.com').trim().toLowerCase().replace(/\.$/, ''); }
	static assetsRoot() { return resolve(process.env.WHITE_LABEL_ASSETS_DIR || '/data/white-label'); }
	static temporaryRoot(accountId = null) { return accountId ? join(WhiteLabel.assetsRoot(), String(accountId), '_tmp') : join(WhiteLabel.assetsRoot(), '_tmp'); }

	static error(status, message, code = 'white_label_error', details = null) {
		const error = new Error(message);
		error.status = status;
		error.code = code;
		error.details = details;
		return error;
	}

	static normalizeHostname(value, allowEmpty = true) {
		const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '').replace(/^https?:\/\//, '');
		if (!raw && allowEmpty) return '';
		if (!raw || /[/?#:@]/.test(raw)) throw WhiteLabel.error(400, 'Enter a hostname only, for example app.example.com', 'hostname_invalid');
		const hostname = domainToASCII(raw);
		const labels = hostname.split('.');
		if (hostname.length > 253 || labels.length < 2 || labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw WhiteLabel.error(400, 'Enter a valid hostname', 'hostname_invalid');
		let canonical = '';
		try { canonical = new URL(process.env.APP_URL || 'http://localhost').hostname; } catch {}
		if (hostname === canonical || hostname === WhiteLabel.cnameTarget() || hostname.endsWith('.typerelay.com')) throw WhiteLabel.error(400, 'Use a hostname on your own domain', 'hostname_reserved');
		return hostname;
	}

	static assertTeam(account) {
		if (!WhiteLabel.enabled()) throw WhiteLabel.error(404, 'White-label is not available', 'not_found');
		if (Billing.entitlements(account).plan !== 'team') throw WhiteLabel.error(403, 'White-label requires Team', 'plan_required', { capability: 'white_label', upgrade_url: '/#settings-subscription' });
	}

	static async account(id, secrets = false) {
		let query = Account.findById(id);
		if (secrets) query = query.select('+white_label.cloudflare_hostname_id +white_label.logo.storage_key +white_label.favicon.storage_key +white_label.login_logo.storage_key +billing.stripe_customer_id +billing.stripe_subscription_id +billing.stripe_free_subscription_id');
		return query.lean();
	}

	static serialize(account, entitled = Billing.entitlements(account).plan === 'team') {
		const whiteLabel = account?.white_label || {};
		const asset = kind => whiteLabel[kind]?.url ? { url: whiteLabel[kind].url, mime_type: whiteLabel[kind].mime_type || '', size: whiteLabel[kind].size || 0, width: whiteLabel[kind].width || 0, height: whiteLabel[kind].height || 0, updated_at: whiteLabel[kind].updated_at || null } : null;
		return { entitled, logo: asset('logo'), favicon: asset('favicon'), login_logo: asset('login_logo'), logo_url: entitled ? whiteLabel.logo?.url || '' : '', favicon_url: entitled ? whiteLabel.favicon?.url || '' : '', login_logo_url: entitled ? whiteLabel.login_logo?.url || '' : '', hostname: whiteLabel.hostname || '', state: whiteLabel.state || 'unconfigured', cname_target: WhiteLabel.cnameTarget(), cloudflare_hostname_status: whiteLabel.cloudflare_hostname_status || '', cloudflare_ssl_status: whiteLabel.cloudflare_ssl_status || '', dns_verified_at: whiteLabel.dns_verified_at || null, cloudflare_checked_at: whiteLabel.cloudflare_checked_at || null, last_error: whiteLabel.last_error || '', active: entitled && whiteLabel.state === 'active' };
	}

	static public(account) {
		const settings = WhiteLabel.serialize(account, Billing.entitlements(account).plan === 'team');
		return settings.active || settings.logo_url || settings.favicon_url || settings.login_logo_url ? settings : null;
	}

	static async settings(accountId) {
		const account = await WhiteLabel.account(accountId);
		if (!account) throw WhiteLabel.error(404, 'Account missing', 'account_missing');
		return WhiteLabel.serialize(account);
	}

	static cloudflareConfig() {
		const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
		const zoneId = process.env.CLOUDFLARE_ZONE_ID || '';
		if (!apiToken || !zoneId) throw WhiteLabel.error(503, 'Cloudflare Custom Hostnames is not configured', 'cloudflare_unavailable');
		return { apiToken, zoneId };
	}

	static async cloudflare(path, options = {}) {
		const { apiToken, zoneId } = WhiteLabel.cloudflareConfig();
		const response = await (options.fetch || fetch)(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, { method: options.method || 'GET', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(15000) });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok || payload.success === false) throw WhiteLabel.error(response.status >= 400 && response.status < 500 ? response.status : 502, (payload.errors || []).map(error => error.message).filter(Boolean).join('; ') || `Cloudflare request failed (${response.status})`, 'cloudflare_error', payload.errors || []);
		return payload.result;
	}

	static createHostname(hostname, options = {}) { return WhiteLabel.cloudflare('/custom_hostnames', { ...options, method: 'POST', body: { hostname, custom_origin_server: WhiteLabel.cnameTarget(), custom_metadata: { catalog: Billing.catalogName }, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } } }); }
	static getHostname(id, options = {}) { return WhiteLabel.cloudflare(`/custom_hostnames/${encodeURIComponent(id)}`, options); }
	static listHostnames(hostname, options = {}) { return WhiteLabel.cloudflare(`/custom_hostnames?${new URLSearchParams({ 'hostname[exact]': hostname, per_page: '50' })}`, options); }
	static async deleteHostname(id, options = {}) { try { await WhiteLabel.cloudflare(`/custom_hostnames/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' }); } catch (error) { if (error.status !== 404) throw error; } }

	static async configure(accountId, hostname, options = {}) {
		const account = await WhiteLabel.account(accountId, true);
		WhiteLabel.assertTeam(account);
		hostname = WhiteLabel.normalizeHostname(hostname);
		if (hostname === account.white_label?.hostname) return WhiteLabel.serialize(account);
		const duplicate = await Account.exists({ _id: { $ne: account._id }, 'white_label.hostname': hostname });
		if (duplicate) throw WhiteLabel.error(409, 'This hostname is already connected', 'hostname_conflict');
		if (account.white_label?.cloudflare_hostname_id) await WhiteLabel.deleteHostname(account.white_label.cloudflare_hostname_id, options);
		const state = { hostname, state: hostname ? 'pending_dns' : 'unconfigured', cloudflare_hostname_id: '', cloudflare_hostname_status: '', cloudflare_ssl_status: '', dns_verified_at: null, cloudflare_checked_at: null, next_check_at: hostname ? new Date() : null, disabled_at: null, last_error: '' };
		const updated = await Account.findByIdAndUpdate(account._id, { $set: { white_label: { ...account.white_label, ...state } } }, { returnDocument: 'after' }).lean();
		return WhiteLabel.serialize(updated);
	}

	static cloudflareState(record) {
		const hostnameStatus = String(record?.status || '');
		const sslStatus = String(record?.ssl?.status || '');
		return { state: hostnameStatus === 'active' && sslStatus === 'active' ? 'active' : 'pending_ssl', cloudflare_hostname_id: String(record?.id || ''), cloudflare_hostname_status: hostnameStatus, cloudflare_ssl_status: sslStatus, cloudflare_checked_at: new Date(), next_check_at: new Date(Date.now() + (hostnameStatus === 'active' && sslStatus === 'active' ? WhiteLabel.activeDelay : WhiteLabel.pendingDelay)), last_error: '' };
	}

	static async saveState(accountId, state) {
		const update = Object.fromEntries(Object.entries(state).map(([key, value]) => [`white_label.${key}`, value]));
		return Account.findByIdAndUpdate(accountId, { $set: update }, { returnDocument: 'after' }).select('+white_label.cloudflare_hostname_id').lean();
	}

	static async verify(accountId, options = {}) {
		let account = await WhiteLabel.account(accountId, true);
		WhiteLabel.assertTeam(account);
		const hostname = WhiteLabel.normalizeHostname(account.white_label?.hostname, false);
		const resolveFn = options.resolveCname || resolveCname;
		const records = await resolveFn(hostname).catch(() => []);
		const matches = records.map(record => String(record).toLowerCase().replace(/\.$/, '')).includes(WhiteLabel.cnameTarget());
		if (!matches) {
			account = await WhiteLabel.saveState(accountId, { state: 'pending_dns', dns_verified_at: null, next_check_at: new Date(Date.now() + WhiteLabel.pendingDelay), last_error: `CNAME must point to ${WhiteLabel.cnameTarget()}` });
			throw Object.assign(WhiteLabel.error(400, `CNAME must point to ${WhiteLabel.cnameTarget()}`, 'cname_not_verified', { records }), { settings: WhiteLabel.serialize(account) });
		}
		let record;
		try {
			if (account.white_label.cloudflare_hostname_id) record = await WhiteLabel.getHostname(account.white_label.cloudflare_hostname_id, options);
			else {
				try { record = await WhiteLabel.createHostname(hostname, options); } catch (error) {
					const existing = await WhiteLabel.listHostnames(hostname, options).catch(() => []);
					if (!existing?.length) throw error;
					record = existing[0];
				}
			}
			account = await WhiteLabel.saveState(accountId, { dns_verified_at: new Date(), ...WhiteLabel.cloudflareState(record) });
			return WhiteLabel.serialize(account);
		} catch (error) {
			await WhiteLabel.saveState(accountId, { state: 'error', last_error: error.message, cloudflare_checked_at: new Date(), next_check_at: new Date(Date.now() + WhiteLabel.pendingDelay) });
			throw error;
		}
	}

	static async refresh(accountId, options = {}) {
		const account = await WhiteLabel.account(accountId, true);
		WhiteLabel.assertTeam(account);
		if (!account.white_label?.cloudflare_hostname_id) return WhiteLabel.verify(accountId, options);
		try {
			const record = await WhiteLabel.getHostname(account.white_label.cloudflare_hostname_id, options);
			return WhiteLabel.serialize(await WhiteLabel.saveState(accountId, WhiteLabel.cloudflareState(record)));
		} catch (error) {
			if (error.status === 404) { await WhiteLabel.saveState(accountId, { cloudflare_hostname_id: '', cloudflare_hostname_status: '', cloudflare_ssl_status: '', state: 'pending_dns' }); return WhiteLabel.verify(accountId, options); }
			throw error;
		}
	}

	static async disable(account, options = {}) {
		if (!account?.white_label?.hostname) return false;
		account = account.white_label.cloudflare_hostname_id !== undefined ? account : await WhiteLabel.account(account._id, true);
		if (account.white_label.cloudflare_hostname_id) await WhiteLabel.deleteHostname(account.white_label.cloudflare_hostname_id, options).catch(() => {});
		await WhiteLabel.saveState(account._id, { state: 'disabled_by_plan', disabled_at: account.white_label.disabled_at || new Date(), cloudflare_hostname_id: '', cloudflare_hostname_status: '', cloudflare_ssl_status: '', next_check_at: new Date(Date.now() + WhiteLabel.pendingDelay) });
		return true;
	}

	static async remove(accountId, options = {}) {
		const account = await WhiteLabel.account(accountId, true);
		WhiteLabel.assertTeam(account);
		if (account.white_label?.cloudflare_hostname_id) await WhiteLabel.deleteHostname(account.white_label.cloudflare_hostname_id, options);
		await Account.updateOne({ _id: accountId }, { $set: { 'white_label.hostname': '', 'white_label.state': 'unconfigured', 'white_label.cloudflare_hostname_id': '', 'white_label.cloudflare_hostname_status': '', 'white_label.cloudflare_ssl_status': '', 'white_label.dns_verified_at': null, 'white_label.cloudflare_checked_at': null, 'white_label.next_check_at': null, 'white_label.disabled_at': null, 'white_label.last_error': '' } });
		return WhiteLabel.settings(accountId);
	}

	static async upload(accountId, kind, file) {
		const config = WhiteLabel.assets[kind];
		if (!config) throw WhiteLabel.error(404, 'Unknown branding asset', 'asset_unknown');
		const account = await WhiteLabel.account(accountId, true);
		WhiteLabel.assertTeam(account);
		if (!file?.filepath || !file.size || file.size > WhiteLabel.maximumFileSize) throw WhiteLabel.error(400, 'Choose an image up to 5 MB', 'asset_invalid');
		const detected = await fileTypeFromFile(file.filepath).catch(() => null);
		if (!detected || !WhiteLabel.imageTypes.has(detected.mime)) throw WhiteLabel.error(400, 'Upload a PNG, JPG, WebP, AVIF, GIF, or ICO image', 'asset_invalid');
		const directory = join(WhiteLabel.assetsRoot(), String(accountId), kind);
		const filename = `${kind}-${randomUUID()}.png`;
		await mkdir(WhiteLabel.temporaryRoot(accountId), { recursive: true });
		const temporary = join(WhiteLabel.temporaryRoot(accountId), filename);
		await sharp(file.filepath, { pages: 1, animated: false }).resize({ ...config, withoutEnlargement: true, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(temporary);
		const metadata = await sharp(temporary).metadata();
		const info = await stat(temporary);
		await rm(directory, { recursive: true, force: true });
		await mkdir(directory, { recursive: true });
		await rename(temporary, join(directory, filename));
		const asset = { url: `/white-label-assets/${accountId}/${kind}/${filename}`, storage_key: `${accountId}/${kind}/${filename}`, mime_type: 'image/png', size: info.size, width: metadata.width || 0, height: metadata.height || 0, updated_at: new Date() };
		await Account.updateOne({ _id: accountId }, { $set: { [`white_label.${kind}`]: asset } });
		return WhiteLabel.settings(accountId);
	}

	static async deleteAsset(accountId, kind) {
		if (!WhiteLabel.assets[kind]) throw WhiteLabel.error(404, 'Unknown branding asset', 'asset_unknown');
		const account = await WhiteLabel.account(accountId);
		WhiteLabel.assertTeam(account);
		await rm(join(WhiteLabel.assetsRoot(), String(accountId), kind), { recursive: true, force: true });
		await Account.updateOne({ _id: accountId }, { $set: { [`white_label.${kind}`]: null } });
		return WhiteLabel.settings(accountId);
	}

	static requestHostname(req) {
		const forwarded = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
		return String(forwarded || req.headers?.host || req.hostname || '').split(':')[0].toLowerCase().replace(/\.$/, '');
	}

	static platformHostname(hostname) {
		let canonical = '';
		try { canonical = new URL(process.env.APP_URL || 'http://localhost').hostname; } catch {}
		return !hostname || hostname === canonical || hostname === WhiteLabel.cnameTarget() || hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.lan') || hostname.endsWith('.local');
	}

	static async resolveRequest(req, res, next) {
		try {
			res.locals.whiteLabel = null;
			if (!WhiteLabel.enabled()) return next();
			const hostname = WhiteLabel.requestHostname(req);
			if (WhiteLabel.platformHostname(hostname)) return next();
			const account = await Account.findOne({ ...AccountAccess.available, 'white_label.hostname': hostname, 'white_label.state': 'active' }).lean();
			if (!account || Billing.entitlements(account).plan !== 'team') return res.status(404).send('Custom domain is not configured.');
			req.boundAccount = String(account._id);
			res.locals.whiteLabel = WhiteLabel.public(account);
			return next();
		} catch (error) { return next(error); }
	}

	static async reconcile(options = {}) {
		if (!WhiteLabel.enabled()) return { checked: 0, updated: 0, failed: 0 };
		const now = options.now || new Date();
		const accounts = await Account.find({ ...AccountAccess.available, 'white_label.hostname': { $gt: '' }, $or: [{ 'white_label.next_check_at': { $lte: now } }, { 'white_label.next_check_at': null }] }).select('+white_label.cloudflare_hostname_id +billing.stripe_customer_id +billing.stripe_subscription_id').sort({ 'white_label.next_check_at': 1, _id: 1 }).limit(options.limit || 100).lean();
		const result = { checked: accounts.length, updated: 0, failed: 0 };
		for (const account of accounts) {
			try {
				await AccountAccess.run(account._id, async () => {
				if (Billing.entitlements(account, now).plan !== 'team') await WhiteLabel.disable(account, options);
				else if (['pending_dns', 'disabled_by_plan'].includes(account.white_label.state) || !account.white_label.cloudflare_hostname_id) await WhiteLabel.verify(account._id, options);
				else await WhiteLabel.refresh(account._id, options);
				});
				result.updated++;
			} catch { result.failed++; }
		}
		return result;
	}
}
