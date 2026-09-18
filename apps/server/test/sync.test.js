import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mongoose, User, Account, Member, Library, Group, Device, Conflict, Snippet, MigrationBackup } from '../model/index.js';
import { Support, Yaml } from '../services/support.js';
import { Libraries } from '../services/libraries.js';
import { Auth } from '../services/auth.js';
import { StorageMigration } from '../services/storage_migration.js';
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
	await mongoose.connect(process.env.MONGO_URI.replace('/typerelay?', '/typerelay_test?'));
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

test('editing legacy snippets updates sort order while unchanged saves and retries preserve timestamps', async () => {
	let { library } = await Fixture.create(Fixture.owner);
	await Snippet.updateMany({ library: library._id }, { $unset: { createdAt: 1, updatedAt: 1 } }, { timestamps: false });
	library = Libraries.view(Fixture.owner, await Libraries.get(Fixture.owner, library._id));
	const edited = library.snippets[1];
	const sibling = library.snippets[0];
	const operation = randomUUID();
	const changes = [Fixture.change(edited, 'Updated expansion')];
	const result = await Fixture.upload(Fixture.owner, library, changes, operation);
	assert.equal(result.library.snippets[0].id, edited.id);
	assert.equal(result.library.snippets[0].revision, edited.revision + 1);
	assert.ok(result.library.snippets[0].updatedAt instanceof Date);
	const stored = await Snippet.findOne({ id: edited.id }).lean();
	assert.equal(stored.content.text, 'Updated expansion');
	assert.equal(+stored.updatedAt, +result.library.snippets[0].updatedAt);
	assert.equal((await Snippet.findOne({ id: sibling.id }).lean()).updatedAt, undefined);
	const retry = await Fixture.upload(Fixture.owner, library, changes, operation);
	assert.equal(+retry.library.snippets[0].updatedAt, +stored.updatedAt);
	const saved = result.library.snippets.find(snippet => snippet.id === sibling.id);
	const untouched = await Fixture.upload(Fixture.owner, result.library, [Fixture.change(saved, saved.replace)]);
	assert.equal(untouched.library.snippets[0].id, edited.id, 'Background sync of identical content must not reorder');
	const unchanged = untouched.library.snippets.find(snippet => snippet.id === sibling.id);
	assert.equal(unchanged.revision, sibling.revision);
	assert.equal(unchanged.updatedAt, undefined);
	const editedAgain = untouched.library.snippets.find(snippet => snippet.id === edited.id);
	const same = await Fixture.upload(Fixture.owner, untouched.library, [Fixture.change(editedAgain, editedAgain.replace)]);
	assert.equal(same.library.snippets[0].revision, stored.revision);
	assert.equal(+same.library.snippets[0].updatedAt, +stored.updatedAt);

});

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
test('YAML managed export, multiline, deletion, invalid imports and duplicates', async () => {
	const yaml = '# title\nmatches:\n- trigger: hello # trigger\n  replace: Hello\n# keep this\n- trigger: bye\n  replace: |+\n    Bye\n\n';
	const changed = await Yaml.run(yaml, [{ index: 0, entry: { trigger: 'hello', replace: 'First\nSecond\n\n' } }]);
	assert.ok(changed.yaml.startsWith('# Generated by TypeRelay.'));
	assert.equal(changed.matches[0].replace, 'First\nSecond\n\n');
	const removed = await Yaml.run(changed.yaml, [{ index: 0, entry: null }]);
	assert.equal(removed.matches.length, 1);
	assert.equal(removed.matches[0].trigger, 'bye');
	const empty = await Yaml.run(removed.yaml, [{ index: 0, entry: null }]);
	assert.deepEqual(empty.matches, []);
	await assert.rejects(Yaml.run('bad: ['), /error|YAML/);
	await assert.rejects(Yaml.run('matches: [{trigger: a, replace: x}, {trigger: a, replace: y}]'), /[Dd]uplicate/);
	await assert.rejects(Yaml.run('matches: [{trigger: ",a", replace: x}]'), /trigger|abbreviation/i);
});
test('two device independent edits merge and retry is idempotent', async () => {
	const { library } = await Fixture.create(Fixture.owner);
	assert.equal(+library.snippets[0].updatedAt, +library.snippets[1].updatedAt);
	const op = randomUUID();
	const first = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'First edit')], op);
	const retry = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'First edit')], op);
	assert.equal(first.library.revision, retry.library.revision);
	await assert.rejects(Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[0], 'Changed retry')], op), /Operation ID/);
	const second = await Fixture.upload(Fixture.owner, library, [Fixture.change(library.snippets[1], 'Second edit')]);
	assert.deepEqual(second.conflicts, []);
	assert.deepEqual(second.library.snippets.map(snippet => snippet.replace), ['Second edit', 'First edit']);
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
	assert.equal((await Libraries.download(Fixture.owner, 0)).libraries.find(row => row._id === library._id).state, 'trashed');
});
test('PKCE account binding, one-time code, rotating token, device revoke', async () => {
	const verifier = Support.token();
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const body = { account: Fixture.owner.account, redirect_uri: 'http://127.0.0.1:43000/callback', client_id: 'typerelay-desktop', code_challenge_method: 'S256', code_challenge: challenge, state: Support.token(), client_type: 'desktop', os: 'macos' };
	await assert.rejects(Auth.authorize(Fixture.member.user, { ...body, account: Fixture.outsider.account }), /denied/);
	const redirect = new URL(await Auth.authorize(Fixture.owner.user, body));
	const exchange = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), client_id: body.client_id, redirect_uri: body.redirect_uri, code_verifier: verifier };
	await assert.rejects(Auth.exchange({ ...exchange, code_verifier: Support.token() }), /Invalid authorization/);
	const tokens = await Auth.exchange(exchange);
	const connected = await Device.findById(tokens.device).lean();
	assert.equal(connected.client_type, 'desktop'); assert.equal(connected.os, 'macos'); assert.ok(connected.createdAt); assert.ok(connected.last_active);
	await Device.updateOne({ _id: tokens.device }, { $set: { last_active: new Date(0) } });
	assert.equal((await Auth.bearer(tokens.access_token)).account, Fixture.owner.account);
	assert.ok((await Device.findById(tokens.device).lean()).last_active > new Date(0));
	await assert.rejects(Auth.exchange(exchange), /Invalid authorization/);
	const rotated = await Auth.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
	await assert.rejects(Auth.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), /Invalid refresh/);
	await Device.updateOne({ _id: tokens.device }, { $set: { revoked: true } });
	await assert.rejects(Auth.bearer(rotated.access_token), /revoked/);
});
test('device enrollment accepts supported metadata and legacy clients without guessing', async () => {
	for (const metadata of [{}, { client_type: 'cli', os: 'linux' }, { client_type: 'desktop', os: 'windows' }]) {
		const verifier = Support.token();
		const body = { account: Fixture.owner.account, redirect_uri: 'typerelay://oauth/callback', client_id: 'typerelay-desktop', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: Support.token(), ...metadata };
		await assert.rejects(Auth.authorize(Fixture.owner.user, { ...body, client_type: 'fake' }), /Invalid client type/);
		await assert.rejects(Auth.authorize(Fixture.owner.user, { ...body, os: '<script>' }), /Invalid operating system/);
		const url = new URL(await Auth.authorize(Fixture.owner.user, body));
		const tokens = await Auth.exchange({ grant_type: 'authorization_code', code: url.searchParams.get('code'), client_id: body.client_id, redirect_uri: body.redirect_uri, code_verifier: verifier });
		const device = await Device.findById(tokens.device).lean();
		assert.equal(device.client_type, metadata.client_type); assert.equal(device.os, metadata.os);
		await Device.updateOne({ _id: device._id }, { $set: { access_expires: new Date(0), last_active: new Date(0) } });
		await assert.rejects(Auth.bearer(tokens.access_token), /expired/);
		assert.equal(+(await Device.findById(device._id).lean()).last_active, 0);
		await Auth.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
		assert.ok(+(await Device.findById(device._id).lean()).last_active > 0);
	}
});
test('desktop PKCE accepts only the registered app callback', () => {
	assert.equal(Auth.redirect('typerelay://oauth/callback'), 'typerelay://oauth/callback');
	assert.throws(() => Auth.redirect('typerelay://other/callback'), /Invalid desktop callback/);
});
test('membership administration cannot escalate admin to owner or touch owner', async () => {
	const owner = await Member.findOne({ user: Fixture.owner.user, account: Fixture.account }).lean();
	await assert.rejects(Libraries.mutate(Fixture.admin, randomUUID(), {}, (ctx, session) => Team.member(ctx, String(owner._id), {}, session)), /Cannot change/);
});

