import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoose, User, Account, Member, Snippet, Library, PersonalAbbreviation } from '../model/index.js';
import { Libraries } from '../services/libraries.js';
import { Support } from '../services/support.js';

class Fixture {
	static async setup() {
		const account = await Account.create({ name: 'Personal abbreviations', plan: 'team', billing: { status: 'active' } });
		const users = await User.create(['owner', 'editor', 'reader'].map(name => ({ name, email: randomUUID() + '@example.test' })));
		await Member.create(users.map((user, index) => ({ account: account._id, user: user._id, role: index ? 'member' : 'owner' })));
		const contexts = await Promise.all(users.map(user => Support.context(String(user._id), String(account._id))));
		const library = await Libraries.mutate(contexts[0], randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'Shared', snippets: [{ trigger: 'tw', replace: 'Shared expansion' }, { trigger: 'other', replace: 'Other' }] }, session) }));
		await Library.updateOne({ _id: library.library._id }, { $set: { shared: true, editable: true, members: users.slice(1).map(user => user._id) } });
		return { contexts, library: library.library, id: library.library.snippets.find(row => row.trigger === 'tw').id };
	}
	static async set(ctx, id, trigger, revision, extra = {}, operation = randomUUID()) {
		const body = { operation_id: operation, trigger, base_revision: revision, ...extra };
		return Libraries.mutate(ctx, operation, { ...body, snippet: id }, (fresh, session) => Libraries.personal(fresh, id, body, session));
	}
}

