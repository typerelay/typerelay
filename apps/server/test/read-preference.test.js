import { TestDatabase } from './database.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoose, Passkey, AiUsage, AiRequest, SystemSetting, UsageEvent } from '../model/index.js';

before(async () => {
	await mongoose.connect(TestDatabase.uri(process.env.MONGO_URI, 'typerelay_read_preference_test'));
	await TestDatabase.drop(mongoose.connection, 'typerelay_read_preference_test');
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
after(async () => { await TestDatabase.drop(mongoose.connection, 'typerelay_read_preference_test'); await mongoose.disconnect(); });

test('models set secondaryPreferred in schema options like Helpmonks, except models Helpmonks keeps on the default', () => {
	const primary = [Passkey, AiUsage, AiRequest];
	for (const model of Object.values(mongoose.models)) assert.equal(model.schema.options.read ?? undefined, primary.includes(model) ? undefined : 'secondaryPreferred', model.modelName);
	for (const name of ['User', 'Account', 'Member']) assert.equal(mongoose.model(name).schema.options.read, 'secondaryPreferred', name);
});

test('transaction reads on secondaryPreferred models must chain read primary', async () => {
	await mongoose.connection.transaction(async session => {
		await assert.rejects(SystemSetting.findOne({ key: 'ai' }).session(session).lean(), /must be primary/);
	});
	await mongoose.connection.transaction(async session => {
		assert.equal(await SystemSetting.findOne({ key: 'ai' }).session(session).read('primary').lean(), null);
		assert.deepEqual(await UsageEvent.aggregate([{ $match: {} }]).session(session).read('primary'), []);
		assert.equal(await SystemSetting.countDocuments({}).session(session).read('primary'), 0);
	});
});
