import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mongoose, Account, AccountLease } from '../model/index.js';

// A request/job holds its lease until all its writes finish. Deletion closes the
// gate first and drains leases before touching external resources or child rows.
export class AccountAccess {
	static storage = new AsyncLocalStorage();
	static available = { is_active: { $ne: false }, 'deletion.requested_at': null };
	static assert(account) {
		if (!account || account.is_active === false || account.deletion?.requested_at) throw Object.assign(new Error('Account unavailable'), { status: 403, code: 'account_unavailable' });
		return account;
	}
	static async fence(id, session, allowSuspended = false) {
		const result = await Account.updateOne({ _id: id, ...(allowSuspended ? { 'deletion.requested_at': null } : AccountAccess.available) }, { $inc: { activity_sequence: 1 } }, { session });
		AccountAccess.assert(result.matchedCount ? {} : null);
	}
	static async write(id, action) { return mongoose.connection.transaction(async session => { await AccountAccess.fence(id, session); return action(session); }); }
	static async acquire(id, allowSuspended = false) {
		const scope = AccountAccess.storage.getStore();
		if (!scope || scope.accounts.has(String(id))) return;
		const token = randomUUID();
		await mongoose.connection.transaction(async session => {
			await AccountAccess.fence(id, session, allowSuspended);
			await AccountLease.create([{ account: id, token, expires: new Date(Date.now() + 300000) }], { session });
		});
		scope.accounts.set(String(id), token);
	}
	static async release(scope) {
		clearInterval(scope.timer);
		if (!scope.accounts.size) return;
		await AccountLease.deleteMany({ token: { $in: [...scope.accounts.values()] } });
	}
	static scope() {
		const scope = { accounts: new Map() };
		scope.timer = setInterval(() => { if (scope.accounts.size) AccountLease.updateMany({ token: { $in: [...scope.accounts.values()] } }, { $set: { expires: new Date(Date.now() + 300000) } }).catch(() => console.error('Account lease renewal failed')); }, 30000);
		scope.timer.unref();
		return scope;
	}
	static middleware(req, res, next) {
		const scope = AccountAccess.scope();
		// Do not release on connection close: the handler can still be writing.
		res.once('finish', () => { setImmediate(() => AccountAccess.release(scope).catch(() => console.error('Account lease release failed'))); });
		res.once('close', () => { if (!res.writableFinished) clearInterval(scope.timer); });
		AccountAccess.storage.run(scope, next);
	}
	static async run(id, action, allowSuspended = false) {
		if (AccountAccess.storage.getStore()) { await AccountAccess.acquire(id, allowSuspended); return action(); }
		const scope = AccountAccess.scope();
		return AccountAccess.storage.run(scope, async () => { try { await AccountAccess.acquire(id, allowSuspended); return await action(); } finally { await AccountAccess.release(scope); } });
	}
}
