import { AccountAccess } from './account_access.js';
import { Billing } from './billing.js';
import { Account, Member, User } from '../model/index.js';

export class Helpmonks {
	static maxAttempts = 12;
	static retryDelay = 5 * 60 * 1000;
	static queue(accountId, session, now = new Date()) {
		return Account.updateOne({ _id: accountId, 'billing.helpmonks_sequence.status': null }, { $set: { 'billing.helpmonks_sequence.status': 'pending', 'billing.helpmonks_sequence.attempts': 0, 'billing.helpmonks_sequence.next_attempt_at': now } }, { session });
	}
	static configuration(options = {}) {
		const env = options.env || process.env;
		return { apiUrl: String(options.apiUrl ?? (env.HELPMONKS_SIGNUP_API_URL || env.HELPMONKS_API_URL || '')).trim().replace(/\/+$/, ''), hostId: String(options.hostId ?? env.HELPMONKS_SIGNUP_HOST_ID ?? '').trim(), sequenceId: String(options.sequenceId ?? env.HELPMONKS_SIGNUP_SEQUENCE_ID ?? '').trim() };
	}
	static configurationErrors(config) {
		const errors = [];
		if (!/^https?:\/\//i.test(config.apiUrl)) errors.push('api_url');
		if (!/^[a-f0-9]{24}$/i.test(config.hostId)) errors.push('host_id');
		if (!/^[a-f0-9]{24}$/i.test(config.sequenceId)) errors.push('sequence_id');
		return errors;
	}
	static async owner(accountId, options = {}) {
		const member = await (options.memberModel || Member).findOne({ account: accountId, role: 'owner' }).lean();
		if (!member) throw new Error(`TypeRelay account '${accountId}' has no owner`);
		const user = await (options.userModel || User).findById(member.user).lean();
		if (!user?.email) throw new Error(`TypeRelay account '${accountId}' owner has no email`);
		return user;
	}
	static async enroll(user, config, options = {}) {
		const response = await (options.fetch || fetch)(`${config.apiUrl}/api/v1/trusted/company_user/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: { email: String(user.email).trim().toLowerCase(), labels: [] }, host_id: config.hostId, campaign_id: config.sequenceId }), signal: AbortSignal.timeout(options.timeout || 10000) });
		const body = await response.json();
		if (!response.ok || !body.success || !body.results?._id || !body.sequence_enrollment || String(body.sequence_enrollment.campaign_id || '') !== config.sequenceId) throw new Error(`Helpmonks signup sequence enrollment failed${response.ok ? ': incomplete response' : ` with HTTP ${response.status}`}`);
		return String(body.results._id);
	}
	static async enrollPendingUsers(now = new Date(), options = {}) {
		if (!Billing.hosted()) return { checked: 0, enrolled: 0, retrying: 0, failed: 0, configured: false };
		const config = Helpmonks.configuration(options);
		const invalid = Helpmonks.configurationErrors(config);
		if (invalid.length) return { checked: 0, enrolled: 0, retrying: 0, failed: 0, configured: false, invalid };
		const accountModel = options.accountModel || Account;
		const maxAttempts = options.maxAttempts || Helpmonks.maxAttempts;
		const retryDelay = options.retryDelay || Helpmonks.retryDelay;
		const limit = options.limit || 25;
		const expired = await accountModel.updateMany({ ...AccountAccess.available, 'billing.helpmonks_sequence.status': 'pending', 'billing.helpmonks_sequence.attempts': { $gte: maxAttempts }, 'billing.helpmonks_sequence.next_attempt_at': { $lte: now } }, { $set: { 'billing.helpmonks_sequence.status': 'failed', 'billing.helpmonks_sequence.last_error': 'Helpmonks signup sequence attempt expired before completion' } });
		const summary = { checked: expired.modifiedCount, enrolled: 0, retrying: 0, failed: expired.modifiedCount, configured: true };
		for (let index = 0; index < limit; index++) {
			const account = await accountModel.findOneAndUpdate({ ...AccountAccess.available, 'billing.helpmonks_sequence.status': 'pending', 'billing.helpmonks_sequence.attempts': { $lt: maxAttempts }, 'billing.helpmonks_sequence.next_attempt_at': { $lte: now } }, { $inc: { 'billing.helpmonks_sequence.attempts': 1 }, $set: { 'billing.helpmonks_sequence.next_attempt_at': new Date(now.getTime() + retryDelay) } }, { returnDocument: 'after' }).lean();
			if (!account) break;
			summary.checked++;
			const sequence = account.billing.helpmonks_sequence;
			const claim = { _id: account._id, 'billing.helpmonks_sequence.status': 'pending', 'billing.helpmonks_sequence.attempts': sequence.attempts, 'billing.helpmonks_sequence.next_attempt_at': sequence.next_attempt_at };
			try {
				const enroll = async () => {
					const owner = await Helpmonks.owner(account._id, options);
					return owner.email_confirm_by ? null : Helpmonks.enroll(owner, config, options);
				};
				const contactId = options.accountModel ? await enroll() : await AccountAccess.run(account._id, enroll);
				// A legacy trial may have queued before confirmation. Deferral does not use up an attempt.
				if (contactId === null) { const result = await accountModel.updateOne(claim, { $inc: { 'billing.helpmonks_sequence.attempts': -1 } }); if (result.modifiedCount) summary.deferred = (summary.deferred || 0) + 1; continue; }
				const result = await accountModel.updateOne(claim, { $set: { 'billing.helpmonks_sequence.status': 'completed', 'billing.helpmonks_sequence.contact_id': contactId, 'billing.helpmonks_sequence.enrolled_at': now, 'billing.helpmonks_sequence.last_error': '' } });
				if (result.modifiedCount) summary.enrolled++;
			} catch (error) {
				const failed = sequence.attempts >= maxAttempts;
				const result = await accountModel.updateOne(claim, { $set: { 'billing.helpmonks_sequence.status': failed ? 'failed' : 'pending', 'billing.helpmonks_sequence.last_error': String(error.message || error).slice(0, 500) } });
				if (result.matchedCount) summary[failed ? 'failed' : 'retrying']++;
			}
		}
		return summary;
	}
}
