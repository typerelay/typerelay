import { TestDatabase } from './database.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Account, AccountLease, mongoose } from '../model/index.js';
import { WhiteLabel } from '../services/white_label.js';
import { Billing } from '../services/billing.js';
import { AdminAccounts } from '../services/admin_accounts.js';

class Fixture {
	static environment = {};
	static dns = async () => ['custom.typerelay.com.'];
	static txt = async name => (await Account.find({ 'white_label.hostname': name.replace(/^_typerelay\./, '') }).lean()).map(account => [`typerelay-domain-verification=${account._id}`]);
	static barrier() { let start; let release; const ready = new Promise(resolve => { start = resolve; }); const gate = new Promise(resolve => { release = resolve; }); return { ready, release, wait: async () => { start(); await gate; } }; }
	static async account(hostname = `${randomUUID()}.example.test`) { const account = await Account.create({ name: 'Domain lifecycle', plan: 'team', billing: { status: 'active' } }); await WhiteLabel.configure(account._id, hostname); return WhiteLabel.account(account._id, true); }
	static expire(account) { return Account.updateOne({ _id: account._id }, { $set: { 'white_label.operation_until': new Date(0) } }); }
	static response(result, status = 200) { return { ok: status < 400, status, json: async () => ({ success: status < 400, result, ...(status >= 400 ? { errors: [{ message: 'Provider rejected request' }] } : {}) }) }; }
	static busy(error) { return error.status === 409 && error.code === 'domain_busy'; }
	static unresolved(error) { return error.status === 409 && error.code === 'domain_reconciliation_required'; }
	static async released(account) { const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.hostname, ''); assert.equal(current.white_label.dns_verified_at, null); assert.equal(current.white_label.cloudflare_hostname_id, ''); assert.equal(current.white_label.provider_action, ''); assert.equal(current.white_label.last_error, ''); assert.equal(current.white_label.cloudflare_checked_at, null); return current; }
}

// A provider record has its own immutable ID; DELETE always targets that ID.
class Provider {
	records = []; calls = []; beforeCreate; afterCreate; beforeGet; beforeDelete; afterDelete;
	options() { return { fetch: this.fetch, resolveCname: Fixture.dns, resolveTxt: Fixture.txt }; }
	count(method) { return this.calls.filter(call => call.method === method).length; }
	fetch = async (url, input) => {
		const parsed = new URL(url); const method = input.method; const id = parsed.pathname.split('/').at(-1); const body = input.body && JSON.parse(input.body);
		assert.equal(parsed.origin, 'https://api.cloudflare.com');
		this.calls.push({ method, id, body });
		if (method === 'POST') {
			const record = { ...body, id: randomUUID(), status: 'active', ssl: { status: 'active' } };
			await this.beforeCreate?.(record);
			this.records.push(record);
			await this.afterCreate?.(record);
			return Fixture.response(record);
		}
		if (parsed.search) return Fixture.response(this.records.filter(record => record.hostname === parsed.searchParams.get('hostname[exact]')));
		const record = this.records.find(record => record.id === id);
		if (method === 'GET') { await this.beforeGet?.(record); return Fixture.response(record, record ? 200 : 404); }
		assert.equal(method, 'DELETE');
		await this.beforeDelete?.(record);
		this.records = this.records.filter(record => record.id !== id);
		await this.afterDelete?.(record);
		return Fixture.response({ id }, record ? 200 : 404);
	};
}