test('Trash restores IDs, keeps independent snippet trash, and removes canonical YAML storage', async () => {
	const ctx = await Fixture.user('owner', (await Account.create({ name: 'Trash isolated' }))._id);
	let { library } = await Fixture.create(ctx);
	const first = library.snippets[0];
	let result = await Fixture.upload(ctx, library, [Fixture.change(first, null)]);
	library = result.library;
	const individual = (await Libraries.trash(ctx))[0];
	const body = { target: { type: 'library', library: library._id, id: library._id, revision: library.revision }, action: 'trash' };
	result = await Libraries.mutate(ctx, randomUUID(), body, (fresh, session) => Libraries.trashAction(fresh, body.target, body.action, session));
	assert.equal((await Libraries.list(ctx)).length, 0);
	assert.equal((await Libraries.trash(ctx)).length, 1);
	const parent = (await Libraries.trash(ctx))[0];
	result = await Libraries.mutate(ctx, randomUUID(), { target: parent }, (fresh, session) => Libraries.trashAction(fresh, parent, 'restore', session));
	assert.equal(result.library.snippets.length, 1);
	assert.equal((await Libraries.trash(ctx))[0].id, individual.id);
	const restored = await Libraries.mutate(ctx, randomUUID(), { target: individual }, (fresh, session) => Libraries.trashAction(fresh, individual, 'restore', session));
	assert.equal(restored.library.snippets[0].id, first.id);
	const raw = await Library.collection.findOne({ _id: new mongoose.Types.ObjectId(library._id) });
	assert.equal(raw.yaml, undefined);
	assert.equal(raw.snippets, undefined);
	assert.equal(await Snippet.countDocuments({ library: library._id }), 2);
	const current = await Libraries.get(ctx, library._id);
	const parentTarget = { type: 'library', id: library._id, library: library._id, revision: current.revision };
	await Libraries.mutate(ctx, randomUUID(), { parentTarget }, (fresh, session) => Libraries.trashAction(fresh, parentTarget, 'trash', session));
	const parentTrash = (await Libraries.trash(ctx))[0];
	await Libraries.mutate(ctx, randomUUID(), { parentTrash }, (fresh, session) => Libraries.empty(fresh, [parentTrash], session));
	assert.ok((await Libraries.download(ctx, 0)).purged.includes(library._id));
	assert.equal((await Library.findById(library._id).lean()).name, undefined);
	assert.ok((await Snippet.find({ library: library._id }).lean()).every(row => row.state === 'purged' && !row.content));

});
test('shared editors cannot purge, private Trash stays private, and stale purge cannot remove restored content', async () => {
	const account = await Account.create({ name: 'Trash permissions' });
	const owner = await Fixture.user('owner', account._id);
	const creator = await Fixture.user('member', account._id);
	let { library } = await Fixture.create(creator);
	({ library } = await Fixture.upload(creator, library, [Fixture.change(library.snippets[0], null)]));
	assert.equal((await Libraries.trash(owner)).length, 0);
	({ library } = await Fixture.settings(creator, library, { members: [owner.user], editable: true }));
	const editor = await Fixture.user('member', account._id);
	({ library } = await Fixture.settings(creator, library, { members: [editor.user], editable: true }));
	const target = (await Libraries.trash(editor))[0];
	assert.equal(target.can_purge, false);
	await assert.rejects(Libraries.mutate(editor, randomUUID(), { target }, (ctx, session) => Libraries.trashAction(ctx, target, 'purge', session)), /Not permitted/);
	await Libraries.mutate(editor, randomUUID(), { target }, (ctx, session) => Libraries.trashAction(ctx, target, 'restore', session));
	await assert.rejects(Libraries.mutate(creator, randomUUID(), { target }, (ctx, session) => Libraries.empty(ctx, [target], session)), /changed/);
	assert.equal((await Libraries.get(creator, library._id)).snippets.length, 2);
});
test('restore collisions roll back; expiry/purge erase content, conflicts and prevent resurrection', async () => {
	const ctx = await Fixture.user('owner', (await Account.create({ name: 'Purge isolated' }))._id);
	let { library } = await Fixture.create(ctx);
	const original = library;
	({ library } = await Fixture.upload(ctx, library, [Fixture.change(library.snippets[0], null)]));
	const target = (await Libraries.trash(ctx))[0];
	const retainedSnippet = library.snippets[0];
	({ library } = await Fixture.upload(ctx, library, [Fixture.change(retainedSnippet, null)]));
	const retained = (await Libraries.trash(ctx)).find(row => row.id === retainedSnippet.id);
	const collision = await Fixture.create(ctx, 'matches: [{trigger: hello, replace: Collision}]');
	await assert.rejects(Libraries.mutate(ctx, randomUUID(), { target }, (fresh, session) => Libraries.trashAction(fresh, target, 'restore', session)), /[Dd]uplicate/);
	assert.ok((await Libraries.trash(ctx)).some(row => row.id === target.id));
	await Conflict.create({ account: ctx.account, library: library._id, user: ctx.user, snippet: target.id, local: { replace: 'Old private content' } });
	await Snippet.updateOne({ library: library._id, id: target.id }, { $set: { expires_at: new Date(Date.now() - 1000) } });
	let { library: expiredLibrary } = await Fixture.create(ctx, 'matches: [{trigger: expired, replace: Expired}]');
	const expiredLibraryTarget = { type: 'library', id: expiredLibrary._id, library: expiredLibrary._id, revision: expiredLibrary.revision };
	({ library: expiredLibrary } = await Libraries.mutate(ctx, randomUUID(), { expiredLibraryTarget }, (fresh, session) => Libraries.trashAction(fresh, expiredLibraryTarget, 'trash', session)));
	await Library.updateOne({ _id: expiredLibrary._id }, { $set: { expires_at: new Date(Date.now() - 1000) } });
	await assert.rejects(Libraries.mutate(ctx, randomUUID(), { target }, (fresh, session) => Libraries.trashAction(fresh, target, 'restore', session)), /expired/);
	const summary = await Libraries.cleanup();
	assert.deepEqual(summary, { libraries: 1, snippets: 1 });
	const purged = await Snippet.findOne({ library: library._id, id: target.id }).lean();
	assert.equal(purged.state, 'purged');
	assert.equal(purged.content, undefined);
	assert.equal(purged.trigger, undefined);
	assert.equal((await Snippet.findOne({ library: library._id, id: retained.id }).lean()).state, 'trashed');
	assert.equal((await Library.findById(expiredLibrary._id).lean()).state, 'purged');
	assert.ok((await Snippet.find({ library: expiredLibrary._id }).lean()).every(row => row.state === 'purged' && !row.content));
	assert.equal(await Conflict.countDocuments({ library: library._id, snippet: target.id }), 0);
	const tombstones = await Libraries.download(ctx, 0);
	assert.ok(tombstones.tombstones.some(row => row.id === target.id));
	assert.ok(tombstones.purged.includes(expiredLibrary._id));
	await assert.rejects(Fixture.upload(ctx, original, [Fixture.change(original.snippets[0], 'Resurrect')]), /permanently purged/);
	assert.ok((await Libraries.get(ctx, collision.library._id)).snippets.length);
});
test('legacy server migration is repeatable, preserves IDs and starts deleted-library retention safely', async () => {
	const ctx = await Fixture.user('owner', (await Account.create({ name: 'Legacy migration' }))._id);
	const id = new mongoose.Types.ObjectId();
	const snippet = randomUUID();
	await Library.collection.insertOne({ _id: id, account: new mongoose.Types.ObjectId(ctx.account), creator: new mongoose.Types.ObjectId(ctx.user), name: 'Legacy', shared: false, editable: false, members: [], groups: [], revision: 4, deleted: true, yaml: 'matches: [{trigger: old, replace: Original}]', snippets: [{ id: snippet, trigger: 'old', replace: 'Original', revision: 3 }] });
	await StorageMigration.run();
	await StorageMigration.run();
	const library = await Library.findById(id).lean();
	assert.equal(library.state, 'trashed');
	assert.ok(library.expires_at > new Date(Date.now() + 29 * 86400000));
	assert.equal((await Snippet.findOne({ library: id }).lean()).id, snippet);
	assert.equal(await Snippet.countDocuments({ library: id }), 1);
	assert.ok(await MigrationBackup.exists({ key: 'records-v2:libraries:' + id }));
	assert.equal((await Library.collection.findOne({ _id: id })).yaml, undefined);
});

