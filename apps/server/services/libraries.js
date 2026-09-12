import { Abbreviation } from '../public/abbreviation.js';
import { randomUUID } from 'node:crypto';
import { mongoose, Library, Snippet, Operation, Conflict, Account, Change, Member, Group } from '../model/index.js';
import { Support, Yaml } from './support.js';

export class Libraries {
	static retention = 30 * 86400000;
	static trashFields(actor, now = new Date()) { return { state: 'trashed', trashed_at: now, expires_at: new Date(+now + Libraries.retention), trashed_by: actor }; }
	static content(value) {
		const content = value?.content || { version: 1, type: 'plain_text', text: value?.replace };
		Support.assert(content.version === 1 && content.type === 'plain_text' && typeof content.text === 'string', 'Unsupported snippet content');
		return { version: 1, type: 'plain_text', text: content.text };
	}
	static entry(snippet) { return { ...snippet, replace: snippet.content?.text }; }
	static view(ctx, library) { return { ...library, _id: String(library._id), deleted: library.state !== 'active', permissions: Support.access(ctx, library) }; }
	static async hydrate(library, session) {
		const entries = await Snippet.find({ library: library._id, state: { $ne: 'purged' } }).sort({ position: 1, id: 1 }).session(session || null).lean();
		return { ...library, snippets: entries.filter(entry => entry.state === 'active').map(Libraries.entry), records: entries.map(Libraries.entry) };
	}
	static async get(ctx, id, session, includeTrash = false) {
		const library = await Library.findOne({ _id: Support.id(id), account: ctx.account }).session(session || null).lean();
		Support.assert(library && Support.access(ctx, library).read && (includeTrash || library.state === 'active'), 'Library not found', 404);
		return Libraries.hydrate(library, session);
	}
	static async list(ctx, session) {
		const libraries = await Library.find({ account: ctx.account, state: 'active' }).session(session || null).lean();
		return Promise.all(libraries.filter(library => Support.access(ctx, library).read).map(async library => Libraries.view(ctx, await Libraries.hydrate(library, session))));
	}
	static async validate(entries) {
		return Yaml.validate(entries.map(entry => ({ trigger: entry.trigger, replace: Libraries.content(entry).text })));
	}
	static async create(ctx, body, session) {
		const entries = body.yaml !== undefined ? (await Yaml.run(body.yaml)).matches : (body.snippets || []);
		await Libraries.validate(entries);
		const [library] = await Library.create([{ account: ctx.account, creator: ctx.user, name: Support.text(body.name), shared: false, editable: false, members: [], groups: [], revision: 1, state: 'active' }], { session });
		for (const entry of entries) if (entry.id !== undefined) Support.assert(typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(entry.id), 'Invalid snippet ID');
		for (const [position, entry] of entries.entries()) await Snippet.create([{ account: ctx.account, library: library._id, id: entry.id || randomUUID(), trigger: entry.trigger, content: Libraries.content(entry), position, revision: 1, state: 'active' }], { session });
		await Support.change(ctx.account, library._id, 'library', session);
		return Libraries.view(ctx, await Libraries.hydrate(library.toObject(), session));
	}
	static async receipt(ctx, stored, session) {
		const result = { ...stored };
		if (stored.library_ids) {
			result.libraries = [];
			for (const id of stored.library_ids) {
				const library = await Library.findOne({ _id: id, account: ctx.account }).session(session || null).lean();
				if (library && Support.access(ctx, library).read) result.libraries.push(Libraries.view(ctx, await Libraries.hydrate(library, session)));
			}
		}
		if (stored.library_id) {
			const raw = await Library.findOne({ _id: stored.library_id, account: ctx.account }).session(session).lean();
			if (raw?.state === 'purged') result.purged = [stored.library_id];
			else result.library = Libraries.view(ctx, await Libraries.get(ctx, stored.library_id, session, true));
		}
		return result;
	}
	static async mutate(ctx, operation, body, action) {
		Support.assert(typeof operation === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(operation), 'Stable operation ID required');
		const fingerprint = Support.hash(JSON.stringify(body));
		let result;
		await mongoose.connection.transaction(async session => {
			await Account.updateOne({ _id: ctx.account }, { $inc: { sequence: 1 } }, { session });
			ctx = await Support.context(ctx.user, ctx.account, session);
			const prior = await Operation.findOne({ account: ctx.account, user: ctx.user, operation }).session(session).lean();
			if (prior) {
				Support.assert(prior.fingerprint === fingerprint, 'Operation ID already used with different content', 409);
				result = await Libraries.receipt(ctx, prior.result, session);
				return;
			}
			result = await action(ctx, session);
			const stored = { ...result };
			if (result.library) { stored.library_id = result.library._id; delete stored.library; }
			if (stored.libraries) { stored.library_ids = stored.libraries.map(library => library._id); delete stored.libraries; }
			delete stored.html;
			if (stored.affected) stored.affected = stored.affected.map(({ id, type, library, revision }) => ({ id, type, library, revision }));
			await Operation.create([{ account: ctx.account, user: ctx.user, operation, fingerprint, result: stored }], { session });
		});
		return result;
	}
	static async settings(ctx, id, body, session) {
		const library = await Libraries.get(ctx, id, session);
		Support.assert(Support.access(ctx, library).manage, 'Only creator and account admins manage this library', 403);
		Support.assert(library.revision === body.base_revision, 'Library changed; refresh before saving', 409);
		if (body.deleted === true) return Libraries.trashAction(ctx, { type: 'library', id, library: id, revision: library.revision }, 'trash', session);
		Support.assert(typeof body.shared === 'boolean' && typeof body.editable === 'boolean', 'Sharing and editing must be booleans');
		Support.assert(Array.isArray(body.members) && Array.isArray(body.groups) && body.members.length <= 1000 && body.groups.length <= 1000, 'Invalid grants');
		const members = [...new Set(body.members.map(Support.id))];
		const groups = [...new Set(body.groups.map(Support.id))];
		Support.assert(await Member.countDocuments({ account: ctx.account, user: { $in: members } }).session(session) === members.length, 'Member belongs to another account');
		Support.assert(await Group.countDocuments({ account: ctx.account, _id: { $in: groups } }).session(session) === groups.length, 'Group belongs to another account');
		await Library.updateOne({ _id: library._id }, { $set: { name: Support.text(body.name), shared: body.shared, editable: body.editable, members, groups }, $inc: { revision: 1 } }, { session });
		await Support.change(ctx.account, library._id, 'permissions', session);
		return { library: Libraries.view(ctx, await Libraries.get(ctx, id, session)) };
	}
	static same(a, b) { return (a?.trigger ?? null) === (b?.trigger ?? null) && (a?.content?.text ?? a?.replace ?? null) === (b?.content?.text ?? b?.replace ?? null); }
	static async upload(ctx, id, body, session) {
		const library = await Libraries.get(ctx, id, session, true);
		Support.assert(Support.access(ctx, library).edit, 'Library is read-only', 403);
		Support.assert(Number.isInteger(body.base_revision) && body.base_revision >= 1 && body.base_revision <= library.revision, 'Invalid base revision', 409);
		Support.assert(Array.isArray(body.changes) && body.changes.length <= 10000, 'Invalid changes');
		const conflicts = [];
		const seen = new Set();
		for (const change of body.changes) {
			Support.assert(typeof change.id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(change.id) && !seen.has(change.id), 'Invalid or repeated snippet ID');
			seen.add(change.id);
			const server = await Snippet.findOne({ account: ctx.account, id: change.id }).session(session).lean();
			Support.assert(!server || Support.equal(server.library, library._id), 'Snippet moved to another library; review your changes', 409);
			Support.assert(server?.state !== 'purged', 'Snippet was permanently purged; it cannot be restored', 410);
			const local = change.value === null ? null : { trigger: Abbreviation.normalize(change.value?.trigger), content: Libraries.content(change.value) };
			if (local) await Libraries.validate([local]);
			if (server?.state === 'active' && library.state === 'active' && Libraries.same(server, local)) continue;
			if (server?.state === 'trashed' && local === null) continue;
			if (library.state !== 'active' || server?.state === 'trashed' || (server?.revision ?? null) !== (change.base_revision ?? null)) {
				const [conflict] = await Conflict.create([{ account: ctx.account, library: library._id, user: ctx.user, snippet: change.id, local, base: change.base || null, server: server ? Libraries.entry(server) : null }], { session });
				conflicts.push(String(conflict._id));
				continue;
			}
			if (!server && !local) continue;
			if (local) {
				await Snippet.updateOne({ library: library._id, id: change.id }, { $set: { account: ctx.account, trigger: local.trigger, content: local.content, state: 'active', revision: (server?.revision || 0) + 1 }, ...(!server ? { $setOnInsert: { position: library.records.reduce((maximum, entry) => Math.max(maximum, entry.position ?? -1), -1) + seen.size } } : {}) }, { upsert: !server, session });
			} else {
				const now = new Date();
				await Snippet.updateOne({ _id: server._id }, { $set: Libraries.trashFields(ctx.user, now), $inc: { revision: 1 } }, { session });
			}
		}
		await Libraries.validate(await Snippet.find({ library: library._id, state: 'active' }).session(session).lean());
		await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
		await Support.change(ctx.account, library._id, 'snippets', session);
		return { library: Libraries.view(ctx, await Libraries.get(ctx, id, session, true)), conflicts };
	}
	static async batch(ctx, body, session) {
		Support.assert(['move', 'trash'].includes(body.action) && Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 10000, 'Invalid bulk action');
		const source = await Libraries.get(ctx, body.source_library, session);
		Support.assert(Support.access(ctx, source).edit, 'Source library is read-only', 403);
		const destination = body.action === 'move' ? await Libraries.get(ctx, body.destination_library, session) : source;
		Support.assert(Support.access(ctx, destination).edit, 'Destination library is read-only', 403);
		Support.assert(body.action !== 'move' || !Support.equal(source._id, destination._id), 'Choose another library');
		const ids = body.items.map(item => item.id);
		Support.assert(new Set(ids).size === ids.length, 'Repeated snippet selection');
		const selected = source.snippets.filter(entry => ids.includes(entry.id));
		Support.assert(selected.length === ids.length, 'Selection changed; select the snippets again', 409);
		for (const record of selected) {
			const item = body.items.find(item => item.id === record.id);
			Support.assert(item.base_revision === record.revision, 'A selected snippet changed; review the selection', 409);
			Support.assert(item.value === undefined || (body.action === 'move' && selected.length === 1), 'Edits are supported only for a single-snippet move');
		}
		if (body.action === 'trash') {
			await Snippet.updateMany({ account: ctx.account, library: source._id, id: { $in: ids }, state: 'active' }, { $set: Libraries.trashFields(ctx.user), $inc: { revision: 1 } }, { session });
			await Library.updateOne({ _id: source._id }, { $inc: { revision: 1 } }, { session });
			await Support.change(ctx.account, source._id, 'trash', session);
		} else {
			const last = await Snippet.findOne({ library: destination._id }).sort({ position: -1 }).session(session).lean();
			let position = (last?.position ?? -1) + 1;
			for (const record of selected) {
				const item = body.items.find(item => item.id === record.id);
				const change = item.value === undefined ? {} : { trigger: Abbreviation.normalize(item.value.trigger), content: Libraries.content(item.value) };
				await Snippet.updateOne({ _id: record._id }, { $set: { library: destination._id, position: position++, ...change }, $inc: { revision: 1 } }, { session });
				await Conflict.updateMany({ account: ctx.account, library: source._id, snippet: record.id }, { $set: { library: destination._id } }, { session });
			}
			const entries = await Snippet.find({ library: destination._id, state: 'active' }).session(session).lean();
			await Libraries.validate(entries);
			Support.assert(Buffer.byteLength(JSON.stringify(entries)) <= 1048576, 'Destination exceeds the library size limit');
			for (const library of [source, destination]) {
				await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
				const sequence = await Support.change(ctx.account, library._id, 'move', session);
				if (Support.equal(library._id, source._id)) await Change.updateOne({ account: ctx.account, sequence }, { $set: { departures: ids } }, { session });
			}
		}
		const changed = body.action === 'move' ? [source, destination] : [source];
		return { libraries: await Promise.all(changed.map(async library => Libraries.view(ctx, await Libraries.get(ctx, String(library._id), session)))), moved: body.action === 'move' ? ids : [], trashed: body.action === 'trash' ? ids : [] };
	}
	static async trash(ctx, session) {
		const rows = [];
		const now = new Date();
		const libraries = await Library.find({ account: ctx.account, state: { $ne: 'purged' } }).session(session || null).lean();
		for (const library of libraries) {
			const access = Support.access(ctx, library);
			if (!access.read) continue;
			if (library.state === 'trashed' && library.expires_at > now && access.manage) rows.push({ type: 'library', id: String(library._id), library: String(library._id), name: library.name, revision: library.revision, expires_at: library.expires_at, can_restore: true, can_purge: true });
			if (library.state !== 'active' || !access.edit) continue;
			for (const entry of await Snippet.find({ library: library._id, state: 'trashed', expires_at: { $gt: now } }).session(session || null).lean()) rows.push({ type: 'snippet', id: entry.id, library: String(library._id), name: entry.trigger, library_name: library.name, revision: entry.revision, expires_at: entry.expires_at, can_restore: true, can_purge: access.manage });
		}
		return rows;
	}
	static async validateVisible(ctx, session) {
		const libraries = await Libraries.list(ctx, session);
		Support.assert(libraries.length <= 256, 'Active libraries exceed the engine limit', 409);
		const entries = libraries.flatMap(library => library.snippets);
		await Libraries.validate(entries);
		Support.assert(Buffer.byteLength(JSON.stringify(entries)) <= 8 * 1048576, 'Active snippets exceed the engine limit', 409);
		for (const library of libraries) Support.assert(Buffer.byteLength(JSON.stringify(library.snippets)) <= 1048576, 'Library exceeds the engine limit', 409);
	}
	static async purge(library, entry, session) {
		const filter = entry ? { library: library._id, id: entry.id } : { library: library._id };
		const ids = (await Snippet.find(filter).select('id').session(session).lean()).map(row => row.id);
		await Snippet.updateMany(filter, { $set: { state: 'purged' }, $inc: { revision: 1 }, $unset: { trigger: 1, content: 1, position: 1, trashed_by: 1, trashed_at: 1, expires_at: 1 } }, { session });
		await Conflict.deleteMany({ library: library._id, ...(entry ? { snippet: { $in: ids } } : {}) }, { session });
		if (!entry) {
			const readers = [];
			for (const member of await Member.find({ account: library.account }).session(session).lean()) if (Support.access(await Support.context(String(member.user), String(library.account), session), library).read) readers.push(member.user);
			await Library.updateOne({ _id: library._id }, { $set: { state: 'purged', purge_readers: readers }, $unset: { name: 1, members: 1, groups: 1, shared: 1, editable: 1, creator: 1, trashed_at: 1, trashed_by: 1, expires_at: 1 } }, { session });
		}
		await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
		await Support.change(library.account, library._id, 'purge', session);
	}
	static async trashAction(ctx, target, action, session) {
		Support.assert(['library', 'snippet'].includes(target.type) && ['trash', 'restore', 'purge'].includes(action), 'Invalid Trash action');
		const library = await Libraries.get(ctx, target.library, session, true);
		const access = Support.access(ctx, library);
		Support.assert((target.type === 'library' || action === 'purge') ? access.manage : access.edit, 'Not permitted to change this Trash item', 403);
		const record = target.type === 'library' ? library : await Snippet.findOne({ library: library._id, id: target.id }).session(session).lean();
		Support.assert(record && record.state !== 'purged', 'Item permanently removed', 410);
		Support.assert(record.revision === target.revision, 'Item changed; review Trash again', 409);
		Support.assert(action === 'trash' ? record.state === 'active' : record.state === 'trashed', 'Item is no longer in the expected state', 409);
		if (action === 'restore') {
			Support.assert(record.expires_at > new Date(), 'Trash retention expired', 410);
			Support.assert(target.type === 'library' || library.state === 'active', 'Restore the library first', 409);
		}
		if (action === 'purge') await Libraries.purge(library, target.type === 'snippet' ? record : null, session);
		else {
			const model = target.type === 'library' ? Library : Snippet;
			const now = new Date();
			await model.updateOne({ _id: record._id }, { $set: { state: action === 'trash' ? 'trashed' : 'active', ...(action === 'trash' ? { trashed_at: now, expires_at: new Date(+now + Libraries.retention), trashed_by: ctx.user } : {}) }, ...(action === 'restore' ? { $unset: { trashed_at: 1, expires_at: 1, trashed_by: 1 } } : {}), $inc: { revision: 1 } }, { session });
			if (target.type === 'snippet') await Library.updateOne({ _id: library._id }, { $inc: { revision: 1 } }, { session });
			if (action === 'restore') await Libraries.validateVisible(ctx, session);
			await Support.change(ctx.account, library._id, action, session);
		}
		const current = await Library.findById(library._id).session(session).lean();
		return { ...(current.state === 'purged' ? { purged: [String(library._id)] } : { library: Libraries.view(ctx, await Libraries.hydrate(current, session)) }), affected: [target] };
	}
	static async empty(ctx, targets, session) {
		Support.assert(Array.isArray(targets) && targets.length <= 10000, 'Invalid Trash selection');
		const affected = [];
		for (const target of targets) {
			await Libraries.trashAction(ctx, target, 'purge', session);
			affected.push(target);
		}
		return { affected };
	}
	static async cleanup() {
		for (const account of await Account.find({}).select('_id').lean()) {
			await mongoose.connection.transaction(async session => {
				await Account.updateOne({ _id: account._id }, { $inc: { sequence: 1 } }, { session });
				const now = new Date();
				const libraries = await Library.find({ account: account._id, state: 'trashed', expires_at: { $lte: now } }).session(session).lean();
				for (const library of libraries) await Libraries.purge(library, null, session);
				for (const entry of await Snippet.find({ account: account._id, state: 'trashed', expires_at: { $lte: now } }).session(session).lean()) {
					const library = await Library.findById(entry.library).session(session).lean();
					if (library && library.state !== 'purged') await Libraries.purge(library, entry, session);
				}
			});
		}
	}
	static async download(ctx, cursor) {
		Support.assert(Number.isSafeInteger(cursor) && cursor >= 0, 'Invalid cursor');
		let result;
		await mongoose.connection.transaction(async session => {
			ctx = await Support.context(ctx.user, ctx.account, session);
			const account = await Account.findById(ctx.account).session(session).lean();
			const changes = await Change.find({ account: ctx.account, sequence: { $gt: cursor, $lte: account.sequence } }).session(session).lean();
			const all = await Library.find({ account: ctx.account, state: { $ne: 'purged' } }).session(session).lean();
			const visible = all.filter(library => Support.access(ctx, library).read);
			const changed = new Set(changes.map(change => String(change.library)));
			const permissions = changes.some(change => change.kind === 'membership');
			const libraries = await Promise.all(visible.filter(library => cursor === 0 || permissions || changed.has(String(library._id))).map(async library => Libraries.view(ctx, await Libraries.hydrate(library, session))));
			const tombstones = await Snippet.find({ account: ctx.account, library: { $in: visible.map(row => row._id) }, state: 'purged' }).select('library id revision state').session(session).lean();
			const conflicts = await Conflict.find({ account: ctx.account, resolved: false, library: { $in: visible.filter(library => Support.access(ctx, library).edit).map(library => library._id) } }).session(session).lean();
			const purged = (await Library.find({ account: ctx.account, state: 'purged', purge_readers: ctx.user }).select('_id').session(session).lean()).map(row => String(row._id));
			const visibleIds = new Set(visible.map(library => String(library._id)));
			const candidates = changes.filter(change => visibleIds.has(String(change.library))).flatMap(change => (change.departures || []).map(id => ({ library: String(change.library), id })));
			const locations = new Map((await Snippet.find({ account: ctx.account, id: { $in: [...new Set(candidates.map(item => item.id))] } }).select('id library').session(session).lean()).map(record => [record.id, String(record.library)]));
			const departures = [...new Map(candidates.filter(item => locations.has(item.id) && locations.get(item.id) !== item.library).map(item => [item.library + ':' + item.id, item])).values()];
			result = { protocol: 3, departures, purged, cursor: account.sequence, accessible: visible.map(library => String(library._id)), libraries, tombstones, conflicts, trash: await Libraries.trash(ctx, session) };
		}, { readConcern: { level: 'snapshot' } });
		return result;
	}
	static async resolve(ctx, id, body, session) {
		const conflict = await Conflict.findOne({ _id: Support.id(id), account: ctx.account, resolved: false }).session(session).lean();
		Support.assert(conflict, 'Conflict no longer exists', 404);
		const library = await Libraries.get(ctx, String(conflict.library), session, true);
		Support.assert(Support.access(ctx, library).edit, 'Library is read-only', 403);
		Support.assert(body.base_revision === library.revision, 'Library changed; review latest version', 409);
		Support.assert(['local', 'server', 'merged'].includes(body.choice), 'Choose a resolution');
		let result = { library: Libraries.view(ctx, library) };
		if (body.choice !== 'server') {
			Support.assert(library.state === 'active', 'Restore the library before resolving this edit', 409);
			let current = await Snippet.findOne({ library: library._id, id: conflict.snippet }).session(session).lean();
			Support.assert(current?.state !== 'purged', 'Snippet permanently removed', 410);
			const value = body.choice === 'local' ? conflict.local : body.value;
			if (current?.state === 'trashed' && value) {
				await Libraries.trashAction(ctx, { type: 'snippet', id: current.id, library: String(library._id), revision: current.revision }, 'restore', session);
				current = await Snippet.findById(current._id).session(session).lean();
			}
			const fresh = await Library.findById(library._id).session(session).lean();
			result = await Libraries.upload(ctx, String(library._id), { base_revision: fresh.revision, changes: [{ id: conflict.snippet, base_revision: current?.revision ?? null, value }] }, session);
		}
		await Conflict.updateOne({ _id: conflict._id }, { $set: { resolved: true } }, { session });
		return { ...result, resolved: id };
	}
}
