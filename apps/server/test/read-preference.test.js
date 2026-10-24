import { TestDatabase } from './database.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoose, User, SystemSetting, UsageEvent } from '../model/index.js';

before(async () => {
	await mongoose.connect(TestDatabase.uri(process.env.MONGO_URI, 'typerelay_read_preference_test'));
	await TestDatabase.drop(mongoose.connection, 'typerelay_read_preference_test');
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
after(async () => { await TestDatabase.drop(mongoose.connection, 'typerelay_read_preference_test'); await mongoose.disconnect(); });

test('read-mostly models read from secondaries outside transactions and keep working inside them', async () => {
	const outside = SystemSetting.findOne({ key: 'ai' }).lean();
	await outside;
	assert.equal(outside.getOptions().readPreference?.mode, 'secondaryPreferred');
	const report = UsageEvent.aggregate([{ $match: {} }]);
	await report;
	assert.equal(report.options.readPreference?.mode, 'secondaryPreferred');
	const identity = User.findOne({}).lean();
	await identity;
	assert.equal(identity.getOptions().readPreference, undefined);
	await mongoose.connection.transaction(async session => {
		const inside = SystemSetting.findOne({ key: 'ai' }).session(session).lean();
		await inside;
		assert.equal(inside.getOptions().readPreference, undefined);
		await UsageEvent.aggregate([{ $match: {} }]).session(session);
		assert.equal(await SystemSetting.countDocuments({}).session(session), 0);
	});
});