test('batch moves preserve IDs/order, update both libraries and retry idempotently', async () => {
	const ctx = await Fixture.user('owner', (await Account.create({ name: 'Move account' }))._id);
	const source = (await Fixture.create(ctx)).library;
	const destination = (await Fixture.create(ctx, 'matches: [{trigger: existing, replace: Existing}]')).library;
	const items = [...source.snippets].reverse().map(entry => ({ id: entry.id, base_revision: entry.revision }));
	const body = { action: 'move', source_library: source._id, destination_library: destination._id, items };
	const operation = randomUUID();
	const first = await Libraries.mutate(ctx, operation, body, (actor, session) => Libraries.batch(actor, body, session));
	const second = await Libraries.mutate(ctx, operation, body, (actor, session) => Libraries.batch(actor, body, session));
	assert.deepEqual(first.moved, second.moved);
	assert.equal((await Libraries.get(ctx, source._id)).snippets.length, 0);
	const moved = (await Libraries.get(ctx, destination._id)).snippets;
	assert.deepEqual(moved.map(row => row.trigger), ['existing', 'hello', 'bye']);
	assert.deepEqual(moved.slice(1).map(row => row.id), source.snippets.map(row => row.id));
	assert.deepEqual(moved.slice(1).map(row => +row.updatedAt), source.snippets.map(row => +row.updatedAt));
	assert.ok(first.libraries.every(row => row.revision === 2));
	await assert.rejects(Fixture.upload(ctx, source, [Fixture.change(source.snippets[0], 'Stale edit')]), /moved/);
	assert.equal(await Snippet.countDocuments({ account: ctx.account, id: source.snippets[0].id }), 1);
});
test('batch collision, stale revision and missing destination permission fail atomically', async () => {
	const account = await Account.create({ name: 'Atomic moves' });
	const ctx = await Fixture.user('owner', account._id);
	const source = (await Fixture.create(ctx)).library;
	const destination = (await Fixture.create(ctx, 'matches: [{trigger: bye, replace: Collision}]')).library;
	const body = { action: 'move', source_library: source._id, destination_library: destination._id, items: source.snippets.map(row => ({ id: row.id, base_revision: row.revision })) };
	await assert.rejects(Libraries.mutate(ctx, randomUUID(), body, (actor, session) => Libraries.batch(actor, body, session)), /duplicate/i);
	assert.equal((await Libraries.get(ctx, source._id)).snippets.length, 2);
	assert.equal((await Libraries.get(ctx, destination._id)).snippets.length, 1);
	const stale = { action: 'trash', source_library: source._id, items: [{ id: source.snippets[0].id, base_revision: 1 }, { id: source.snippets[1].id, base_revision: 99 }] };
	await assert.rejects(Libraries.mutate(ctx, randomUUID(), stale, (actor, session) => Libraries.batch(actor, stale, session)), /changed/);
	assert.equal((await Libraries.trash(ctx)).length, 0);
	const member = await Fixture.user('member', account._id);
	await Fixture.settings(ctx, source, { members: [member.user], editable: true });
	await Fixture.settings(ctx, destination, { members: [member.user], editable: false });
	await assert.rejects(Libraries.mutate(member, randomUUID(), body, (actor, session) => Libraries.batch(actor, body, session)), /read-only/);
	const foreign = (await Fixture.create(Fixture.outsider, 'matches: []')).library;
	await assert.rejects(Libraries.mutate(ctx, randomUUID(), { ...body, destination_library: foreign._id }, (actor, session) => Libraries.batch(actor, { ...body, destination_library: foreign._id }, session)), /not found/);
});
test('single edit-and-move commits content and location together; bulk Trash restores normally', async () => {
	const ctx = await Fixture.user('owner', (await Account.create({ name: 'Edit move' }))._id);
	const source = (await Fixture.create(ctx)).library;
	const destination = (await Fixture.create(ctx, 'matches: []')).library;
	const body = { action: 'move', source_library: source._id, destination_library: destination._id, items: [{ id: source.snippets[0].id, base_revision: 1, value: { trigger: ',renamed', replace: 'Changed\nText' } }] };
	await Libraries.mutate(ctx, randomUUID(), body, (actor, session) => Libraries.batch(actor, body, session));
	const moved = (await Libraries.get(ctx, destination._id)).snippets[0];
	assert.equal(moved.id, source.snippets[0].id);
	assert.equal(moved.trigger, 'renamed');
	assert.equal(moved.content.text, 'Changed\nText');
	const trash = { action: 'trash', source_library: destination._id, items: [{ id: moved.id, base_revision: moved.revision }] };
	await Libraries.mutate(ctx, randomUUID(), trash, (actor, session) => Libraries.batch(actor, trash, session));
	const target = (await Libraries.trash(ctx))[0];
	await Libraries.mutate(ctx, randomUUID(), { target }, (actor, session) => Libraries.trashAction(actor, target, 'restore', session));
	assert.equal((await Libraries.get(ctx, destination._id)).snippets[0].id, moved.id);
});

