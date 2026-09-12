import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Account, Change, Group, Member } from '../model/index.js';

export class Fault extends Error {
	constructor(status, message) { super(message); this.status = status; }
}
export class Support {
	static assert(value, message, status = 400) { if (!value) throw new Fault(status, message); }
	static token() { return randomBytes(32).toString('base64url'); }
	static hash(value) { return createHash('sha256').update(value).digest('hex'); }
	static text(value, max = 100) { Support.assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'Invalid text'); return value.trim(); }
	static id(value) { Support.assert(typeof value === 'string' && /^[a-f0-9]{24}$/.test(value), 'Invalid ID'); return value; }
	static equal(a, b) { return String(a) === String(b); }
	static async context(user, account, session) {
		Support.id(String(account));
		const member = await Member.findOne({ user, account }).session(session || null).lean();
		Support.assert(member, 'Account access denied', 403);
		const groups = await Group.find({ account, users: user }).session(session || null).lean();
		return { user: String(user), account: String(account), role: member.role, groups: groups.map(group => String(group._id)) };
	}
	static admin(ctx) { return ['owner', 'admin'].includes(ctx.role); }
	static access(ctx, library) {
		if (!Support.equal(ctx.account, library.account) || library.deleted) return { read: false, edit: false, manage: false };
		const creator = Support.equal(ctx.user, library.creator);
		const admin = library.shared && Support.admin(ctx);
		const assigned = library.shared && (library.members.some(id => Support.equal(id, ctx.user)) || library.groups.some(id => ctx.groups.includes(String(id))));
		return { read: !!(creator || admin || assigned), edit: !!(creator || admin || (assigned && library.editable)), manage: !!(creator || admin) };
	}
	static async change(account, library, kind, session) {
		const result = await Account.findOneAndUpdate({ _id: account }, { $inc: { sequence: 1 } }, { returnDocument: 'after', session }).lean();
		Support.assert(result, 'Account missing', 404);
		await Change.create([{ account, sequence: result.sequence, library, kind }], { session });
		return result.sequence;
	}
}
export class Yaml {
	static async run(yaml, edits = []) {
		Support.assert(typeof yaml === 'string' && Buffer.byteLength(yaml) <= 1048576, 'YAML exceeds 1 MiB');
		return new Promise((resolve, reject) => {
			const child = spawn(process.env.YAML_HELPER || '/usr/local/bin/typerelay-yaml', [], { stdio: ['pipe', 'pipe', 'pipe'] });
			let output = '';
			let error = '';
			const timer = setTimeout(() => { child.kill(); reject(new Fault(422, 'YAML validation timed out')); }, 10000);
			child.on('error', reject);
			child.stdout.on('data', data => { output += data; if (output.length > 8 * 1048576) child.kill(); });
			child.stderr.on('data', data => { if (error.length < 2048) error += data; });
			child.on('close', code => {
				clearTimeout(timer);
				try {
					Support.assert(code === 0, error || 'YAML helper failed', 422);
					const result = JSON.parse(output);
					Support.assert(!result.error, result.error, 422);
					resolve(result);
				} catch (failure) { reject(failure); }
			});
			child.stdin.on('error', () => {});
			child.stdin.end(JSON.stringify({ yaml, edits }) + '\n');
		});
	}
}
