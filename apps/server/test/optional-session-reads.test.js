import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Support } from '../services/support.js';

// Execute the actual helper bodies with query doubles; no database connection.
const method = (service, name, globals) => {
	const source = readFileSync(new URL(`../services/${service}.js`, import.meta.url), 'utf8');
	const start = source.indexOf(`\tstatic async ${name}(`);
	assert.ok(start >= 0);
	const end = source.indexOf('\n\t}', start) + 3;
	return runInNewContext(`(class { ${source.slice(start, end)} })`, globals)[name];
};

for (const active of [undefined, false, true]) test(`optional session reads: transaction=${active}`, async () => {
	const session = active === undefined ? undefined : { inTransaction: () => active };
	const queries = [];
	const model = value => new Proxy({}, { get: () => () => {
		const query = { supplied: undefined, preference: undefined, session(value) { this.supplied = value; return this; }, read(value) { this.preference = value; return this; }, select() { return this; }, sort() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
		queries.push(query);
		return query;
	} });
	const globals = Object.fromEntries(['Library', 'Snippet', 'PersonalAbbreviation', 'SnippetAsset', 'Conflict', 'Group'].map(name => [name, model([])]));
	globals.Account = model({ _id: 'account' });
	globals.AccountAccess = { assert() {}, storage: { getStore: () => ({ read: true }) } };
	globals.Support = { assert: assert.ok, access: () => ({ read: true, edit: true }), transactionRead: Support.transactionRead };
	globals.Libraries = { personalState: method('libraries', 'personalState', globals) };
	const ctx = { account: 'account', user: 'user' };
	await globals.Libraries.personalState(ctx, session);
	await method('libraries', 'personalize', globals)(ctx, [], session);
	await method('libraries', 'receipt', globals)(ctx, { library_ids: [] }, session);
	await method('assets', 'visible', globals)(ctx, ['a'.repeat(64)], session);
	await method('billing', 'account', globals)('account', session);
	globals.Member = model({ role: 'owner' });
	globals.Billing = { entitlements: () => ({ capabilities: { team: true } }), memberAllowed: async () => true };
	globals.Support.id = value => value;
	await method('support', 'context', globals)('user', 'account', session);
	for (const name of ['Member', 'Ticket', 'Device']) globals[name] = model(0);
	globals.Snippet = model(0);
	await method('billing', 'usage', globals)('account', session);
	assert.ok(queries.length >= 13);
	for (const query of queries) {
		assert.equal(query.supplied ?? null, session ?? null);
		assert.equal(query.preference, active ? 'primary' : undefined);
	}
});