test('code metadata, optional abbreviations, import previews and idempotent imports', async () => {
	const owner = await Fixture.user('owner', (await Account.create({ name: 'Code import' }))._id);
	const text = '\t  {{ value }}\n    $|$\tUnicode: λ  \n\n';
	const source = { contents: { folders: [{ uuid: 'root', title: 'Code', children: [{ uuid: 'child', title: 'Rust' }] }], tags: [{ uuid: 'tag', title: 'Tag' }], snippets: [{ title: 'Example', folder: 'child', fragments: [{ title: 'One', language: 'RustLexer', content: text, note: 'Omitted' }, { title: 'Two', language: 'UnknownLexer', content: '  two\n' }] }, { title: 'Invalid', fragments: [{ content: '' }] }] } };
	const preview = await Libraries.snippetsLab(source);
	assert.equal(preview.entries[0].name, 'Code › Rust');
	assert.equal(preview.entries[0].title, 'Example — One');
	assert.equal(preview.entries[0].content.text, text);
	assert.ok(preview.entries[2].error);
	assert.equal(preview.warnings.length, 2);
	const body = { source, selected: preview.entries.slice(0, 2).map(entry => ({ key: entry.key, trigger: null })) };
	const operation = randomUUID();
	const run = () => Libraries.mutate(owner, operation, body, (ctx, session) => Libraries.importSnippetsLab(ctx, body, session));
	const imported = await run();
	assert.equal((await run()).libraries[0]._id, imported.libraries[0]._id);
	const library = imported.libraries[0];
	assert.equal(library.shared, false);
	assert.equal(library.snippets.length, 2);
	assert.equal(library.snippets[0].trigger, null);
	assert.equal(library.snippets[0].content.text, text);
	assert.equal(library.snippets[1].content.language, 'UnknownLexer');
	const exported = await Yaml.export(library.snippets.map(Libraries.yaml));
	const roundtrip = await Yaml.run(exported.yaml);
	assert.equal(roundtrip.matches[0].replace, text);
	assert.equal(roundtrip.matches[0].type, 'code');
	assert.equal(roundtrip.matches[0].title, 'Example — One');
	const entry = library.snippets[0];
	const result = await Fixture.upload(owner, library, [{ id: entry.id, base_revision: entry.revision, value: { ...Libraries.value(entry), title: 'Renamed', content: { ...entry.content, language: 'JavaScript' } } }]);
	assert.equal(result.library.snippets[0].title, 'Renamed');
	assert.equal(result.library.snippets[0].content.language, 'JavaScript');
	const competing = await Fixture.upload(owner, result.library, [{ id: entry.id, base_revision: entry.revision, value: { ...Libraries.value(entry), title: 'Offline title' } }]);
	assert.equal(competing.conflicts.length, 1, 'Concurrent metadata edits must retain a conflict');
	await Libraries.validate([{ trigger: 'literal', replace: '{{ invalid text mode }}' }]);
	const bad = { ...body, selected: [{ key: '1:0' }] };
	await assert.rejects(Libraries.mutate(owner, randomUUID(), bad, (ctx, session) => Libraries.importSnippetsLab(ctx, bad, session)), /invalid/);
	await assert.rejects(Libraries.snippetsLab({ contents: { snippets: [{ title: 'Missing' }] } }), /no fragments/);
});

