import { randomUUID } from 'node:crypto';
import { mongoose, Library, Operation, Conflict, Account, Change, Member, Group } from '../model/index.js';
import { Support, Yaml } from './support.js';

export class Libraries {
	static view(ctx, library) { return { ...library, _id: String(library._id), permissions: Support.access(ctx, library) }; }
	static async get(ctx, id, session) {
		const library = await Library.findOne({ _id: Support.id(id), account: ctx.account }).session(session || null).lean();
		Support.assert(library && Support.access(ctx, library).read, 'Library not found', 404);
		return library;
	}
	static async list(ctx) {
		const libraries = await Library.find({ account: ctx.account, deleted: false }).lean();
		return libraries.filter(library => Support.access(ctx, library).read).map(library => Libraries.view(ctx, library));
	}
	static async create(ctx, body, session) {
		const parsed = await Yaml.run(body.yaml ?? 'matches: []\n');
		const [library] = await Library.create([{ account: ctx.account, creator: ctx.user, name: Support.text(body.name), shared: false, editable: false, members: [], groups: [], yaml: parsed.yaml, snippets: parsed.matches.map(entry => ({ id: randomUUID(), ...entry, revision: 1 })), revision: 1 }], { session });
		await Support.change(ctx.account, library._id, 'library', session);
		return Libraries.view(ctx, library.toObject());
	}
	static async mutate(ctx, operation, body, action) {
		Support.assert(typeof operation === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(operation), 'Stable operation ID required');
		const fingerprint = Support.hash(JSON.stringify(body));
		let result;
		await mongoose.connection.transaction(async session => {
			// Serialize account mutations and permission changes, including retries.
			await Account.updateOne({ _id: ctx.account }, { $inc: { sequence: 0 } }, { session });
			ctx = await Support.context(ctx.user, ctx.account, session);
			const prior = await Operation.findOne({ account: ctx.account, user: ctx.user, operation }).session(session).lean();
			if (prior) {
				Support.assert(prior.fingerprint === fingerprint, 'Operation ID already used with different content', 409);
				result = prior.result;
				if (result.library?.deleted) Support.assert(Support.equal(ctx.user, result.library.creator) || (result.library.shared && Support.admin(ctx)), "Library not found", 404);
				else if (result.library) await Libraries.get(ctx, result.library._id, session);
				return;
			}
			result = await action(ctx, session);
			await Operation.create([{ account: ctx.account, user: ctx.user, operation, fingerprint, result }], { session });
		});
		return result;
	}
	static async settings(ctx, id, body, session) {
		const library = await Libraries.get(ctx, id, session);
		Support.assert(Support.access(ctx, library).manage, 'Only creator and account admins manage this library', 403);
		Support.assert(library.revision === body.base_revision, 'Library changed; refresh before saving settings', 409);
		if (body.deleted === true) library.deleted = true;
		else {
			library.name = Support.text(body.name);
			Support.assert(typeof body.shared === 'boolean' && typeof body.editable === 'boolean', 'Sharing and editing must be booleans');
			library.shared = body.shared;
			library.editable = body.editable;
			Support.assert(Array.isArray(body.members) && Array.isArray(body.groups) && body.members.length <= 1000 && body.groups.length <= 1000, 'Invalid grants');
			library.members = [...new Set(body.members.map(Support.id))];
			library.groups = [...new Set(body.groups.map(Support.id))];
			Support.assert(await Member.countDocuments({ account: ctx.account, user: { $in: library.members } }).session(session) === library.members.length, 'Member belongs to another account');
			Support.assert(await Group.countDocuments({ account: ctx.account, _id: { $in: library.groups } }).session(session) === library.groups.length, 'Group belongs to another account');
		}
		library.revision++;
		await Library.replaceOne({ _id: library._id, account: ctx.account }, library, { session });
		await Support.change(ctx.account, library._id, library.deleted ? 'delete' : 'permissions', session);
		return { library: Libraries.view(ctx, library) };
	}
	static same(a, b) { return (a?.trigger ?? null) === (b?.trigger ?? null) && (a?.replace ?? null) === (b?.replace ?? null); }
	static async upload(ctx, id, body, session) {
		const library = await Libraries.get(ctx, id, session);
		Support.assert(Support.access(ctx, library).edit, 'Library is read-only', 403);
		Support.assert(Number.isInteger(body.base_revision) && body.base_revision >= 1 && body.base_revision <= library.revision, 'Invalid base revision', 409);
		Support.assert(Array.isArray(body.changes) && body.changes.length <= 10000, 'Invalid changes');
		const conflicts = [];
		const seen = new Set();
		for (const change of body.changes) {
			Support.assert(typeof change.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(change.id) && !seen.has(change.id), 'Invalid or repeated snippet ID');
			seen.add(change.id);
			const index = library.snippets.findIndex(snippet => snippet.id === change.id);
			const server = library.snippets[index] || null;
			const local = change.value === null ? null : { trigger: change.value?.trigger, replace: change.value?.replace };
			if (local) await Yaml.run('matches: ' + JSON.stringify([local]));
			if (Libraries.same(server, local)) continue;
			if ((server?.revision ?? null) !== (change.base_revision ?? null)) {
				const [conflict] = await Conflict.create([{ account: ctx.account, library: library._id, user: ctx.user, snippet: change.id, local, base: change.base || null, server }], { session });
				conflicts.push(String(conflict._id));
				continue;
			}
			const output = await Yaml.run(library.yaml, [{ index: index < 0 ? null : index, entry: local }]);
			library.yaml = output.yaml;
			if (local) {
				const value = { id: index < 0 ? randomUUID() : change.id, ...local, revision: library.revision + 1 };
				if (index < 0) library.snippets.push(value); else library.snippets[index] = value;
			} else if (index >= 0) library.snippets.splice(index, 1);
		}
		if (body.yaml !== undefined && body.base_revision === library.revision && conflicts.length === 0) {
			const parsed = await Yaml.run(body.yaml);
			Support.assert(parsed.matches.length === library.snippets.length && parsed.matches.every(entry => library.snippets.some(snippet => Libraries.same(entry, snippet))), 'YAML does not match submitted changes');
			library.snippets = parsed.matches.map(entry => library.snippets.find(snippet => Libraries.same(entry, snippet)));
			library.yaml = parsed.yaml;
		}
		library.revision++;
		await Library.replaceOne({ _id: library._id, account: ctx.account }, library, { session });
		await Support.change(ctx.account, library._id, 'library', session);
		return { library: Libraries.view(ctx, library), conflicts };
	}
	static async download(ctx, cursor) {
		Support.assert(Number.isSafeInteger(cursor) && cursor >= 0, 'Invalid cursor');
		let result;
		await mongoose.connection.transaction(async session => {
			ctx = await Support.context(ctx.user, ctx.account, session);
			const account = await Account.findById(ctx.account).session(session).lean();
			const changes = await Change.find({ account: ctx.account, sequence: { $gt: cursor, $lte: account.sequence } }).session(session).lean();
			const all = await Library.find({ account: ctx.account, deleted: false }).session(session).lean();
			const visible = all.filter(library => Support.access(ctx, library).read);
			const changed = new Set(changes.map(change => String(change.library)));
			const permissions = changes.some(change => change.kind === 'membership');
			const libraries = visible.filter(library => cursor === 0 || permissions || changed.has(String(library._id))).map(library => Libraries.view(ctx, library));
			const conflicts = await Conflict.find({ account: ctx.account, resolved: false, library: { $in: visible.filter(library => Support.access(ctx, library).edit).map(library => library._id) } }).session(session).lean();
			result = { cursor: account.sequence, accessible: visible.map(library => String(library._id)), libraries, conflicts };
		}, { readConcern: { level: 'snapshot' } });
		return result;
	}
	static async resolve(ctx, id, body, session) {
		const conflict = await Conflict.findOne({ _id: Support.id(id), account: ctx.account, resolved: false }).session(session).lean();
		Support.assert(conflict, 'Conflict no longer exists', 404);
		const library = await Libraries.get(ctx, String(conflict.library), session);
		Support.assert(Support.access(ctx, library).edit, 'Library is read-only', 403);
		Support.assert(body.base_revision === library.revision, 'Library changed; review the latest version', 409);
		Support.assert(['local', 'server', 'merged'].includes(body.choice), 'Choose a conflict resolution');
		let result = { library: Libraries.view(ctx, library) };
		if (body.choice !== 'server') {
			const current = library.snippets.find(snippet => snippet.id === conflict.snippet);
			result = await Libraries.upload(ctx, String(library._id), { base_revision: library.revision, changes: [{ id: conflict.snippet, base_revision: current?.revision ?? null, value: body.choice === 'local' ? conflict.local : body.value }] }, session);
		}
		await Conflict.updateOne({ _id: conflict._id }, { $set: { resolved: true } }, { session });
		return { ...result, resolved: id };
	}
}