before(async () => {
	await mongoose.connect(process.env.MONGO_URI.replace('/typerelay?', '/typerelay_personal_test?'));
	await mongoose.connection.dropDatabase();
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('personal abbreviation replaces only its owner’s trigger, normalizes, resets and retries without changing shared revisions', async () => {
	const { contexts: [owner, editor], library, id } = await Fixture.setup();
	const before = await Snippet.findOne({ id }).lean();
	const operation = randomUUID();
	await Fixture.set(editor, id, ';tww', 0, {}, operation);
	await Fixture.set(editor, id, ';tww', 0, {}, operation);
	assert.equal((await Libraries.get(editor, library._id)).snippets.find(row => row.id === id).effective_trigger, 'tww');
	assert.equal((await Libraries.get(owner, library._id)).snippets.find(row => row.id === id).effective_trigger, 'tw');
	assert.deepEqual(await Snippet.findOne({ id }).lean(), before);
	assert.equal((await Library.findById(library._id).lean()).revision, library.revision);
	assert.equal((await Libraries.personalState(editor))[0].revision, 1);
	assert.equal((await Libraries.download(editor, 0)).personal_abbreviations, undefined);
	assert.equal((await Libraries.download(editor, 0, true)).personal_abbreviations[0].trigger, 'tww');
	assert.deepEqual((await Libraries.download(owner, 0, true)).personal_abbreviations, []);
	await Fixture.set(editor, id, null, 1);
	assert.equal((await Libraries.get(editor, library._id)).snippets.find(row => row.id === id).effective_trigger, 'tw');
	assert.equal((await Libraries.personalState(editor))[0].revision, 2);
});

test('edit rights gate mutations; downgrade preserves overrides; private libraries suspend them; invalid and duplicate triggers fail', async () => {
	const { contexts: [owner, editor], library, id } = await Fixture.setup();
	await assert.rejects(Fixture.set(editor, id, 'other', 0), /Duplicate/);
	await assert.rejects(Fixture.set(editor, id, 'UPPER', 0), /lowercase/);
	await Fixture.set(editor, id, 'mine', 0);
	await Library.updateOne({ _id: library._id }, { $set: { editable: false } });
	await assert.rejects(Fixture.set(editor, id, 'new', 1), /permission/);
	assert.equal((await Libraries.get(editor, library._id)).snippets.find(row => row.id === id).effective_trigger, 'mine');
	await Library.updateOne({ _id: library._id }, { $set: { shared: false } });
	await assert.rejects(Fixture.set(owner, id, 'new', 0), /permission/);
	await assert.rejects(Libraries.get(editor, library._id), /not found/);
	await Library.updateOne({ _id: library._id }, { $set: { shared: true } });
	assert.equal((await Libraries.get(editor, library._id)).snippets.find(row => row.id === id).effective_trigger, 'mine');
});

test('concurrent changes create private explicit conflicts; default updates collide without dropping content; purge removes overrides', async () => {
	const { contexts: [owner, editor], library, id } = await Fixture.setup();
	await Fixture.set(editor, id, 'mine', 0);
	await Fixture.set(editor, id, 'offline', 0);
	let state = (await Libraries.personalState(editor))[0];
	assert.equal(state.trigger, 'mine');
	assert.equal(state.conflicts.length, 1);
	assert.deepEqual(await Libraries.personalState(owner), []);
	await Fixture.set(editor, id, state.conflicts[0].trigger, state.revision, { conflict: state.conflicts[0].id });
	state = (await Libraries.personalState(editor))[0];
	assert.equal(state.trigger, 'offline');
	assert.equal(state.conflicts.length, 0);
	await Snippet.updateOne({ library: library._id, id: { $ne: id } }, { $set: { trigger: 'offline' } });
	const rows = (await Libraries.get(editor, library._id)).snippets;
	assert.equal(rows.filter(row => row.abbreviation_collision).length, 2);
	assert.equal(rows.find(row => row.id === id).replace, 'Shared expansion');
	await mongoose.connection.transaction(async session => Libraries.purge(await Library.findById(library._id).session(session).lean(), await Snippet.findOne({ id }).session(session).lean(), session));
	assert.equal(await PersonalAbbreviation.countDocuments({ snippet: id }), 0);
});

test('overrides follow stable IDs through moves and Trash while exports and copied snippets retain shared defaults', async () => {
	const { contexts: [owner, editor], library, id } = await Fixture.setup();
	await Fixture.set(editor, id, 'mine', 0);
	const source = await Libraries.get(editor, library._id);
	assert.equal(Libraries.exportEntry(source.snippets.find(row => row.id === id)).trigger, 'tw');
	const created = await Libraries.mutate(owner, randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'Destination', snippets: [] }, session) }));
	const body = { action: 'move', source_library: library._id, destination_library: created.library._id, items: [{ id, base_revision: 1 }] };
	await Libraries.mutate(owner, randomUUID(), body, (ctx, session) => Libraries.batch(ctx, body, session));
	assert.deepEqual(await Libraries.personalState(editor), []);
	await Library.updateOne({ _id: created.library._id }, { $set: { shared: true, editable: true, members: [editor.user] } });
	let moved = (await Libraries.get(editor, created.library._id)).snippets.find(row => row.id === id);
	assert.equal(moved.effective_trigger, 'mine');
	const target = { type: 'snippet', id, library: created.library._id, revision: moved.revision };
	await Libraries.mutate(owner, randomUUID(), target, (ctx, session) => Libraries.trashAction(ctx, target, 'trash', session));
	assert.equal((await Libraries.get(editor, created.library._id)).snippets.length, 0);
	const trashed = await Snippet.findOne({ id }).lean();
	const restore = { ...target, revision: trashed.revision };
	await Libraries.mutate(owner, randomUUID(), restore, (ctx, session) => Libraries.trashAction(ctx, restore, 'restore', session));
	moved = (await Libraries.get(editor, created.library._id)).snippets.find(row => row.id === id);
	assert.equal(moved.effective_trigger, 'mine');
	const copied = await Libraries.mutate(owner, randomUUID(), { copy: id }, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'Copy', snippets: [Libraries.value(moved)] }, session) }));
	assert.notEqual(copied.library.snippets[0].id, id);
	assert.equal(copied.library.snippets[0].trigger, 'tw');
	assert.equal(await PersonalAbbreviation.countDocuments({ snippet: copied.library.snippets[0].id }), 0);
});