test('beta importers parse CSV, HTML JSON and XML sets with review-only commands', async () => {
	const csv = '\ufeffabbreviation,snippet,label\r\n,hello,Greeting\r\n",sig","\t  Hello ""world""\r\nnext\r\n",Signature\r\nUPPER,Text,Invalid\r\ndate,%Y,Date\r\n';
	const preview = await Libraries.previewImport('textexpander', { source: csv, filename: 'Sales.csv' });
	assert.equal(preview.entries.length, 4);
	assert.equal(preview.entries[1].trigger, 'sig');
	assert.equal(preview.entries[1].original_trigger, ',sig');
	assert.equal(preview.entries[1].content.text, '\t  Hello "world"\nnext\n');
	assert.equal(preview.entries[2].trigger, 'UPPER'); assert.ok(preview.entries[2].trigger_error);
	assert.equal(preview.entries[3].review, true); assert.equal(preview.entries[3].trigger, null);
	assert.equal(preview.entries[3].title, 'Date (Needs review)');
	await assert.rejects(Libraries.previewImport('textexpander', { source: 'abbreviation,snippet\nx,"bad' }), /Malformed CSV/);
	const blaze = { folders: [{ name: 'Parent', snippets: [{ name: 'Rich', shortcut: ',html', html: '<p>Hello <b>world</b></p><p>Next<br>line<img src="https://invalid.test/x"></p>' }, { name: 'Dynamic', shortcut: 'form', body: 'Hello {formtext: name=Name}' }], children: [{ name: 'Child', snippets: [{ shortcut: 'child', body: '\tchild  \n' }, { name: 'Image', html: '<img src="x">' }] }] }] };
	const rich = await Libraries.previewImport('textblaze', { source: blaze });
	assert.equal(rich.entries[0].content.type, 'rich_text'); assert.equal(rich.entries[0].content.text, 'Hello world\nNext\nline');
	assert.ok(rich.entries[0].warnings.length); assert.equal(rich.entries[1].review, true);
	assert.equal(rich.entries[2].name, 'Parent › Child'); assert.ok(rich.entries[3].error);
	const xml = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>name</key><string>Mac</string><key>clippings</key><array><dict><key>abbr</key><string>,mac</string><key>clip</key><string>\tMac &amp; λ\n</string></dict></array></dict></plist>';
	const mac = await Libraries.previewImport('typeit4me', { source: xml });
	assert.equal(mac.entries[0].trigger, 'mac'); assert.equal(mac.entries[0].content.text, '\tMac & λ\n');
	const simple = await Libraries.previewImport('typeit4me', { source: '<TypeIt4Me name="Set"><clipping><abbreviation>x</abbreviation><snippet>Text</snippet></clipping></TypeIt4Me>' });
	assert.equal(simple.entries[0].content.text, 'Text');
	await assert.rejects(Libraries.previewImport('typeit4me', { source: '<!DOCTYPE x [<!ENTITY read SYSTEM "file:///etc/passwd">]><clippings/>' }), /DTDs/);
	await assert.rejects(Libraries.previewImport('typeit4me', { source: '<unknown/>' }), /Unrecognized/);
	await assert.rejects(Libraries.previewImport('textblaze', { source: { unexpected: [] } }), /Unrecognized/);
	await assert.rejects(Libraries.previewImport('textblaze', { source: { folders: [] } }), /No snippets/);
});