before(async () => {
	for (const key of ['TYPERELAY_HOSTED_EDITION', 'BILLING_ENABLED', 'WHITE_LABEL_ENABLED', 'WHITE_LABEL_CNAME_TARGET', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID']) Fixture.environment[key] = process.env[key];
	Object.assign(process.env, { TYPERELAY_HOSTED_EDITION: 'true', BILLING_ENABLED: 'true', WHITE_LABEL_ENABLED: 'true', WHITE_LABEL_CNAME_TARGET: 'custom.typerelay.com', CLOUDFLARE_API_TOKEN: 'fixture', CLOUDFLARE_ZONE_ID: 'fixture' });
	await mongoose.connect(TestDatabase.uri(process.env.MONGO_URI, 'typerelay_domain_lifecycle_test'));
	await TestDatabase.drop(mongoose.connection, 'typerelay_domain_lifecycle_test');
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
after(async () => {
	await TestDatabase.drop(mongoose.connection, 'typerelay_domain_lifecycle_test');
	await mongoose.disconnect();
	for (const [key, value] of Object.entries(Fixture.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

for (const mutation of ['remove', 'configure']) for (const valid of [true, false]) test(`paused ${valid ? 'successful' : 'failed'} DNS is fenced by ${mutation}`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const hostname = account.white_label.hostname; const provider = new Provider(); const barrier = Fixture.barrier();
	const verify = WhiteLabel.verify(account._id, { ...provider.options(), resolveCname: async () => { await barrier.wait(); return valid ? Fixture.dns() : []; } });
	const rejected = assert.rejects(verify, Fixture.busy);
	await barrier.ready;
	try {
		await assert.rejects(WhiteLabel.remove(account._id, provider.options()), Fixture.busy);
		await assert.rejects(WhiteLabel.configure(account._id, 'replacement.example.test', provider.options()), Fixture.busy);
		await Fixture.expire(account);
		await Account.updateOne({ _id: account._id }, { $set: { 'white_label.logo': { url: '/concurrent-logo.png' } } });
		if (mutation === 'remove') await WhiteLabel.remove(account._id, provider.options());
		else await WhiteLabel.configure(account._id, 'replacement.example.test', provider.options());
	} finally { barrier.release(); await rejected; }
	const current = await WhiteLabel.account(account._id, true);
	assert.equal(current.white_label.hostname, mutation === 'remove' ? '' : 'replacement.example.test');
	assert.equal(current.white_label.dns_verified_at, null);
	assert.equal(current.white_label.logo.url, '/concurrent-logo.png'); assert.equal(current.white_label.last_error, '');
	assert.equal(provider.count('POST'), 0);
	const next = await Fixture.account(hostname); await WhiteLabel.verify(next._id, provider.options());
	await WhiteLabel.remove(account._id, provider.options());
	assert.equal(provider.count('DELETE'), 0);
	assert.equal((await WhiteLabel.settings(next._id)).active, true);
});

test('paused CREATE holds its claim through remove, lease expiry, exact token recovery and cleanup', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const next = await Fixture.account(account.white_label.hostname); const provider = new Provider(); const barrier = Fixture.barrier();
	provider.beforeCreate = () => barrier.wait();
	const verify = WhiteLabel.verify(account._id, provider.options()); const rejected = assert.rejects(verify, Fixture.busy);
	await barrier.ready;
	try {
		const creating = await WhiteLabel.account(account._id, true);
		assert.equal(creating.white_label.provider_action, 'creating'); assert.ok(creating.white_label.dns_verified_at); assert.ok(creating.white_label.claim_token);
		assert.deepEqual(provider.calls[0].body.custom_metadata, { catalog: Billing.catalogName, account: String(account._id), claim_token: creating.white_label.claim_token });
		await assert.rejects(WhiteLabel.verify(account._id, provider.options()), Fixture.busy);
		await assert.rejects(WhiteLabel.remove(account._id, provider.options()), Fixture.busy);
		await assert.rejects(WhiteLabel.configure(account._id, 'other.example.test', provider.options()), Fixture.busy);
		await assert.rejects(WhiteLabel.verify(next._id, provider.options()), error => error.code === 'hostname_conflict');
		await Fixture.expire(account);
		await assert.rejects(WhiteLabel.remove(account._id, provider.options()), Fixture.unresolved);
		await assert.rejects(WhiteLabel.refresh(account._id, provider.options()), Fixture.unresolved);
		assert.equal(provider.count('POST'), 1);
		assert.ok(await WhiteLabel.claimed(next._id, account.white_label.hostname));
	} finally { barrier.release(); await rejected; }
	provider.beforeCreate = undefined;
	assert.equal((await WhiteLabel.refresh(account._id, provider.options())).active, true);
	assert.equal(provider.count('POST'), 1);
	const oldId = provider.records[0].id;
	await WhiteLabel.remove(account._id, provider.options()); await Fixture.released(account);
	assert.equal(provider.count('DELETE'), 1);
	assert.equal((await WhiteLabel.verify(next._id, provider.options())).active, true);
	assert.notEqual(provider.records[0].id, oldId);
	await WhiteLabel.remove(account._id, provider.options()); assert.equal(provider.count('DELETE'), 1);
});

test('unknown CREATE never replays POST or expires its durable marker, even during reconcile or purge', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); provider.beforeCreate = async () => { throw new Error('Transport outcome unknown'); };
	await assert.rejects(WhiteLabel.verify(account._id, provider.options()), Fixture.unresolved);
	for (const action of ['verify', 'refresh', 'remove']) await assert.rejects(WhiteLabel[action](account._id, provider.options()), Fixture.unresolved);
	await assert.rejects(WhiteLabel.configure(account._id, 'unknown-replacement.example.test', provider.options()), Fixture.unresolved);
	await Account.updateOne({ _id: account._id }, { $set: { 'white_label.next_check_at': new Date(0) } });
	const result = await WhiteLabel.reconcile(provider.options()); assert.ok(result.failed >= 1);
	await Account.updateOne({ _id: account._id }, { $set: { is_active: false, 'deletion.requested_at': new Date(), 'deletion.stage': 'database', 'deletion.lease': 'expired', 'deletion.lease_until': new Date(0) } });
	await AccountLease.create({ account: account._id, token: randomUUID(), expires: new Date(0) });
	await assert.rejects(AdminAccounts.purge(account._id, { ...provider.options(), cancelBilling: async () => {} }), Fixture.unresolved);
	const current = await WhiteLabel.account(account._id, true);
	assert.ok(current); assert.ok(current.white_label.dns_verified_at); assert.equal(current.white_label.provider_action, 'creating'); assert.equal(current.white_label.claim_token, account.white_label.claim_token);
	assert.equal(provider.count('POST'), 1); assert.equal(provider.count('DELETE'), 0);
});

test('CREATE accepted before transport loss is recovered only from its exact tagged record', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); provider.afterCreate = async () => { throw new Error('Response lost'); };
	await assert.rejects(WhiteLabel.verify(account._id, provider.options()), Fixture.unresolved);
	assert.equal(provider.records.length, 1);
	assert.equal((await WhiteLabel.refresh(account._id, provider.options())).active, true);
	assert.equal(provider.count('POST'), 1);
});

test('CREATE completed before a failed bind is recovered without another POST', { timeout: 15000 }, async t => {
	const account = await Fixture.account(); const provider = new Provider(); const save = WhiteLabel.saveState;
	const mocked = t.mock.method(WhiteLabel, 'saveState', async (current, state) => { if (state.cloudflare_hostname_id) throw new Error('Bind interrupted'); return save.call(WhiteLabel, current, state); });
	await assert.rejects(WhiteLabel.verify(account._id, provider.options()), /Bind interrupted/);
	mocked.mock.restore();
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.provider_action, 'creating'); assert.equal(current.white_label.cloudflare_hostname_id, '');
	assert.equal((await WhiteLabel.refresh(account._id, provider.options())).active, true); assert.equal(provider.count('POST'), 1);
});

test('concurrent verify on one account performs one POST', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	const results = await Promise.allSettled([WhiteLabel.verify(account._id, provider.options()), WhiteLabel.verify(account._id, provider.options())]);
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
	assert.equal(results.filter(result => result.status === 'rejected' && Fixture.busy(result.reason)).length, 1);
	assert.equal(provider.count('POST'), 1);
});

