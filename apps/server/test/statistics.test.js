import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoose, Account, User, Member, Library, Snippet, UsageEvent, StatisticsPreference } from '../model/index.js';
import { Statistics } from '../services/statistics.js';
import { Support } from '../services/support.js';

class Fixture {
	static owner; static member; static account; static shared; static private;
	static event(library, extra = {}) { return { event_id: randomUUID(), library: String(library._id), snippet: 'snippet-' + library._id, action: 'insert', client: 'desktop', occurred_at: new Date().toISOString(), characters: 15000, shared: library.shared, ...extra }; }
	static async user(role) { const user = await User.create({ email: randomUUID() + '@example.test', name: role }); await Member.create({ account: Fixture.account._id, user: user._id, role }); return Support.context(String(user._id), String(Fixture.account._id)); }
	static query = { range: 'all', timezone: 'UTC' };
}
before(async () => {
	const uri = new URL(process.env.MONGO_URI); uri.pathname = '/typerelay_statistics_test';
	await mongoose.connect(uri.toString()); await mongoose.connection.dropDatabase();
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
	Fixture.account = await Account.create({ name: 'Statistics', plan: 'team', admin_override: { plan: 'team' } });
	Fixture.owner = await Fixture.user('owner'); Fixture.member = await Fixture.user('member');
	for (const name of ['shared', 'private']) { const library = await Library.create({ account: Fixture.account._id, creator: Fixture.owner.user, name, shared: name === 'shared', members: [Fixture.member.user], state: 'active' }); Fixture[name] = library; await Snippet.create({ account: Fixture.account._id, library: library._id, id: 'snippet-' + library._id, title: name, trigger: name, state: 'active' }); }
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('defaults, estimates, validation and CSV formula escaping', () => {
	assert.deepEqual(Statistics.defaults, { wpm: 50, hourly_rate: 30, currency: 'USD' });
	assert.deepEqual(Statistics.totals({ uses: 2, copies: 1, characters: 15000 }, Statistics.defaults), { uses: 2, copies: 1, insertions: 1, characters: 15000, minutes: 60, money: 30 });
	for (const body of [{ wpm: 0, hourly_rate: 30, currency: 'USD' }, { wpm: 50, hourly_rate: -1, currency: 'USD' }, { wpm: 50, hourly_rate: 30, currency: 'BAD' }]) assert.throws(() => Statistics.settings(body));
	assert.throws(() => Statistics.options({ range: 'custom', start: '2026-02-30', end: '2026-03-01' }));
	assert.throws(() => Statistics.options({ timezone: 'bad-zone' }));
	const csv = Statistics.csv({ settings: Statistics.defaults, days: [], snippets: [{ name: '=SUM(1)', library: 'a,"b', uses: 1, copies: 1, insertions: 0, characters: 1, minutes: 1, money: 0.5 }], libraries: [], members: [] });
	assert.match(csv, /'=SUM/); assert.match(csv, /a,""b/);
});
test('retry deduplication, account binding and personal/team isolation', async () => {
	const event = Fixture.event(Fixture.shared);
	await Statistics.ingest(Fixture.owner, { events: [event, event] });
	await Statistics.ingest(Fixture.owner, { events: [event] });
	assert.equal(await UsageEvent.countDocuments(), 1);
	await Statistics.ingest(Fixture.owner, { events: [Fixture.event(Fixture.private, { action: 'copy' })] });
	await Statistics.ingest(Fixture.member, { events: [Fixture.event(Fixture.shared, { characters: 250 })] });
	const personal = await Statistics.report(Fixture.owner, Fixture.query); assert.equal(personal.totals.uses, 2); assert.equal(personal.totals.money, 60);
	const member = await Statistics.report(Fixture.member, Fixture.query); assert.equal(member.totals.uses, 1);
	const team = await Statistics.report(Fixture.owner, { ...Fixture.query, scope: 'team' }); assert.equal(team.totals.uses, 2); assert.equal(team.members.length, 2); assert.equal(team.snippets.length, 1); assert.equal(team.snippets[0].name, 'shared'); assert.equal(team.libraries[0].name, 'shared');
	await assert.rejects(Statistics.report(Fixture.member, { ...Fixture.query, scope: 'team' }), /Admin required/);
	await assert.rejects(Statistics.ingest(Fixture.owner, { identity: { account: Fixture.owner.account, user: Fixture.member.user }, events: [event] }), /another account/);
	const rejected = await Statistics.ingest(Fixture.member, { events: [Fixture.event(Fixture.private)] }); assert.equal(rejected.discarded.length, 1);
});
test('saved preferences override defaults and affect existing history independently', async () => {
	await Statistics.preferences(Fixture.owner, 'personal', { wpm: 100, hourly_rate: 40, currency: 'EUR' });
	const personal = await Statistics.report(Fixture.owner, Fixture.query); assert.equal(personal.settings.currency, 'EUR'); assert.equal(personal.totals.minutes, 60); assert.equal(personal.totals.money, 40);
	assert.deepEqual(await Statistics.preferences(Fixture.owner, 'team'), Statistics.defaults);
	await assert.rejects(Statistics.preferences(Fixture.member, 'team', Statistics.defaults), /Admin required/);
	assert.equal(await StatisticsPreference.countDocuments(), 1);
});
test('timezone boundaries, private transitions, deletion labels and former members', async () => {
	const event = Fixture.event(Fixture.shared, { occurred_at: '2026-09-25T00:30:00Z', characters: 1 });
	await Statistics.ingest(Fixture.owner, { events: [event] });
	const report = await Statistics.report(Fixture.owner, { range: 'custom', start: '2026-09-24', end: '2026-09-24', timezone: 'America/New_York' }); assert.equal(report.days[0].id, '2026-09-24'); assert((await Statistics.report(Fixture.owner, { range: 'all', timezone: 'America/New_York' })).days.some(row => row.id === '2026-09-24'));
	await Library.updateOne({ _id: Fixture.shared._id }, { $set: { shared: false } });
	assert.equal((await Statistics.report(Fixture.owner, { ...Fixture.query, scope: 'team' })).totals.uses, 0);
	await Library.updateOne({ _id: Fixture.shared._id }, { $set: { state: 'purged', name: '' }, $unset: { shared: 1 } });
	await Snippet.updateMany({ library: Fixture.shared._id }, { $set: { state: 'purged', title: '' } });
	await Member.deleteOne({ account: Fixture.account._id, user: Fixture.member.user });
	const historical = await Statistics.report(Fixture.owner, { ...Fixture.query, scope: 'team' }); assert.equal(historical.totals.uses, 3); assert.equal(historical.snippets[0].name, 'Deleted or unavailable snippet'); assert(historical.members.some(row => row.name === 'Former member'));
});