test('shared import commit corrects abbreviations, stays private, retries and rolls back collisions', async () => {
	const owner = await Fixture.user('owner', (await Account.create({ name: 'Beta import' }))._id);
	const body = { source: 'abbreviation,snippet,label\nUPPER,hello,Title\nmacro,%Y,Year\n', filename: 'Beta.csv', selected: [{ key: '0:0', trigger: 'fixed' }, { key: '0:1', trigger: 'must-not-activate' }] };
	const operation = randomUUID();
	const run = () => Libraries.mutate(owner, operation, body, (ctx, session) => Libraries.commitImport(ctx, 'textexpander', body, session));
	const { libraries } = await run();
	assert.equal(libraries[0].snippets[0].trigger, 'fixed'); assert.equal(libraries[0].snippets[1].trigger, null);
	assert.equal(libraries[0].shared, false); assert.equal((await run()).libraries[0]._id, libraries[0]._id);
	const before = await Library.countDocuments({ account: owner.account });
	await assert.rejects(Libraries.mutate(owner, randomUUID(), body, (ctx, session) => Libraries.commitImport(ctx, 'textexpander', body, session)), /Duplicate/);
	assert.equal(await Library.countDocuments({ account: owner.account }), before);
	const cleared = { ...body, selected: [{ key: '0:0', trigger: '' }] };
	const next = await Libraries.mutate(owner, randomUUID(), cleared, (ctx, session) => Libraries.commitImport(ctx, 'textexpander', cleared, session));
	assert.equal(next.libraries[0].name, 'Beta (2)'); assert.equal(next.libraries[0].snippets[0].trigger, null);
	const admin = await Fixture.user('admin', owner.account);
	await assert.rejects(Libraries.get(admin, libraries[0]._id), /not found/);
});

