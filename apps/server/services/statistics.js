import { mongoose, UsageEvent, StatisticsPreference, Library, Snippet, User, Member } from '../model/index.js';
import { Support } from './support.js';
import { Billing } from './billing.js';
import { AccountAccess } from './account_access.js';

export class Statistics {
	static defaults = { wpm: 50, hourly_rate: 30, currency: 'USD' };
	static scope(ctx, value = 'personal') {
		Support.assert(['personal', 'team'].includes(value), 'Invalid statistics scope');
		if (value === 'team') { Support.assert(Support.admin(ctx), 'Admin required', 403); Billing.assertTeam(ctx); }
		return { account: ctx.account, user: value === 'team' ? null : ctx.user };
	}
	static settings(body) {
		const wpm = Number(body.wpm); const hourly_rate = Number(body.hourly_rate); const currency = String(body.currency || '').toUpperCase();
		Support.assert(Number.isFinite(wpm) && wpm >= 1 && wpm <= 1000, 'Typing speed must be between 1 and 1,000 WPM');
		Support.assert(Number.isFinite(hourly_rate) && hourly_rate >= 0 && hourly_rate <= 1000000, 'Hourly rate must be between 0 and 1,000,000');
		Support.assert(Intl.supportedValuesOf('currency').includes(currency), 'Choose a valid currency');
		return { wpm, hourly_rate, currency };
	}
	static async preferences(ctx, scope, body) {
		const filter = Statistics.scope(ctx, scope);
		if (body) { const value = Statistics.settings(body); await StatisticsPreference.updateOne(filter, { $set: value }, { upsert: true }); return value; }
		return { ...Statistics.defaults, ...await StatisticsPreference.findOne(filter).select('wpm hourly_rate currency -_id').lean() };
	}
	static event(value) {
		Support.assert(value && typeof value.event_id === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value.event_id), 'Invalid usage event ID');
		Support.assert(['copy', 'insert'].includes(value.action), 'Invalid usage action');
		Support.assert(['web', 'desktop', 'terminal', 'extension', 'ios', 'android', 'mobile'].includes(value.client), 'Invalid usage client');
		Support.assert(typeof value.snippet === 'string' && value.snippet.length <= 100 && value.snippet.length > 0, 'Invalid snippet ID');
		Support.assert(typeof value.occurred_at === 'string' || typeof value.occurred_at === 'number', 'Invalid usage date');
		const occurred_at = new Date(value.occurred_at);
		Support.assert(Number.isFinite(occurred_at.getTime()) && occurred_at.getTime() >= 0 && occurred_at.getTime() <= Date.now() + 300000, 'Invalid usage date');
		Support.assert(Number.isSafeInteger(value.characters) && value.characters >= 0 && value.characters <= 10000000, 'Invalid character count');
		return { event_id: value.event_id, library: Support.id(value.library), snippet: value.snippet, action: value.action, client: value.client, occurred_at, characters: value.characters, shared: value.shared === true };
	}
	static async ingest(ctx, body) {
		if (body.identity) Support.assert(body.identity.user === String(ctx.user) && body.identity.account === String(ctx.account), 'Usage belongs to another account', 409);
		Support.assert(Array.isArray(body.events) && body.events.length <= 100, 'Send at most 100 usage events');
		const events = []; const accepted = []; const discarded = [];
		// Discard malformed events individually so one bad event cannot block the client's queue.
		for (const value of body.events) { try { events.push(Statistics.event(value)); } catch { if (typeof value?.event_id === 'string') discarded.push(value.event_id); } }
		if (!events.length) return { accepted, discarded };
		const malformed = [...discarded];
		await AccountAccess.write(ctx.account, async session => {
			accepted.length = 0; discarded.splice(0, discarded.length, ...malformed);
			const libraries = new Map((await Library.find({ account: ctx.account, _id: { $in: events.map(event => event.library) } }).session(session).lean()).map(row => [String(row._id), row]));
			const snippets = new Set((await Snippet.find({ account: ctx.account, id: { $in: events.map(event => event.snippet) } }).select('id library').session(session).lean()).map(row => row.id + ':' + row.library));
			const previous = new Set((await UsageEvent.find({ account: ctx.account, user: ctx.user, event_id: { $in: events.map(event => event.event_id) } }).select('event_id').session(session).lean()).map(row => row.event_id));
			const inserts = [];
			for (const event of events) {
				if (previous.has(event.event_id)) { accepted.push(event.event_id); continue; }
				const library = libraries.get(event.library);
				if (!library || !Support.access(ctx, library).read || !snippets.has(event.snippet + ':' + event.library)) { discarded.push(event.event_id); continue; }
				inserts.push({ ...event, account: ctx.account, user: ctx.user, shared: event.shared && library.shared === true });
				previous.add(event.event_id);
				accepted.push(event.event_id);
			}
			if (inserts.length) await UsageEvent.insertMany(inserts, { session });
		});
		return { accepted, discarded };
	}
	static options(query) {
		const timezone = query.timezone || 'UTC';
		try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { Support.assert(false, 'Invalid timezone'); }
		const range = query.range || '30'; Support.assert(['7', '30', '90', 'all', 'custom'].includes(range), 'Invalid date range');
		const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
		const end = range === 'custom' ? query.end : today;
		const start = range === 'custom' ? query.start : range === 'all' ? '1970-01-01' : new Date(Date.parse(today + 'T12:00:00Z') - (Number(range) - 1) * 86400000).toISOString().slice(0, 10);
		for (const date of [start, end]) Support.assert(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date, 'Choose valid dates');
		Support.assert(start <= end, 'Start date must precede end date');
		return { timezone, range, start, end };
	}
	static totals(row, settings) {
		const uses = row?.uses || 0; const copies = row?.copies || 0; const characters = row?.characters || 0; const minutes = characters / (5 * settings.wpm);
		return { uses, copies, insertions: uses - copies, characters, minutes, money: minutes / 60 * settings.hourly_rate };
	}
	static async report(ctx, query) {
		const scope = query.scope || 'personal'; Statistics.scope(ctx, scope);
		const options = Statistics.options(query); const settings = await Statistics.preferences(ctx, scope);
		const libraries = await Library.find({ account: ctx.account }).select('_id account name shared state creator members groups purge_readers').lean();
		const privateIds = libraries.filter(row => row.state !== 'purged' && !row.shared).map(row => row._id);
		const match = { account: new mongoose.Types.ObjectId(ctx.account), ...(scope === 'personal' ? { user: new mongoose.Types.ObjectId(ctx.user) } : { shared: true, library: { $nin: privateIds } }), occurred_at: { $gte: new Date(Date.parse(options.start) - 86400000), $lt: new Date(Date.parse(options.end) + 2 * 86400000) } };
		const group = key => ({ $group: { _id: key, uses: { $sum: 1 }, copies: { $sum: { $cond: [{ $eq: ['$action', 'copy'] }, 1, 0] } }, characters: { $sum: '$characters' } } });
		const pipeline = [{ $match: match }, { $set: { day: { $dateToString: { date: '$occurred_at', format: '%Y-%m-%d', timezone: options.timezone } } } }, { $match: { day: { $gte: options.start, $lte: options.end } } }, { $facet: { totals: [group(null)], days: [group('$day'), { $sort: { _id: 1 } }], snippets: [group({ snippet: '$snippet', library: '$library' }), { $sort: { uses: -1, '_id.snippet': 1 } }], libraries: [group('$library'), { $sort: { uses: -1, _id: 1 } }], ...(scope === 'team' ? { members: [group('$user'), { $sort: { uses: -1, _id: 1 } }] } : {}) } }];
		const [data] = await UsageEvent.aggregate(pipeline).allowDiskUse(true);
		const visible = libraries.filter(row => row.state === 'active' && Support.access(ctx, row).read);
		const snippets = await Snippet.find({ account: ctx.account, library: { $in: visible.map(row => row._id) }, state: 'active', id: { $in: data.snippets.map(row => row._id.snippet) } }).select('id title trigger library').lean();
		const members = scope === 'team' ? await Member.find({ account: ctx.account }).select('user').lean() : [];
		const users = await User.find({ _id: { $in: members.map(row => row.user) } }).select('name').lean();
		const names = new Map(visible.map(row => [String(row._id), row.name])); const snippetRows = new Map(snippets.map(row => [row.id + ':' + row.library, row])); const userNames = new Map(users.map(row => [String(row._id), row.name]));
		const libraryName = id => names.get(String(id)) || 'Deleted or unavailable library';
		return { scope, options, settings, totals: Statistics.totals(data.totals[0], settings), days: data.days.map(row => ({ id: row._id, name: row._id, ...Statistics.totals(row, settings) })), snippets: data.snippets.map(row => { const snippet = snippetRows.get(row._id.snippet + ':' + row._id.library); return { id: row._id.snippet + ':' + row._id.library, name: snippet?.title || snippet?.trigger || 'Deleted or unavailable snippet', library: libraryName(row._id.library), ...Statistics.totals(row, settings) }; }), libraries: data.libraries.map(row => ({ id: String(row._id), name: libraryName(row._id), ...Statistics.totals(row, settings) })), members: (data.members || []).map(row => ({ id: String(row._id), name: userNames.get(String(row._id)) || 'Former member', ...Statistics.totals(row, settings) })) };
	}
	static csv(report) {
		const cell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
		const rows = [['Report', 'Name', 'Library', 'Uses', 'Characters saved', 'Estimated minutes saved', 'Estimated money saved', 'Currency', 'WPM', 'Hourly rate']];
		for (const kind of ['totals', 'days', 'snippets', 'libraries', 'members']) for (const row of (kind === 'totals' ? report.totals ? [{ name: 'Total', ...report.totals }] : [] : report[kind])) rows.push([kind, row.name, row.library || '', row.uses, row.characters, row.minutes.toFixed(2), row.money.toFixed(2), report.settings.currency, report.settings.wpm, report.settings.hourly_rate]);
		return rows.map(row => row.map(cell).join(',')).join('\r\n');
	}
}