for (const mismatch of ['account', 'claim_token', 'hostname', 'catalog', 'catalog-only', 'ambiguous']) test(`CREATE recovery rejects ${mismatch} records without adopting or deleting`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	provider.afterCreate = async record => {
		if (mismatch === 'hostname') record.hostname = 'foreign-host.example.test';
		else if (mismatch === 'catalog-only') record.custom_metadata = { catalog: Billing.catalogName };
		else if (mismatch === 'ambiguous') { provider.records.push({ ...record, id: randomUUID() }); throw new Error('Lost response'); }
		else record.custom_metadata[mismatch] = 'foreign';
	};
	await assert.rejects(WhiteLabel.verify(account._id, provider.options()), Fixture.unresolved);
	await assert.rejects(WhiteLabel.refresh(account._id, provider.options()), Fixture.unresolved);
	await assert.rejects(WhiteLabel.remove(account._id, provider.options()), Fixture.unresolved);
	const current = await WhiteLabel.account(account._id, true);
	assert.equal(current.white_label.cloudflare_hostname_id, ''); assert.equal(current.white_label.provider_action, 'creating'); assert.ok(current.white_label.dns_verified_at);
	assert.equal(provider.count('POST'), 1); assert.equal(provider.count('DELETE'), 0);
});

for (const mismatch of ['account', 'claim_token', 'hostname', 'catalog', 'catalog-only', 'id', 'missing-response']) test(`known ID with ${mismatch} provider response is never deleted or relabeled`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const id = provider.records[0].id;
	if (mismatch === 'hostname') provider.records[0].hostname = 'foreign.example.test';
	else if (mismatch === 'catalog-only') provider.records[0].custom_metadata = { catalog: Billing.catalogName };
	else if (mismatch === 'id') provider.beforeGet = async record => { record.id = 'other-id'; };
	else if (mismatch === 'missing-response') provider.fetch = async () => Fixture.response(null);
	else provider.records[0].custom_metadata[mismatch] = 'foreign';
	await assert.rejects(WhiteLabel.refresh(account._id, provider.options()), Fixture.unresolved);
	if (mismatch === 'id') { provider.records[0].id = id; provider.beforeGet = async record => { record.id = 'other-id'; }; }
	await assert.rejects(WhiteLabel.remove(account._id, provider.options()), Fixture.unresolved);
	const current = await WhiteLabel.account(account._id, true);
	assert.equal(current.white_label.cloudflare_hostname_id, id); assert.ok(current.white_label.dns_verified_at); assert.equal(current.white_label.state, 'active');
	assert.equal(provider.count('DELETE'), 0); assert.equal(provider.count('POST'), 1);
});