test('template metadata survives imports, edits, conflicts, moves and Trash', async () => {
	const ctx = await Fixture.user('owner', (await Account.create({ name: 'Template tests' }))._id);
	const content = { version: 1, type: 'template', text: 'Hi {{name}} {{date}}{{key:enter}}', variables: { name: { label: 'Customer', default: 'Nitai', required: true, multiline: false }, date: { timezone: 'utc', format: 'DD/MM/YYYY' } } };
	const body = { name: 'Template', snippets: [{ id: randomUUID(), trigger: 'template', content }] };
	let result = await Libraries.mutate(ctx, randomUUID(), body, (fresh, session) => Libraries.create(fresh, body, session).then(library => ({ library })));
	let library = result.library; const first = library.snippets[0];
	assert.deepEqual(first.content.variables, content.variables);
	const yaml = await Yaml.export(library.snippets.map(Libraries.yaml));
	const parsed = await Yaml.run(yaml.yaml); assert.equal(parsed.matches[0].type, 'template'); assert.equal(parsed.matches[0].variables.name.label, 'Customer');
	const changed = { ...content, variables: { ...content.variables, name: { ...content.variables.name, label: 'Updated' } } };
	result = await Fixture.upload(ctx, library, [{ id: first.id, base_revision: first.revision, value: { trigger: 'template', content: changed } }]); library = result.library;
	const competing = await Fixture.upload(ctx, library, [{ id: first.id, base_revision: first.revision, value: { trigger: 'template', content: { ...content, text: 'Dear {{name}}' } } }]);
	assert.equal(competing.conflicts.length, 1);
	const conflict = await Conflict.findById(competing.conflicts[0]).lean(); assert.equal(conflict.local.content.type, 'template'); assert.equal(conflict.server.content.variables.name.label, 'Updated');
	const destination = await Fixture.create(ctx, 'matches: []');
	const move = { action: 'move', source_library: library._id, destination_library: destination.library._id, items: [{ id: first.id, base_revision: library.snippets[0].revision }] };
	const moved = await Libraries.mutate(ctx, randomUUID(), move, (fresh, session) => Libraries.batch(fresh, move, session));
	const entry = moved.libraries.find(item => item._id === destination.library._id).snippets[0]; assert.deepEqual(entry.content, changed);
	const target = { type: 'snippet', id: entry.id, library: destination.library._id, revision: entry.revision };
	await Libraries.mutate(ctx, randomUUID(), target, (fresh, session) => Libraries.trashAction(fresh, target, 'trash', session));
	const row = (await Libraries.trash(ctx)).find(row => row.id === entry.id);
	await Libraries.mutate(ctx, randomUUID(), row, (fresh, session) => Libraries.trashAction(fresh, row, 'restore', session));
	assert.deepEqual((await Libraries.get(ctx, destination.library._id)).snippets[0].content, changed);
	await assert.rejects(Libraries.validate([{ trigger: 'bad', type: 'template', replace: '{{shell:ls}}' }]), /variable name/);
});

