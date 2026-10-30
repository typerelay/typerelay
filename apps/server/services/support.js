import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Account, Change, Group, Member } from '../model/index.js';
import { Billing } from './billing.js';
import { AccountAccess } from './account_access.js';

export class Fault extends Error {
	constructor(status, message, code = '', details = null) { super(message); this.status = status; this.code = code; this.details = details; }
}
export class Support {
	static assert(value, message, status = 400) { if (!value) throw new Fault(status, message); }
	static token() { return randomBytes(32).toString('base64url'); }
	static hash(value) { return createHash('sha256').update(value).digest('hex'); }
	static text(value, max = 100) { Support.assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'Invalid text'); return value.trim(); }
	static id(value) { Support.assert(typeof value === 'string' && /^[a-f0-9]{24}$/.test(value), 'Invalid ID'); return value; }
	static equal(a, b) { return String(a) === String(b); }
	// Transactions require primary reads; all other reads keep the schema default.
	static transactionRead(query, session) { return session?.inTransaction() ? query.session(session).read('primary') : query; }
	static async context(user, account, session) {
		Support.id(String(account));
		const member = await Support.transactionRead(Member.findOne({ user, account }).session(session || null).lean(), session);
		Support.assert(member, 'Account access denied', 403);
		// Reads only need the availability check below; deletion drains leases held by writes.
		if (!AccountAccess.storage.getStore()?.read) await (session ? AccountAccess.fence(account, session) : AccountAccess.acquire(account));
		const record = await Support.transactionRead(Account.findById(account).session(session || null).lean(), session);
		Support.assert(record, 'Account missing', 404);
		AccountAccess.assert(record);
		const entitlements = Billing.entitlements(record);
		if (!entitlements.capabilities.team && member.role !== 'owner') throw new Fault(403, 'This account requires Pro or Team', 'plan_required', { capability: 'people', upgrade_url: '/#settings-subscription' });
		if (!await Billing.memberAllowed(record, member, session)) throw new Fault(403, 'This membership exceeds the account seat capacity. Ask the owner to add seats or remove extra members.', 'plan_limit', { resource: 'people', upgrade_url: '/#settings-subscription' });
		const groups = await Support.transactionRead(Group.find({ account, users: user }).session(session || null).lean(), session);
		return { user: String(user), account: String(account), role: member.role, groups: groups.map(group => String(group._id)), plan: record.plan || 'free', entitlements };
	}
	static admin(ctx) { return ['owner', 'admin'].includes(ctx.role); }
	static access(ctx, library) {
		if (!Support.equal(ctx.account, library.account) || library.state === 'purged') return { read: false, edit: false, manage: false };
		const creator = Support.equal(ctx.user, library.creator);
		const admin = library.shared && Support.admin(ctx);
		const assigned = library.shared && (library.members.some(id => Support.equal(id, ctx.user)) || library.groups.some(id => ctx.groups.includes(String(id))));
		return { read: !!(creator || admin || assigned), edit: !!(creator || admin || (assigned && library.editable)), manage: !!(creator || admin) };
	}
	static changeHistory = 10000;
	static async change(account, library, kind, session) {
		const result = await Account.findOneAndUpdate({ _id: account, ...AccountAccess.available }, { $inc: { sequence: 1 } }, { returnDocument: 'after', session }).lean();
		Support.assert(result, 'Account missing', 404);
		await Change.create([{ account, sequence: result.sequence, library, kind }], { session });
		// The first versioned change expires legacy cursors whose tombstones lack a sequence.
		await Account.updateOne({ _id: account }, { $set: { sync_history_version: 1 }, $max: { sync_floor: result.sync_history_version === 1 ? Math.max(0, result.sequence - Support.changeHistory) : result.sequence } }, { session });
		if (result.sequence > Support.changeHistory) await Change.deleteMany({ account, sequence: { $lte: result.sequence - Support.changeHistory } }, { session });
		return result.sequence;
	}
}
export class Yaml {
	static async run(yaml, edits = []) { return Yaml.execute({ yaml, edits }); }
	static async export(matches) { return Yaml.execute({ matches, export: true }); }
	static async validate(matches) { return Yaml.execute({ matches }); }
	// The helper answers each input line separately: one process validates every entry on its own.
	static async each(matches) { return matches.length ? Yaml.execute(matches.map(match => ({ matches: [match] })), true) : []; }
	static async execute(payload, lines = false) {
		const input = (lines ? payload : [payload]).map(item => JSON.stringify(item) + '\n').join('');
		Support.assert(Buffer.byteLength(input) <= 16 * 1048576, 'Validation input too large');
		return new Promise((resolve, reject) => {
			const child = spawn(process.env.YAML_HELPER || '/usr/local/bin/typerelay-yaml', [], { stdio: ['pipe', 'pipe', 'pipe'] });
			let output = '';
			let error = '';
			const timer = setTimeout(() => { child.kill(); reject(new Fault(422, 'YAML validation timed out')); }, 10000);
			child.on('error', reject);
			child.stdout.on('data', data => { output += data; if (output.length > 16 * 1048576) child.kill(); });
			child.stderr.on('data', data => { if (error.length < 2048) error += data; });
			child.on('close', code => {
				clearTimeout(timer);
				try {
					Support.assert(code === 0, error || 'YAML helper failed', 422);
					if (lines) { const results = output.trim().split('\n').map(line => JSON.parse(line)); Support.assert(results.length === payload.length, 'YAML helper failed', 422); return resolve(results); }
					const result = JSON.parse(output);
					Support.assert(!result.error, result.error, 422);
					resolve(result);
				} catch (failure) { reject(failure); }
			});
			child.stdin.on('error', () => {});
			child.stdin.end(input);
		});
	}
}