for (const outcome of ['success', 'error', '404']) test(`stale refresh ${outcome} cannot change a released claim or recreate it`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const next = await Fixture.account(account.white_label.hostname); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const barrier = Fixture.barrier();
	provider.beforeGet = async () => { provider.beforeGet = undefined; await barrier.wait(); if (outcome !== 'success') throw Object.assign(new Error(outcome), { status: outcome === '404' ? 404 : 503 }); };
	const refresh = WhiteLabel.refresh(account._id, provider.options()); const rejected = assert.rejects(refresh, Fixture.busy);
	await barrier.ready;
	try { await Fixture.expire(account); await WhiteLabel.remove(account._id, provider.options()); await WhiteLabel.verify(next._id, provider.options()); }
	finally { barrier.release(); await rejected; }
	await Fixture.released(account); assert.equal((await WhiteLabel.settings(next._id)).active, true); assert.equal(provider.count('POST'), 2); assert.equal(provider.count('DELETE'), 1);
});

test('late DELETE after lease expiry cannot delete a subsequent account claim', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const next = await Fixture.account(account.white_label.hostname); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const barrier = Fixture.barrier();
	provider.beforeDelete = async () => { provider.beforeDelete = undefined; await barrier.wait(); };
	const removal = WhiteLabel.remove(account._id, provider.options()); const rejected = assert.rejects(removal, Fixture.busy);
	await barrier.ready;
	try { await Fixture.expire(account); await WhiteLabel.remove(account._id, provider.options()); await WhiteLabel.verify(next._id, provider.options()); }
	finally { barrier.release(); await rejected; }
	await Fixture.released(account); assert.equal(provider.records.length, 1); assert.equal(provider.records[0].custom_metadata.account, String(next._id)); assert.equal((await WhiteLabel.settings(next._id)).active, true);
});