test('mobile OAuth binds callback, client, device metadata and rotated refresh tokens', async () => {
 for (const os of ['ios', 'android']) {
  const verifier = Support.token();
  const body = { account: Fixture.owner.account, redirect_uri: 'com.typerelay.mobile://oauth/callback', client_id: 'typerelay-mobile', client_type: 'mobile', os, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: Support.token() };
  await assert.rejects(Auth.authorize(Fixture.owner.user, { ...body, os: 'macos' }), /Invalid operating system/);
  await assert.rejects(Auth.authorize(Fixture.owner.user, { ...body, client_type: 'desktop' }), /Invalid client type/);
  const callback = new URL(await Auth.authorize(Fixture.owner.user, body));
  const exchange = { grant_type: 'authorization_code', client_id: body.client_id, redirect_uri: body.redirect_uri, code: callback.searchParams.get('code'), code_verifier: verifier };
  await assert.rejects(Auth.exchange({ ...exchange, client_id: 'typerelay-desktop' }), /Invalid authorization code/);
  await assert.rejects(Auth.exchange({ ...exchange, code_verifier: Support.token() }), /Invalid authorization code/);
  const tokens = await Auth.exchange(exchange);
  await assert.rejects(Auth.exchange(exchange), /Invalid authorization code/);
  const device = await Device.findById(tokens.device).lean();
  assert.equal(device.os, os); assert.equal(device.client_type, 'mobile'); assert.equal(device.oauth_client, 'typerelay-mobile');
  await assert.rejects(Auth.exchange({ grant_type: 'refresh_token', client_id: 'typerelay-desktop', refresh_token: tokens.refresh_token }), /Invalid refresh client/);
  const rotated = await Auth.exchange({ grant_type: 'refresh_token', client_id: 'typerelay-mobile', refresh_token: tokens.refresh_token });
  await assert.rejects(Auth.exchange({ grant_type: 'refresh_token', client_id: 'typerelay-mobile', refresh_token: tokens.refresh_token }), /Invalid refresh/);
  assert.equal((await Auth.bearer(rotated.access_token)).device, tokens.device);
  await Device.updateOne({ _id: tokens.device }, { $set: { revoked: true } });
 }
});
test('mobile callbacks require exact registered scheme host and path', () => {
 assert.equal(Auth.redirect('com.typerelay.mobile://oauth/callback', 'typerelay-mobile'), 'com.typerelay.mobile://oauth/callback');
 for (const uri of ['not-a-url', 'typerelay://oauth/callback', 'http://127.0.0.1:8080/callback', 'com.typerelay.mobile://oauth/callback/extra', 'com.typerelay.mobile://user@oauth/callback', 'com.typerelay.mobile://oauth/callback?x=1', 'com.typerelay.mobile://oauth/callback#x', 'com.typerelay.mobile://evil/callback']) assert.throws(() => Auth.redirect(uri, 'typerelay-mobile'), /Invalid mobile callback/);
 assert.throws(() => Auth.redirect('com.typerelay.mobile://oauth/callback', 'typerelay-desktop'), /Invalid desktop callback/);
});

test('browser preview callback is restricted to the configured development origin', async () => {
 const previousEnvironment = process.env.NODE_ENV; const previousPreview = process.env.TYPERELAY_MOBILE_PREVIEW_URL;
 try {
  process.env.NODE_ENV = 'development'; process.env.TYPERELAY_MOBILE_PREVIEW_URL = 'https://preview.example.test/mobile';
  const redirect = 'https://preview.example.test/mobile/oauth/callback';
  assert.equal(Auth.redirect(redirect, 'typerelay-mobile'), redirect);
  for (const uri of ['https://other.example.test/mobile/oauth/callback', 'https://preview.example.test/oauth/callback', redirect + '?query=1']) assert.throws(() => Auth.redirect(uri, 'typerelay-mobile'), /Invalid mobile callback/);
  const verifier = Support.token();
  const body = { account: Fixture.owner.account, client_id: 'typerelay-mobile', client_type: 'mobile', os: 'web', redirect_uri: redirect, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: Support.token() };
  const callback = new URL(await Auth.authorize(Fixture.owner.user, body));
  const tokens = await Auth.exchange({ grant_type: 'authorization_code', client_id: body.client_id, redirect_uri: redirect, code_verifier: verifier, code: callback.searchParams.get('code') });
  assert.equal((await Device.findById(tokens.device).lean()).os, 'web');
  await Device.updateOne({ _id: tokens.device }, { $set: { revoked: true } });
  process.env.NODE_ENV = 'production';
  assert.throws(() => Auth.redirect(redirect, 'typerelay-mobile'), /Invalid mobile callback/);
  assert.equal(Auth.redirect('com.typerelay.mobile://oauth/callback', 'typerelay-mobile'), 'com.typerelay.mobile://oauth/callback');
 } finally {
  if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
  if (previousPreview === undefined) delete process.env.TYPERELAY_MOBILE_PREVIEW_URL; else process.env.TYPERELAY_MOBILE_PREVIEW_URL = previousPreview;
 }
});
