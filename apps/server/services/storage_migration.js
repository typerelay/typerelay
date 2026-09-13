import { mongoose, Library, Snippet, Migration, MigrationBackup, Operation } from '../model/index.js';
import { Yaml } from './support.js';
export class StorageMigration {
	static async code() {
		if ((await Migration.findOne({ key: 'code-v4' }).lean())?.completed) return;
		for (const name of ['libraries', 'snippets', 'operations', 'conflicts', 'accounts', 'changes']) {
			for await (const record of mongoose.connection.collection(name).find({})) await MigrationBackup.updateOne({ key: 'code-v4:' + name + ':' + record._id }, { $setOnInsert: { source_collection: name, payload: record } }, { upsert: true });
		}
		const indexes = await Snippet.collection.indexes().catch(error => { if (error.code === 26) return []; throw error; });
		const old = indexes.find(index => index.name === 'library_1_trigger_1');
		if (old && !old.partialFilterExpression?.trigger) await Snippet.collection.dropIndex(old.name);
		await Snippet.createIndexes();
		await Migration.updateOne({ key: 'code-v4' }, { $set: { completed: true } }, { upsert: true });
	}
	static async run() {
		if ((await Migration.findOne({ key: 'records-v2' }).lean())?.completed) return;
		for (const name of ['libraries', 'operations', 'conflicts', 'accounts', 'changes']) {
			for await (const record of mongoose.connection.collection(name).find({})) await MigrationBackup.updateOne({ key: 'records-v2:' + name + ':' + record._id }, { $setOnInsert: { source_collection: name, payload: record } }, { upsert: true });
		}
		for await (const legacy of Library.collection.find({ $or: [{ yaml: { $exists: true } }, { snippets: { $exists: true } }] })) {
			await mongoose.connection.transaction(async session => {
				const source = await Library.collection.findOne({ _id: legacy._id }, { session });
				if (!source?.snippets) return;
				await Yaml.validate(source.snippets.map(entry => ({ trigger: entry.trigger, replace: entry.replace })));
				for (const [position, entry] of source.snippets.entries()) await Snippet.updateOne({ library: source._id, id: entry.id }, { $setOnInsert: { account: source.account, trigger: entry.trigger, content: { version: 1, type: 'plain_text', text: entry.replace }, position, revision: entry.revision, state: 'active' } }, { upsert: true, session });
				const now = new Date();
				await Library.collection.updateOne({ _id: source._id }, { $set: { state: source.deleted ? 'trashed' : 'active', ...(source.deleted ? { trashed_at: now, expires_at: new Date(+now + 30 * 86400000), trashed_by: 'migration' } : {}) }, $unset: { yaml: '', snippets: '', deleted: '' } }, { session });
			});
		}
		// Old receipts are acknowledged without retaining their content-bearing library snapshots.
		for await (const operation of Operation.find({ 'result.library': { $exists: true } }).lean().cursor()) await Operation.updateOne({ _id: operation._id }, { $set: { result: { library_id: String(operation.result.library._id), versions: Object.fromEntries((operation.result.library.snippets || []).map(entry => [entry.id, entry.revision])), conflicts: operation.result.conflicts || [] } } });
		await Migration.updateOne({ key: 'records-v2' }, { $set: { completed: true } }, { upsert: true });
	}
}