test('DELETE completed before a lost response keeps intent until same-ID 404 recovery', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const id = provider.records[0].id; provider.afterDelete = async () => { throw new Error('DELETE response lost'); };
	await assert.rejects(WhiteLabel.remove(account._id, provider.options()), /DELETE response lost/);
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.provider_action, 'deleting'); assert.equal(current.white_label.cloudflare_hostname_id, id); assert.ok(current.white_label.dns_verified_at);
	provider.afterDelete = undefined;
	await WhiteLabel.remove(account._id, provider.options()); await Fixture.released(account); assert.equal(provider.count('DELETE'), 1);
});

test('failed DELETE during disable retains reservation and cannot revive after entitlement restoration', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const next = await Fixture.account(account.white_label.hostname); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const before = await WhiteLabel.account(account._id, true); const id = provider.records[0].id;
	await Account.updateOne({ _id: account._id }, { $set: { plan: 'free' } });
	provider.beforeDelete = async () => { throw new Error('DELETE unavailable'); };
	await assert.rejects(WhiteLabel.disable(account, provider.options()), /DELETE unavailable/);
	let current = await WhiteLabel.account(account._id, true);
	assert.equal(current.white_label.state, 'disabled_by_plan'); assert.equal(current.white_label.provider_action, 'deleting'); assert.equal(current.white_label.cloudflare_hostname_id, id); assert.equal(current.white_label.claim_token, before.white_label.claim_token); assert.ok(current.white_label.dns_verified_at);
	await Account.updateOne({ _id: account._id }, { $set: { plan: 'team' } });
	await assert.rejects(WhiteLabel.verify(account._id, provider.options()), /DELETE unavailable/);
	await assert.rejects(WhiteLabel.verify(next._id, provider.options()), error => error.code === 'hostname_conflict');
	assert.equal((await WhiteLabel.settings(account._id)).active, false); assert.equal(provider.count('POST'), 1);
	provider.beforeDelete = undefined;
	const settings = await WhiteLabel.refresh(account._id, provider.options()); assert.equal(settings.active, false);
	current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.provider_action, ''); assert.equal(current.white_label.cloudflare_hostname_id, ''); assert.equal(current.white_label.dns_verified_at, null);
	assert.equal((await WhiteLabel.verify(next._id, provider.options())).active, true);
});

test('disable fences a paused CREATE immediately and reconciliation later cleans its exact resource', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); const barrier = Fixture.barrier(); provider.afterCreate = () => barrier.wait();
	const verifying = WhiteLabel.verify(account._id, provider.options()); const rejected = assert.rejects(verifying, Fixture.busy); await barrier.ready;
	try {
		await Account.updateOne({ _id: account._id }, { $set: { plan: 'free' } });
		await assert.rejects(WhiteLabel.disable(account, provider.options()), Fixture.busy);
		const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.state, 'disabled_by_plan'); assert.equal(current.white_label.provider_action, 'creating'); assert.ok(current.white_label.disabled_at);
	} finally { barrier.release(); await rejected; }
	provider.afterCreate = undefined;
	await WhiteLabel.disable(account, provider.options());
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.provider_action, ''); assert.equal(current.white_label.cloudflare_hostname_id, ''); assert.equal(current.white_label.dns_verified_at, null); assert.equal(provider.count('DELETE'), 1);
});

