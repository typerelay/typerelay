import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mongoose, User, Account, Member, Library, Group, Device, Conflict } from '../model/index.js';
import { Support, Yaml } from '../services/support.js';
import { Libraries } from '../services/libraries.js';
import { Auth } from '../services/auth.js';
import { Team } from '../services/team.js';

class Fixture {
	static owner; static member; static admin; static outsider; static account;
	static async user(role, account) {
		const user = await User.create({ email: randomUUID() + '@example.test', name: role });
		await Member.create({ account, user: user._id, role });
		return Support.context(String(user._id), String(account));
	}
	static async create(ctx, yaml = 'matches:\n- trigger: hello\n  replace: Hello\n- trigger: bye\n  replace: Bye\n') {
		return Libraries.mutate(ctx, randomUUID(), { yaml }, async (fresh, session) => ({ library: await Libraries.create(fresh, { name: 'Test', yaml }, session) }));
	}
	static async settings(ctx, library, extra) {
		const body = { base_revision: library.revision, name: library.name, shared: true, editable: true, members: [], groups: [], ...extra };
		return Libraries.mutate(ctx, randomUUID(), body, (fresh, session) => Libraries.settings(fresh, library._id, body, session));
	}
	static async upload(ctx, library, changes, op = randomUUID()) {
		const body = { base_revision: library.revision, changes };
		return Libraries.mutate(ctx, op, body, (fresh, session) => Libraries.upload(fresh, library._id, body, session));
	}
	static change(snippet, replace) { return { id: snippet.id, base_revision: snippet.revision, base: snippet, value: replace === null ? null : { trigger: snippet.trigger, replace } }; }
}
before(async () => {
	await mongoose.connect(process.env.MONGODB_URI.replace('/typerelay?', '/typerelay_test?'));
	await mongoose.connection.dropDatabase();
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
	const account = await Account.create({ name: 'One' });
	Fixture.account = account._id;
	Fixture.owner = await Fixture.user('owner', account._id);
	Fixture.admin = await Fixture.user('admin', account._id);
	Fixture.member = await Fixture.user('member', account._id);
	Fixture.outsider = await Fixture.user('owner', (await Account.create({ name: 'Two' }))._id);
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('private libraries remain hidden from admins and other accounts', async () => {
	const { library } = await Fixture.create(Fixture.member);
	assert.equal((await Libraries.get(Fixture.member, library._id)).name, 'Test');
	await assert.rejects(Libraries.get(Fixture.admin, library._id), /not found/);
	await assert.rejects(Libraries.get(Fixture.owner, library._id), /not found/);
	await assert.rejects(Libraries.get(Fixture.outsider, library._id), /not found/);
});
test('sharing, groups, creator and admin permissions', async () => {
	let { library } = await Fixture.create(Fixture.member);
	({ library } = await Fixture.settings(Fixture.member, library, { editable: false }));
	assert.equal(Support.access(Fixture.admin, library).edit, true);
	assert.equal(Support.access(Fixture.member, library).edit, true);
	const another = await Fixture.user('member', Fixture.account);
	const group = await Group.create({ account: Fixture.account, name: 'Sales', users: [another.user] });
	({ library } = await Fixture.settings(Fixture.member, library, { groups: [String(group._id)], editable: false }));
	const assigned = await Support.context(another.user, another.account);
	assert.equal(Support.access(assigned, library).read, true);
	assert.equal(Support.access(assigned, library).edit, false);
	await assert.rejects(Fixture.upload(assigned, library, []), /read-only/);
	await assert.rejects(Fixture.settings(assigned, library, {}), /Only creator/);
	await Group.updateOne({ _id: group._id }, { $set: { users: [] } });
	await assert.rejects(Libraries.get(await Support.context(another.user, another.account), library._id), /not found/);
	({ library } = await Fixture.settings(Fixture.member, library, { shared: false }));
	await assert.rejects(Libraries.get(Fixture.admin, library._id), /not found/);
});
test('YAML comment fidelity, multiline, deletion, invalid imports and duplicates', async () => {
	const yaml = '# title\nmatches:\n- trigger: hello # trigger\n  replace: Hello\n# keep this\n- trigger: bye\n  replace: |+\n    Bye\n\n';
	const changed = await Yaml.run(yaml, [{ index: 0, entry: { trigger: 'hello', replace: 'First\nSecond\n\n' } }]);
	assert.ok(changed.yaml.includes('# title') && changed.yaml.includes('# trigger') && changed.yaml.includes('# keep this'));
	assert.equal(changed.matches[0].replace, 'First\nSecond\n\n');
	const removed = await Yaml.run(changed.yaml, [{ index: 0, entry: null }]);
	assert.equal(removed.matches.length, 1);
	assert.equal(removed.matches[0].trigger, 'bye');
	const empty = await Yaml.run(removed.yaml, [{ index: 0, entry: null }]);
	assert.deepEqual(empty.matches, []);
	await assert.rejects(Yaml.run('bad: ['), /YAML/);
	await assert.rejects(Yaml.run('matches: [{trigger: a, replace: x}, {trigger: a, replace: y}]'), /Duplicate/);
	await assert.rejects(Yaml.run('matches: [{trigger: ",a", replace: x}]'), /trigger|abbreviation/i);
});
test('two device independent edits merge and retry is idempotent', async () => {
	const { library } = await Fixture.create(Fixture.owner);
	const op = randomUUID();
	const first = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'First edit')], op);
	const retry = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'First edit')], op);
	assert.equal(first.library.revision, retry.library.revision);
	await assert.rejects(Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'Changed retry')], op), /Operation ID/);
	const second = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[1], 'Second edit')]);
	assert.deepEqual(second.conflicts, []);
	assert.deepEqual(second.library.snippets.map(snippet => snippet.replace), ['First edit', 'Second edit']);
});
test('same snippet and edit/delete retain conflict; explicit resolution', async () => {
	const { library } = await Fixture.create(Fixture.owner);
	await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'Server')]);
	const result = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], null)]);
	assert.equal(result.conflicts.length, 1);
	const conflict = await Conflict.findById(result.conflicts[0]).lean();
	assert.equal(conflict.local, null);
	assert.equal(conflict.server.replace, 'Server');
	const body = { choice: 'local', base_revision: result.library.revision };
	const resolved = await Libraries.mutate(Fixture.owner, randomUUID(), body, (ctx, session) => Libraries.resolve(ctx, String(conflict._id), body, session));
	assert.equal(resolved.library.snippets.length, 1);
	assert.equal((await Conflict.findById(conflict._id).lean()).resolved, true);
});
test('cursor access manifest reflects revocation and library deletion', async () => {
	let { library } = await Fixture.create(Fixture.owner);
	({ library } = await Fixture.settings(Fixture.owner, library, { members: [Fixture.member.user] }));
	const first = await Libraries.download(Fixture.member, 0);
	assert.ok(first.accessible.includes(library._id));
	({ library } = await Fixture.settings(Fixture.owner, library, { shared: false }));
	const next = await Libraries.download(Fixture.member, first.cursor);
	assert.ok(!next.accessible.includes(library._id));
	({ library } = await Fixture.settings(Fixture.owner, library, { deleted: true }));
	assert.equal(library.deleted, true);
	assert.ok(!(await Libraries.download(Fixture.owner, 0)).accessible.includes(library._id));
});
test('PKCE account binding, one-time code, rotating token, device revoke', async () => {
	const verifier = Support.token();
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const body = { account: Fixture.owner.account, redirect_uri: 'http://127.0.0.1:43000/callback', client_id: 'typerelay-desktop', code_challenge_method: 'S256', code_challenge: challenge, state: Support.token() };
	await assert.rejects(Auth.authorize(Fixture.member.user, { ...body, account: Fixture.outsider.account }), /denied/);
	const redirect = new URL(await Auth.authorize(Fixture.owner.user, body));
	const exchange = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), client_id: body.client_id, redirect_uri: body.redirect_uri, code_verifier: verifier };
	await assert.rejects(Auth.exchange({ ...exchange, code_verifier: Support.token() }), /Invalid authorization/);
	const tokens = await Auth.exchange(exchange);
	assert.equal((await Auth.bearer(tokens.access_token)).account, Fixture.owner.account);
	await assert.rejects(Auth.exchange(exchange), /Invalid authorization/);
	const rotated = await Auth.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
	await assert.rejects(Auth.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), /Invalid refresh/);
	await Device.updateOne({ _id: tokens.device }, { $set: { revoked: true } });
	await assert.rejects(Auth.bearer(rotated.access_token), /revoked/);
});
test('membership administration cannot escalate admin to owner or touch owner', async () => {
	const owner = await Member.findOne({ user: Fixture.owner.user, account: Fixture.account }).lean();
	await assert.rejects(Libraries.mutate(Fixture.admin, randomUUID(), {}, (ctx, session) => Team.member(ctx, String(owner._id), {}, session)), /Cannot change/);
});
