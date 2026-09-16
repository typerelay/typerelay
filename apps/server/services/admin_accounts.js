import { randomUUID } from 'node:crypto';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import * as Models from '../model/index.js';
import { Support } from './support.js';
import { Auth } from './auth.js';
import { Security } from './security.js';
import { Billing } from './billing.js';
import { WhiteLabel } from './white_label.js';

export class AdminAccounts {
	static owned = ['Member', 'Group', 'Library', 'Snippet', 'SnippetAsset', 'Device', 'Change', 'Operation', 'Conflict', 'Integration', 'ApiAudit', 'AdminAudit'];
	static state(account) { return account.deletion?.requested_at ? account.deletion.stage === 'failed' ? 'failed' : 'deleting' : account.is_active === false ? 'suspended' : 'active'; }
	static async counts(ids) {
		const match = { account: { $in: ids } };
		const counts = new Map(ids.map(id => [String(id), { users: 0, snippets: 0, libraries: 0, devices: 0, trash_snippets: 0, trash_libraries: 0, groups: 0, invitations: 0, integrations: 0, assets: 0, bytes: 0 }]));
		const queries = [
			['users', Models.Member, {}], ['libraries', Models.Library, { state: 'active' }], ['trash_libraries', Models.Library, { state: 'trashed' }], ['trash_snippets', Models.Snippet, { state: 'trashed' }], ['devices', Models.Device, { revoked: false }], ['groups', Models.Group, {}], ['invitations', Models.Ticket, { kind: 'invite', expires: { $gt: new Date() } }], ['integrations', Models.Integration, { revoked: false, expires: { $gt: new Date() } }], ['assets', Models.SnippetAsset, {}],
		];
		await Promise.all(queries.map(async ([key, model, filter]) => { for (const row of await model.aggregate([{ $match: { ...match, ...filter } }, { $group: { _id: '$account', count: { $sum: 1 }, bytes: { $sum: '$size' } } }])) { counts.get(String(row._id))[key] = row.count; if (key === 'assets') counts.get(String(row._id)).bytes = row.bytes; } }));
		for (const row of await Models.Snippet.aggregate([{ $match: { ...match, state: 'active' } }, { $lookup: { from: 'libraries', localField: 'library', foreignField: '_id', as: 'parent' } }, { $match: { 'parent.state': 'active' } }, { $group: { _id: '$account', count: { $sum: 1 } } }])) counts.get(String(row._id)).snippets = row.count;
		return counts;
	}
	static async decorate(accounts) {
		const ids = accounts.map(account => account._id);
		const [counts, owners] = await Promise.all([AdminAccounts.counts(ids), Models.Member.find({ account: { $in: ids }, role: 'owner' }).lean()]);
		const users = await Models.User.find({ _id: { $in: owners.map(owner => owner.user) } }).select('name email').lean();
		return accounts.map(account => ({ id: String(account._id), name: account.name, createdAt: account.createdAt, revision: account.admin_revision || 0, status: AdminAccounts.state(account), plan: account.plan, billing_status: account.billing?.status || 'incomplete', effective_plan: Billing.entitlements(account).plan, override: account.admin_override || {}, owner: users.find(user => String(user._id) === String(owners.find(owner => String(owner.account) === String(account._id))?.user)) || null, usage: counts.get(String(account._id)), domain: { hostname: account.white_label?.hostname || '', state: account.white_label?.state || 'unconfigured' }, deletion: account.deletion?.requested_at ? { stage: account.deletion.stage, error: account.deletion.error || '' } : null }));
	}
	static async list(query = {}) {
		const filter = {};
		if (query.id) filter._id = Support.id(query.id);
		if (query.plan) { Support.assert(['free', 'pro', 'team'].includes(query.plan), 'Invalid plan'); filter.plan = query.plan; }
		if (query.status === 'active' || query.status === 'suspended') { filter['deletion.requested_at'] = null; filter.is_active = query.status === 'active' ? { $ne: false } : false; }
		else if (query.status === 'deleting' || query.status === 'failed') { filter['deletion.requested_at'] = { $ne: null }; filter['deletion.stage'] = query.status === 'failed' ? 'failed' : { $ne: 'failed' }; }
		if (query.q) {
			const q = String(query.q).trim().slice(0, 200);
			const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
			const users = await Models.User.find({ email: regex }).select('_id').lean();
			const owners = await Models.Member.find({ user: { $in: users.map(user => user._id) }, role: 'owner' }).select('account').lean();
			filter.$or = [{ name: regex }, { _id: { $in: owners.map(owner => owner.account) } }, ...(/^[a-f0-9]{24}$/.test(q) ? [{ _id: q }] : [])];
		}
		const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
		const [accounts, total] = await Promise.all([Models.Account.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(50).lean(), Models.Account.countDocuments(filter)]);
		return { accounts: await AdminAccounts.decorate(accounts), page, total, pages: Math.ceil(total / 50), query };
	}
	static async get(id) {
		const account = await Models.Account.findById(Support.id(id)).lean();
		Support.assert(account, 'Account not found', 404);
		const [result] = await AdminAccounts.decorate([account]);
		const members = await Models.Member.find({ account: id }).lean();
		const users = await Models.User.find({ _id: { $in: members.map(member => member.user) } }).select('name email').lean();
		result.members = members.map(member => ({ role: member.role, user: users.find(user => Support.equal(user._id, member.user)) }));
		result.owner_accounts = result.owner ? await Models.Member.countDocuments({ user: result.owner._id }) : 0;
		return result;
	}
	static override(input) {
		Support.assert(input && typeof input === 'object' && !Array.isArray(input), 'Invalid overrides');
		const plan = input.plan || null;
		Support.assert(plan === null || ['free', 'pro', 'team'].includes(plan), 'Invalid override plan');
		const limits = {};
		for (const key of ['people', 'snippets', 'libraries', 'machines']) { const value = input.limits?.[key] ?? null; Support.assert(value === null || (Number.isSafeInteger(value) && value >= 0), 'Limits must be non-negative integers or blank'); limits[key] = value; }
		return { plan, limits };
	}
	static async create(body) {
		const name = Support.text(body.name);
		const email = Security.email(body.owner_email);
		const ownerName = Support.text(body.owner_name);
		let account; let user;
		await Models.mongoose.connection.transaction(async session => {
			user = await Models.User.findOneAndUpdate({ email }, { $setOnInsert: { name: ownerName, email }, $inc: { activity_sequence: 1 } }, { upsert: true, returnDocument: 'after', session }).lean();
			[account] = await Models.Account.create([{ name }], { session });
			await Models.Member.create([{ account: account._id, user: user._id, role: 'owner' }], { session });
		});
		const warnings = [];
		try { await Billing.initializeAccount(account, user); } catch { warnings.push('Billing initialization failed; account created.'); }
		try { await Auth.login(email, null, { account: String(account._id) }); } catch { warnings.push('Sign-in email failed; owner can request a new link.'); }
		return { account: await AdminAccounts.get(String(account._id)), warnings };
	}
	static async update(id, body) {
		Support.id(id);
		let relatedIds = [];
		await Models.mongoose.connection.transaction(async session => {
			const account = await Models.Account.findById(id).session(session).lean();
			Support.assert(account && !account.deletion?.requested_at, 'Account missing or deletion in progress', 409);
			Support.assert(body.revision === (account.admin_revision || 0), 'Account changed; reopen its details before saving', 409);
			const update = {};
			if (body.name !== undefined) update.name = Support.text(body.name);
			if (body.is_active !== undefined) { Support.assert(typeof body.is_active === 'boolean', 'Invalid account status'); update.is_active = body.is_active; }
			if (body.override !== undefined) update.admin_override = AdminAccounts.override(body.override);
			await Models.Account.updateOne({ _id: id }, { $set: update, $inc: { admin_revision: 1 } }, { session });
			const owner = await Models.Member.findOne({ account: id, role: 'owner' }).session(session).lean();
			if (owner && (body.owner_name !== undefined || body.owner_email !== undefined)) {
				const user = await Models.User.findById(owner.user).session(session).lean();
				const profile = { ...(body.owner_name !== undefined ? { name: Support.text(body.owner_name) } : {}), ...(body.owner_email !== undefined ? { email: Security.email(body.owner_email) } : {}) };
				const changedEmail = profile.email && profile.email !== user.email;
				await Models.User.updateOne({ _id: owner.user }, { $set: profile, ...(changedEmail ? { $inc: { auth_version: 1 } } : {}) }, { session });
				relatedIds = (await Models.Member.find({ user: owner.user, role: 'owner', account: { $ne: id } }).select('account').session(session).lean()).map(member => member.account);
				await Models.Account.updateMany({ _id: { $in: relatedIds }, 'deletion.requested_at': null }, { $inc: { admin_revision: 1 } }, { session });
				if (changedEmail) await Models.Ticket.deleteMany({ $or: [{ email: user.email }, { 'data.user': String(user._id) }] }, { session });
			}
		});
		return { ...await AdminAccounts.get(id), related: await AdminAccounts.decorate(await Models.Account.find({ _id: { $in: relatedIds }, 'deletion.requested_at': null }).lean()) };
	}
	static csvCell(value) { const text = String(value ?? ''); return '"' + (/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"'; }
	static async csv() {
		const memberships = await Models.Member.find({}).lean();
		const [users, accounts] = await Promise.all([Models.User.find({}).select('name email').lean(), Models.Account.find({}).select('name').lean()]);
		const userMap = new Map(users.map(user => [String(user._id), user])); const accountMap = new Map(accounts.map(account => [String(account._id), account]));
		return [['Account ID', 'Account', 'User ID', 'Name', 'Email', 'Role'], ...memberships.map(member => [member.account, accountMap.get(String(member.account))?.name, member.user, userMap.get(String(member.user))?.name, userMap.get(String(member.user))?.email, member.role])].map(row => row.map(AdminAccounts.csvCell).join(',')).join('\r\n');
	}
	static async requestDeletion(id, confirmation) {
		Support.id(id); Support.assert(confirmation === id, 'Type the account ID to confirm deletion');
		await Models.Account.updateOne({ _id: id, 'deletion.requested_at': null }, { $set: { is_active: false, 'deletion.requested_at': new Date(), 'deletion.stage': 'requested', 'deletion.error': '' }, $inc: { admin_revision: 1 } });
		return AdminAccounts.get(id);
	}
	static async retry(id) {
		const result = await Models.Account.updateOne({ _id: Support.id(id), 'deletion.stage': 'failed' }, { $set: { 'deletion.stage': 'requested', 'deletion.error': '' }, $inc: { admin_revision: 1 } });
		Support.assert(result.matchedCount, 'No failed deletion to retry', 409);
		return AdminAccounts.get(id);
	}
	static async cancelBilling(account, stripe = null) {
		const billing = account.billing || {};
		if (!billing.stripe_customer_id && !billing.stripe_subscription_id && !billing.stripe_free_subscription_id && !billing.scheduled_change?.schedule_id) return;
		stripe ||= Billing.stripe();
		const subscriptions = new Set([billing.stripe_subscription_id, billing.stripe_free_subscription_id].filter(Boolean));
		const schedules = new Set([billing.scheduled_change?.schedule_id].filter(Boolean));
		let customerPresent = false;
		if (billing.stripe_customer_id) { try { customerPresent = !(await stripe.customers.retrieve(billing.stripe_customer_id)).deleted; } catch (error) { if (error.code !== 'resource_missing') throw error; } }
		if (customerPresent) {
			for await (const checkout of stripe.checkout.sessions.list({ customer: billing.stripe_customer_id, status: 'open', limit: 100 })) { try { await stripe.checkout.sessions.expire(checkout.id); } catch (error) { const current = await stripe.checkout.sessions.retrieve(checkout.id); if (current.status === 'open') throw error; } }
			for await (const schedule of stripe.subscriptionSchedules.list({ customer: billing.stripe_customer_id, limit: 100 })) if (['active', 'not_started'].includes(schedule.status)) schedules.add(schedule.id);
			for await (const subscription of stripe.subscriptions.list({ customer: billing.stripe_customer_id, status: 'all', limit: 100 })) if (!['canceled', 'incomplete_expired'].includes(subscription.status)) subscriptions.add(subscription.id);
		}
		for (const id of schedules) { try { const schedule = await stripe.subscriptionSchedules.retrieve(id); if (['active', 'not_started'].includes(schedule.status)) await stripe.subscriptionSchedules.cancel(id, { invoice_now: false, prorate: false }); } catch (error) { if (error.code !== 'resource_missing') throw error; } }
		for (const id of subscriptions) { try { const subscription = await stripe.subscriptions.retrieve(id); if (!['canceled', 'incomplete_expired'].includes(subscription.status)) await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false }); } catch (error) { if (error.code !== 'resource_missing') throw error; } }
	}
	static async removeDomain(account, options = {}) {
		const ids = new Set([account.white_label?.cloudflare_hostname_id].filter(Boolean));
		// Recover a hostname whose creation succeeded before its ID was persisted.
		let records = [];
		if (account.white_label?.hostname) { try { records = await (options.listHostnames || WhiteLabel.listHostnames)(account.white_label.hostname); } catch (error) { if (error.status !== 404) throw error; } }
		for (const record of records) {
			if (record.hostname === account.white_label.hostname && record.custom_metadata?.catalog === Billing.catalogName) ids.add(record.id);
		}
		for (const id of ids) await (options.deleteHostname || WhiteLabel.deleteHostname)(id);
	}
	static tickets(account) { return { $or: [{ account: account._id }, { 'data.account': { $in: [account._id, String(account._id)] } }, { 'data.grant': { $in: [...(account.deletion.grants || []), ...(account.deletion.grants || []).map(String)] } }] }; }
	static backups(account) { return { $or: [{ 'payload.account': { $in: [account._id, String(account._id)] } }, { source_collection: 'accounts', 'payload._id': { $in: [account._id, String(account._id)] } }] }; }
	static async purge(id, options = {}) {
		const token = randomUUID();
		const account = await Models.Account.findOneAndUpdate({ _id: id, 'deletion.requested_at': { $ne: null }, 'deletion.stage': { $ne: 'failed' }, $or: [{ 'deletion.lease_until': null }, { 'deletion.lease_until': { $lt: new Date() } }] }, { $set: { 'deletion.lease': token, 'deletion.lease_until': new Date(Date.now() + 300000) } }, { returnDocument: 'after' }).select('+billing.stripe_customer_id +billing.stripe_subscription_id +billing.stripe_free_subscription_id +billing.scheduled_change.schedule_id +white_label.cloudflare_hostname_id').lean();
		if (!account) return { pending: true };
		const lock = { _id: account._id, 'deletion.lease': token };
		let stage = 'draining';
		const heartbeat = setInterval(() => Models.Account.updateOne(lock, { $set: { 'deletion.lease_until': new Date(Date.now() + 300000) } }).catch(() => console.error('Purge lease renewal failed')), 30000); heartbeat.unref();
		try {
			if (await Models.AccountLease.exists({ account: account._id, expires: { $gt: new Date() } })) return { pending: true };
			const memberships = await Models.Member.find({ account: account._id }).select('user').lean();
			const grants = await Models.Integration.find({ account: account._id }).select('_id user').lean();
			const devices = await Models.Device.find({ account: account._id }).select('user').lean();
			const formerUsers = new Set();
			for (const name of ['Library', 'Conflict', 'Operation', 'ApiAudit']) for (const value of await Models[name].distinct(name === 'Library' ? 'creator' : 'user', { account: account._id })) if (value) formerUsers.add(String(value));
			for (const [name, field] of [['Group', 'users'], ['Library', 'members'], ['Library', 'purge_readers'], ['Ticket', 'data.user']]) for (const value of await Models[name].distinct(field, { account: account._id })) if (/^[a-f0-9]{24}$/.test(String(value))) formerUsers.add(String(value));
			const historical = await Models.MigrationBackup.find(AdminAccounts.backups(account)).select('payload.user payload.creator').lean();
			await Models.Account.updateOne(lock, { $addToSet: { 'deletion.users': { $each: [...memberships, ...grants, ...devices, ...[...formerUsers].map(user => ({ user })), ...historical.map(row => row.payload)].map(row => row.user || row.creator).filter(Boolean) }, 'deletion.grants': { $each: grants.map(grant => grant._id) } } });
			account.deletion = (await Models.Account.findOne(lock).select('deletion').lean()).deletion;
			stage = 'external'; await Models.Account.updateOne(lock, { $set: { 'deletion.stage': stage }, $inc: { admin_revision: 1 } });
			await (options.cancelBilling || AdminAccounts.cancelBilling)(account);
			await AdminAccounts.removeDomain(account, options);
			const directory = join(options.assetsRoot || WhiteLabel.assetsRoot(), String(account._id));
			await rm(directory, { recursive: true, force: true });
			stage = 'database'; await Models.Account.updateOne(lock, { $set: { 'deletion.stage': stage }, $inc: { admin_revision: 1 } });
			for (const name of AdminAccounts.owned) await Models[name].deleteMany({ account: account._id });
			await Models.IntegrationToken.deleteMany({ grant: { $in: account.deletion.grants } });
			await Models.Ticket.deleteMany(AdminAccounts.tickets(account));
			await Models.MigrationBackup.deleteMany(AdminAccounts.backups(account));
			stage = 'users';
			for (const userId of account.deletion.users) await Models.mongoose.connection.transaction(async session => {
				const user = await Models.User.findOneAndUpdate({ _id: userId }, { $inc: { activity_sequence: 1 } }, { session, returnDocument: 'after' }).lean();
				if (!user) return;
				const memberships = await Models.Member.find({ user: userId }).select('account').session(session).lean();
				if (await Models.Account.exists({ _id: { $in: memberships.map(member => member.account) } }).session(session)) return;
				await Models.Member.deleteMany({ user: userId }, { session });
				await Models.Passkey.deleteMany({ user: userId }, { session });
				await Models.Ticket.deleteMany({ $or: [{ email: user.email }, { 'data.user': { $in: [userId, String(userId)] } }] }, { session });
				await Models.User.deleteOne({ _id: userId }, { session });
			});
			// connect-mongo stores sessions as JSON strings. Parse, never match a
			// substring that could accidentally delete another user's session.
			const orphanIds = new Set();
			for (const userId of account.deletion.users) if (!await Models.User.exists({ _id: userId })) orphanIds.add(String(userId));
			for await (const row of Models.mongoose.connection.collection('web_sessions').find({})) {
				let session; try { session = typeof row.session === 'string' ? JSON.parse(row.session) : row.session; } catch { continue; }
				if (orphanIds.has(String(session?.user)) || orphanIds.has(String(session?.pending_factor?.user))) await Models.mongoose.connection.collection('web_sessions').deleteOne({ _id: row._id });
			}
			stage = 'verification';
			for (const name of AdminAccounts.owned) Support.assert(!await Models[name].exists({ account: account._id }), 'Account records remain', 409);
			Support.assert(!await Models.Ticket.exists(AdminAccounts.tickets(account)) && !await Models.IntegrationToken.exists({ grant: { $in: account.deletion.grants } }) && !await Models.MigrationBackup.exists(AdminAccounts.backups(account)), 'Account references remain', 409);
			await access(directory).then(() => { throw new Error('Account files remain'); }, error => { if (error.code !== 'ENOENT') throw error; });
			await Models.AccountLease.deleteMany({ account: account._id });
			await Models.Account.deleteOne(lock);
			return { deleted: String(account._id) };
		} catch (error) {
			await Models.Account.updateOne(lock, { $set: { 'deletion.stage': 'failed', 'deletion.error': `Cleanup failed during ${stage}; correct the service configuration and retry.` }, $inc: { admin_revision: 1 } });
			console.error(`Account purge failed during ${stage}: ${error.code || error.name}`);
			throw error;
		} finally { clearInterval(heartbeat); await Models.Account.updateOne(lock, { $unset: { 'deletion.lease': '', 'deletion.lease_until': '' } }); }
	}
	static async recover() {
		const accounts = await Models.Account.find({ 'deletion.requested_at': { $ne: null }, 'deletion.stage': { $ne: 'failed' } }).select('_id').limit(25).lean();
		for (const account of accounts) { try { await AdminAccounts.purge(account._id); } catch { /* Failure is durable and visible to the administrator. */ } }
		return { checked: accounts.length };
	}
}