test('legacy verified catalog-only binding fails closed and preserves routing and reservation', { timeout: 15000 }, async () => {
	const account = await Account.create({ plan: 'team', billing: { status: 'active' }, white_label: { hostname: 'legacy-verified.example.test', state: 'active', dns_verified_at: new Date(), cloudflare_hostname_id: 'legacy-id' } });
	const options = { fetch: async () => assert.fail('legacy resource was accessed'), resolveCname: Fixture.dns, resolveTxt: Fixture.txt };
	for (const action of ['verify', 'refresh', 'remove']) await assert.rejects(WhiteLabel[action](account._id, options), Fixture.unresolved);
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.state, 'active'); assert.equal(current.white_label.cloudflare_hostname_id, 'legacy-id'); assert.ok(current.white_label.dns_verified_at); assert.equal(current.white_label.claim_token, '');
});

test('known rejected CREATE releases only its action; a retry may POST again', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); let rejected = false;
	const options = { ...provider.options(), fetch: async (url, input) => { if (!rejected && input.method === 'POST') { rejected = true; return Fixture.response(null, 400); } return provider.fetch(url, input); } };
	await assert.rejects(WhiteLabel.verify(account._id, options), error => error.code === 'cloudflare_error' && error.rejected);
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.provider_action, ''); assert.ok(current.white_label.dns_verified_at);
	assert.equal((await WhiteLabel.verify(account._id, options)).active, true); assert.equal(provider.count('POST'), 1);
});

test('malformed success response cannot confirm DELETE cleanup', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	await assert.rejects(WhiteLabel.remove(account._id, { ...provider.options(), fetch: async (url, input) => input.method === 'DELETE' ? { ok: true, status: 200, json: async () => ({}) } : provider.fetch(url, input) }), error => error.code === 'cloudflare_error');
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.provider_action, 'deleting'); assert.ok(current.white_label.cloudflare_hostname_id); assert.ok(current.white_label.dns_verified_at);
});

for (const mutation of ['remove', 'configure']) test(`failed ${mutation} cleanup resumes its persisted destination`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const target = mutation === 'remove' ? '' : `${randomUUID()}.replacement.test`;
	provider.beforeDelete = async () => { throw new Error('DELETE failed'); };
	const action = mutation === 'remove' ? WhiteLabel.remove(account._id, provider.options()) : WhiteLabel.configure(account._id, target, provider.options());
	await assert.rejects(action, /DELETE failed/);
	let current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.hostname, account.white_label.hostname); assert.equal(current.white_label.pending_hostname, target); assert.equal(current.white_label.provider_action, 'deleting'); assert.ok(current.white_label.dns_verified_at);
	provider.beforeDelete = undefined;
	await WhiteLabel.refresh(account._id, provider.options());
	current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.hostname, target); assert.equal(current.white_label.pending_hostname, null); assert.equal(current.white_label.provider_action, ''); assert.equal(current.white_label.dns_verified_at, null); assert.equal(current.white_label.state, target ? 'pending_dns' : 'unconfigured'); assert.equal(provider.count('POST'), 1);
});

test('a pending legacy ID is never fetched or deleted when acquiring a new verified claim', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	await Account.updateOne({ _id: account._id }, { $set: { 'white_label.cloudflare_hostname_id': 'unproven-legacy-id' } });
	assert.equal((await WhiteLabel.verify(account._id, provider.options())).active, true);
	assert.equal(provider.count('GET'), 0); assert.equal(provider.count('DELETE'), 0); assert.equal(provider.count('POST'), 1);
	assert.notEqual((await WhiteLabel.account(account._id, true)).white_label.cloudflare_hostname_id, 'unproven-legacy-id');
});

test('refresh replaces a missing known ID through verify using the same operation', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const id = provider.records[0].id; provider.records = [];
	assert.equal((await WhiteLabel.refresh(account._id, provider.options())).active, true);
	assert.equal(provider.count('POST'), 2); assert.notEqual(provider.records[0].id, id);
});

test('failed DNS recheck keeps a verified reservation and known provider binding until cleanup', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const next = await Fixture.account(account.white_label.hostname); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const before = await WhiteLabel.account(account._id, true);
	await assert.rejects(WhiteLabel.verify(account._id, { ...provider.options(), resolveCname: async () => [] }), error => error.code === 'cname_not_verified');
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.dns_verified_at.getTime(), before.white_label.dns_verified_at.getTime()); assert.equal(current.white_label.cloudflare_hostname_id, before.white_label.cloudflare_hostname_id); assert.equal(current.white_label.claim_token, before.white_label.claim_token); assert.equal(current.white_label.state, 'active');
	await assert.rejects(WhiteLabel.verify(next._id, provider.options()), error => error.code === 'hostname_conflict');
	assert.equal(provider.count('POST'), 1);
	await WhiteLabel.remove(account._id, provider.options()); assert.equal((await WhiteLabel.verify(next._id, provider.options())).active, true);
});

test('a stale claimed-conflict error cannot change the replacement hostname', { timeout: 15000 }, async t => {
	const account = await Fixture.account(); const provider = new Provider(); const barrier = Fixture.barrier();
	t.mock.method(WhiteLabel, 'claimed', async (id, hostname) => { if (hostname !== account.white_label.hostname) return null; await barrier.wait(); return { _id: new mongoose.Types.ObjectId() }; });
	const verifying = WhiteLabel.verify(account._id, provider.options()); const rejected = assert.rejects(verifying, Fixture.busy); await barrier.ready;
	try { await Fixture.expire(account); await WhiteLabel.configure(account._id, 'conflict-replacement.example.test', provider.options()); }
	finally { barrier.release(); await rejected; }
	const current = await WhiteLabel.account(account._id, true); assert.equal(current.white_label.hostname, 'conflict-replacement.example.test'); assert.equal(current.white_label.last_error, ''); assert.equal(current.white_label.dns_verified_at, null); assert.equal(provider.count('POST'), 0);
});

for (const proof of ['absent', 'wrong-account', 'extra-space', 'transient']) for (const action of ['verify', 'refresh']) test(`${action} rejects ${proof} TXT before reservation or provider access`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	const resolveTxt = async name => {
		assert.equal(name, `_typerelay.${account.white_label.hostname}`);
		if (proof === 'transient') throw Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' });
		return proof === 'absent' ? [] : [[`typerelay-domain-verification=${proof === 'wrong-account' ? new mongoose.Types.ObjectId() : account._id + ' '}`]];
	};
	await assert.rejects(WhiteLabel[action](account._id, { ...provider.options(), resolveTxt }), error => error.code === 'txt_not_verified' && error.settings.txt_value === `typerelay-domain-verification=${account._id}`);
	const current = await WhiteLabel.account(account._id, true);
	assert.equal(current.white_label.dns_verified_at, null); assert.equal(current.white_label.provider_action, ''); assert.equal(current.white_label.state, 'pending_dns'); assert.equal(provider.calls.length, 0);
	assert.doesNotMatch(JSON.stringify(WhiteLabel.serialize(current)), /typerelay-domain-verification=/);
});

test('split TXT chunks match exactly within one record and settings never expose the internal claim', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	const settings = await WhiteLabel.verify(account._id, { ...provider.options(), resolveTxt: async () => [['unrelated'], ['typerelay-domain-', 'verification=', String(account._id)]] });
	assert.equal(settings.active, true); assert.equal(settings.txt_name, `_typerelay.${account.white_label.hostname}`); assert.equal(settings.txt_value, `typerelay-domain-verification=${account._id}`);
	assert.equal(settings.claim_token, undefined);
	const current = await WhiteLabel.account(account._id, true);
	assert.equal(WhiteLabel.public(current).txt_value, undefined); assert.equal(WhiteLabel.serialize(current).txt_name, undefined); assert.equal(WhiteLabel.public(current).claim_token, undefined);
	assert.equal((await WhiteLabel.saveAsset(account._id, 'logo', null)).txt_value, settings.txt_value);
	assert.equal((await WhiteLabel.deleteAsset(account._id, 'favicon')).txt_name, settings.txt_name);
	const changed = await WhiteLabel.configure(account._id, 'changed-proof.example.test', provider.options());
	assert.equal(changed.txt_name, '_typerelay.changed-proof.example.test'); assert.equal(changed.txt_value, settings.txt_value);
	assert.equal((await WhiteLabel.remove(account._id, provider.options())).txt_name, '');
});

test('separate TXT records cannot be concatenated into an ownership proof', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	await assert.rejects(WhiteLabel.verify(account._id, { ...provider.options(), resolveTxt: async () => [['typerelay-domain-verification='], [String(account._id)]] }), error => error.code === 'txt_not_verified');
	assert.equal(provider.calls.length, 0);
});

test('only the account named by TXT can win concurrent claims', { timeout: 15000 }, async () => {
	const owner = await Fixture.account(); const other = await Fixture.account(owner.white_label.hostname); const provider = new Provider();
	const options = { ...provider.options(), resolveTxt: async () => [[`typerelay-domain-verification=${owner._id}`]] };
	const results = await Promise.allSettled([WhiteLabel.verify(other._id, options), WhiteLabel.verify(owner._id, options)]);
	assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'txt_not_verified'); assert.equal(results[1].value.active, true); assert.equal(provider.count('POST'), 1);
	assert.equal((await WhiteLabel.account(other._id, true)).white_label.dns_verified_at, null);
});

for (const action of ['verify', 'refresh']) test(`${action} preserves working domains without TXT but gates recreation after provider 404`, { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider(); await WhiteLabel.verify(account._id, provider.options());
	const options = { ...provider.options(), resolveTxt: async () => { throw new Error('TXT unavailable'); } };
	assert.equal((await WhiteLabel[action](account._id, options)).active, true);
	const before = await WhiteLabel.account(account._id, true); provider.records = [];
	await assert.rejects(WhiteLabel[action](account._id, options), error => error.code === 'txt_not_verified');
	const current = await WhiteLabel.account(account._id, true);
	assert.equal(current.white_label.dns_verified_at.getTime(), before.white_label.dns_verified_at.getTime()); assert.equal(current.white_label.cloudflare_hostname_id, ''); assert.equal(current.white_label.provider_action, ''); assert.equal(provider.count('POST'), 1); assert.equal(provider.count('DELETE'), 0);
	assert.equal((await WhiteLabel[action](account._id, provider.options())).active, true); assert.equal(provider.count('POST'), 2);
});

test('unverified legacy provider IDs cannot bypass TXT using refresh', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	await Account.updateOne({ _id: account._id }, { $set: { 'white_label.cloudflare_hostname_id': 'unproven-id' } });
	await assert.rejects(WhiteLabel.refresh(account._id, { ...provider.options(), resolveTxt: async () => [] }), error => error.code === 'txt_not_verified');
	assert.equal(provider.calls.length, 0); assert.equal((await WhiteLabel.account(account._id, true)).white_label.dns_verified_at, null);
});

test('uncertain successful creates reconcile exact metadata even if TXT later disappears', { timeout: 15000 }, async () => {
	const account = await Fixture.account(); const provider = new Provider();
	provider.afterCreate = async () => { throw new Error('response lost'); };
	await assert.rejects(WhiteLabel.verify(account._id, provider.options()), Fixture.unresolved);
	assert.equal((await WhiteLabel.refresh(account._id, { ...provider.options(), resolveTxt: async () => [] })).active, true);
	assert.equal(provider.count('POST'), 1); assert.equal(provider.count('DELETE'), 0);
});
