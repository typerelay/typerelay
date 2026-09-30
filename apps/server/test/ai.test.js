import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { mongoose, User, Account, Member, Library, Snippet, AiSetting, AiUsage, AiRequest, SystemSetting } from '../model/index.js';
import { Ai, AiProvider } from '../ai/index.js';
import { Support, Fault } from '../services/support.js';
import { Billing } from '../services/billing.js';
import { AdminSettings } from '../services/admin_settings.js';

class Fixture {
	static saved = {};
	static async context(role = 'owner', account = null) {
		const user = await User.create({ email: randomUUID() + '@example.test', name: role });
		account ||= await Account.create({ name: 'AI test', admin_override: { plan: 'team' } });
		await Member.create({ account: account._id, user: user._id, role });
		return Support.context(String(user._id), String(account._id));
	}
	static async configure(ctx, scope = 'personal', key = 'private-test-key', installation = false) {
		const result = await Ai.connection(ctx, scope, { name: scope, provider: 'openai', api_key: key }, installation);
		const body = { enabled: true, routes: { authoring: { connection: result.id, model: 'gpt-6-luna', protocol: 'auto' } }, daily_limit: 50, private_endpoints: '' };
		await Ai.save(ctx, scope, body, installation);
		return result;
	}
	static author(extra = {}) { return { request_id: randomUUID(), action: 'improve', prompt: 'Make it clearer', entry: { title: 'Greeting', trigger: 'hello', content: { version: 1, type: 'plain_text', text: 'Hello there' } }, ...extra }; }
	static async provider(action, body) {
		const previous = AiProvider.request; const calls = [];
		AiProvider.request = async (connection, installation, path, options = {}) => { if (options.dispatch) await options.dispatch(); calls.push({ connection, path, body: options.body }); return body ? body(calls.at(-1), calls.length) : { status: 'completed', output_text: '{"text":"Hello, friend","title":"Greeting"}' }; };
		try { return await action(calls); } finally { AiProvider.request = previous; }
	}
}
before(async () => {
	for (const key of ['GIT_ENCRYPTION_KEY', 'TYPERELAY_HOSTED_EDITION', 'BILLING_ENABLED']) Fixture.saved[key] = process.env[key];
	process.env.GIT_ENCRYPTION_KEY = 'a'.repeat(64); process.env.TYPERELAY_HOSTED_EDITION = 'false'; process.env.BILLING_ENABLED = 'false';
	const uri = new URL(process.env.MONGO_URI); uri.pathname = '/typerelay_ai_test';
	await mongoose.connect(uri.toString()); await mongoose.connection.dropDatabase(); await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
after(async () => { for (const [key, value] of Object.entries(Fixture.saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test('provider request shapes, endpoint selection and response validation', async () => {
	const responses = { chat: { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }, responses: { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }, anthropic: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] }, gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hidden reasoning', thought: true }, { text: 'OK' }] } }] } };
	await Fixture.provider(async calls => {
		for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
			const text = await AiProvider.generate({ provider: 'openai', key: 'unit-key' }, {}, { model: 'gpt-6-luna', protocol }, 'System', 'Input', { tokens: 256 });
			assert.equal(text, 'OK'); const call = calls.at(-1);
			assert.equal(call.body.max_tokens || call.body.max_completion_tokens || call.body.max_output_tokens || call.body.generationConfig?.maxOutputTokens, 256);
			assert.ok(!JSON.stringify(call.body).includes('unit-key'));
			if (protocol === 'responses') { assert.equal(call.path, '/responses'); assert.equal(call.body.store, false); assert.deepEqual(call.body.reasoning, { effort: 'none' }); }
			if (protocol === 'chat') assert.equal(call.body.reasoning_effort, 'none');
		}
	}, call => responses[call.path === '/responses' ? 'responses' : call.path === '/messages' ? 'anthropic' : call.path.startsWith('/models/') ? 'gemini' : 'chat']);
	assert.equal(AiProvider.protocol({ provider: 'opencode' }, { model: 'claude-sonnet-4-6' }), 'anthropic');
	assert.equal(AiProvider.protocol({ provider: 'opencode' }, { model: 'gemini-3-flash' }), 'gemini');
	assert.equal(AiProvider.protocol({ provider: 'opencode' }, { model: 'gpt-6-luna' }), 'responses');
	assert.equal(AiProvider.protocol({ provider: 'opencode' }, { model: 'kimi-k2.5' }), 'chat');
	assert.throws(() => AiProvider.protocol({ provider: 'opencode' }, { model: 'jev-1.13' }), /text-generation/);
	assert.throws(() => AiProvider.endpoint({ provider: 'compatible', base_url: 'https://user:password@example.com/v1' }), /base URL/);
	assert.throws(() => AiProvider.json('not json'), /invalid proposal/);
	await Fixture.provider(() => assert.rejects(AiProvider.generate({ provider: 'openai' }, {}, { model: 'test', protocol: 'responses' }, '', ''), /incomplete/), () => ({ status: 'incomplete', output_text: 'Partial' }));
});

test('public/custom network policy and pinned local HTTP requests', async () => {
	await assert.rejects(AiProvider.addresses(new URL('http://127.0.0.1:9876/v1'), Ai.defaults), /approved/);
	process.env.TYPERELAY_HOSTED_EDITION = 'true';
	assert.throws(() => AiProvider.endpoint({ provider: 'compatible', base_url: 'http://127.0.0.1/v1' }), /HTTPS/);
	await assert.rejects(AiProvider.addresses(new URL('https://127.0.0.1/v1'), { private_endpoints: ['https://127.0.0.1'] }), /approved/);
	process.env.TYPERELAY_HOSTED_EDITION = 'false';
	const server = http.createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer mock-private-key'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = 'http://127.0.0.1:' + server.address().port;
	try { assert.equal(await AiProvider.generate({ provider: 'compatible', base_url: origin + '/v1', key: 'mock-private-key' }, { private_endpoints: [origin] }, { model: 'local-model', protocol: 'auto' }, 'Test', 'Hello'), 'OK'); } finally { await new Promise(resolve => server.close(resolve)); }
});

test('private/team/installation precedence, masks, isolation and model inheritance', async () => {
	const owner = await Fixture.context(); const account = await Account.findById(owner.account).lean(); const member = await Fixture.context('member', account);
	await Fixture.configure(null, 'installation', 'managed-test-key', true);
	await Fixture.configure(owner, 'team', 'team-test-key');
	await Fixture.configure(owner);
	const state = await Ai.state(owner); assert.equal(Ai.route(state, 'search').scope, 'personal');
	assert.equal(Ai.route(await Ai.state(member), 'search').scope, 'team');
	const summary = await Ai.settings(owner, 'personal'); assert.equal(summary.settings.connections[0].key_configured, true); assert.ok(!JSON.stringify(summary).includes('private-test-key')); assert.ok(!JSON.stringify(summary).includes('managed-test-key'));
	const stored = await AiSetting.findOne({ account: owner.account, user: owner.user }).select('+connections').lean(); assert.notEqual(stored.connections[0].secret, 'private-test-key'); assert.equal(AdminSettings.decrypt(stored.connections[0].secret), 'private-test-key');
	await assert.rejects(Ai.settings(member, 'team'), /Admin required/);
	const foreign = await Fixture.context(); assert.equal((await Ai.settings(foreign, 'personal')).settings.connections.length, 0);
	await assert.rejects(Ai.selected(member, { scope: 'personal', connection: summary.settings.connections[0].id }), /Save a connection/);
	const current = await Ai.setting(owner, 'personal'); await Ai.save(owner, 'personal', { enabled: true, routes: current.routes, revision: current.revision });
	await assert.rejects(Ai.save(owner, 'personal', { enabled: true, routes: {}, revision: current.revision }), /changed/);
});

test('authoring yields a validated proposal without changing snippets', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx); const count = await Snippet.countDocuments();
	await Fixture.provider(async calls => { const result = await Ai.author(ctx, Fixture.author()); assert.equal(result.proposal.content.text, 'Hello, friend'); assert.equal(result.proposal.trigger, 'hello'); assert.equal(await Snippet.countDocuments(), count); assert.equal(calls[0].connection.key, 'private-test-key'); assert.equal(await AiUsage.countDocuments({ account: ctx.account }), 0); });
	const definitions = { name: { label: 'Name', default: '', required: true, multiline: false, format: '', timezone: 'local' } };
	await Fixture.provider(async () => { const result = await Ai.author(ctx, Fixture.author({ action: 'template', entry: { title: 'Name', content: { version: 1, type: 'template', text: 'Hello {{name}}, from London', variables: definitions } } })); assert.deepEqual(result.proposal.content.variables.name, definitions.name); assert.equal(result.proposal.content.variables.city.required, true); }, () => ({ status: 'completed', output_text: '{"title":"Name","text":"Hello {{name}}, from {{city}}"}' }));
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author({ entry: { content: { version: 1, type: 'template', text: 'Hello {{name}}', variables: definitions } } })), /existing template variable/));
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author()), /Enter action/), () => ({ status: 'completed', output_text: '{"title":"Bad","text":"Run {{key:enter}}"}' }));
});

test('disabled policies block all authoring/search inference and keep connections', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx);
	await Ai.save(ctx, 'personal', { enabled: false, routes: (await Ai.setting(ctx, 'personal')).routes });
	await Fixture.provider(async calls => { await assert.rejects(Ai.author(ctx, Fixture.author()), /disabled/); await assert.rejects(Ai.search(ctx, { request_id: randomUUID(), query: 'refund' }), /disabled/); assert.equal(calls.length, 0); });
	assert.equal((await Ai.setting(ctx, 'personal')).connections.length, 1);
	await Ai.save(ctx, 'personal', { enabled: true, routes: (await Ai.setting(ctx, 'personal')).routes });
	await Ai.save(ctx, 'team', { enabled: false, routes: {} });
	await Fixture.provider(async calls => { await assert.rejects(Ai.author(ctx, Fixture.author()), /disabled/); assert.equal(calls.length, 0); });
	await Ai.save(ctx, 'team', { enabled: true, routes: {} });
	const installation = await Ai.installation(); await Ai.save(null, 'installation', { ...installation, enabled: false, private_endpoints: '' }, true);
	await Fixture.provider(async calls => { await assert.rejects(Ai.author(ctx, Fixture.author()), /disabled/); assert.equal(calls.length, 0); });
	await Ai.save(null, 'installation', { ...await Ai.installation(), enabled: true, private_endpoints: '' }, true);
});

test('selected connection failure never switches provider or credential source', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx);
	await Fixture.provider(async calls => { await assert.rejects(Ai.author(ctx, Fixture.author()), /provider failure/); assert.equal(calls.length, 1); assert.equal(calls[0].connection.key, 'private-test-key'); }, () => { throw new Fault(502, 'Mock provider failure'); });
});

test('hosted managed allowance is atomic, per-user, UTC-bound and replay protected', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true'; process.env.BILLING_ENABLED = 'true';
	const ctx = await Fixture.context(); const installation = await Ai.installation(); await Ai.save(null, 'installation', { ...installation, daily_limit: 3, private_endpoints: '' }, true);
	const resolved = { managed: true };
	const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => Ai.reserve(ctx, randomUUID(), 'search', resolved, { daily_limit: 3 })));
	assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 3); assert.equal((await AiUsage.findOne({ account: ctx.account, user: ctx.user }).lean()).count, 3);
	const other = await Fixture.context('member', await Account.findById(ctx.account).lean()); await Ai.reserve(other, randomUUID(), 'search', resolved, { daily_limit: 3 }); assert.equal((await AiUsage.findOne({ account: ctx.account, user: other.user }).lean()).count, 1);
	const id = randomUUID(); const unique = await Fixture.context(); await Ai.reserve(unique, id, 'authoring', resolved, { daily_limit: 50 }); await assert.rejects(Ai.reserve(unique, id, 'authoring', resolved, { daily_limit: 50 }), /already ran/); assert.equal((await AiUsage.findOne({ account: unique.account }).lean()).count, 1);
	assert.match((await AiUsage.findOne({ account: unique.account }).lean()).day, /^\d{4}-\d{2}-\d{2}$/);
	const free = await Fixture.context(); await Account.updateOne({ _id: free.account }, { $set: { 'admin_override.plan': 'free' } });
	await Fixture.provider(async calls => { await assert.rejects(Ai.author(free, Fixture.author()), /Pro\/Team/); assert.equal(calls.length, 0); });
	await Fixture.configure(free);
	await Fixture.provider(async () => { await Ai.author(free, Fixture.author()); assert.equal(await AiUsage.countDocuments({ account: free.account }), 0); });
	await Ai.save(null, 'installation', { ...await Ai.installation(), daily_limit: 50, private_endpoints: '' }, true);
	process.env.TYPERELAY_HOSTED_EDITION = 'false'; process.env.BILLING_ENABLED = 'false';
});

test('managed reservations are released before dispatch and retained after dispatch', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true'; const ctx = await Fixture.context();
	const previous = AiProvider.request;
	try {
		AiProvider.request = async () => { throw new Fault(422, 'Endpoint rejected before dispatch'); };
		await assert.rejects(Ai.author(ctx, Fixture.author()), /before dispatch/); assert.equal((await AiUsage.findOne({ account: ctx.account }).lean()).count, 0);
		AiProvider.request = async (connection, installation, path, options) => { await options.dispatch(); throw new Fault(502, 'Failure after dispatch'); };
		await assert.rejects(Ai.author(ctx, Fixture.author()), /after dispatch/); assert.equal((await AiUsage.findOne({ account: ctx.account }).lean()).count, 1);
	} finally { AiProvider.request = previous; process.env.TYPERELAY_HOSTED_EDITION = 'false'; }
});

test('AI search ranks existing authorized snippets and transient local records only', async () => {
	const owner = await Fixture.context(); const account = await Account.findById(owner.account).lean(); const member = await Fixture.context('member', account); await Fixture.configure(member);
	const shared = await Library.create({ account: owner.account, creator: owner.user, name: 'Shared', shared: true, members: [member.user], state: 'active', revision: 1 });
	const privateLibrary = await Library.create({ account: owner.account, creator: owner.user, name: 'Private', shared: false, state: 'active', revision: 1 });
	await Snippet.create([{ account: owner.account, library: shared._id, id: 'shared-refund', title: 'Refund', content: { version: 1, type: 'plain_text', text: 'Refund within 14 days' }, revision: 1, state: 'active' }, { account: owner.account, library: privateLibrary._id, id: 'private-refund', title: 'Refund', content: { version: 1, type: 'plain_text', text: 'Private sensitive refund instructions' }, revision: 1, state: 'active' }]);
	const local = [{ id: 'local-refund', library: 'local-only', library_name: 'My laptop', revision: 4, title: 'Refund', text: 'Refund local secret instruction' }];
	await Fixture.provider(async calls => {
		const result = await Ai.search(member, { request_id: randomUUID(), query: 'Get money back', local }); assert.equal(result.results.length, 2); assert.ok(result.results.some(item => item.source === 'local')); assert.ok(result.results.some(item => item.id === 'shared-refund')); assert.ok(!JSON.stringify(calls).includes('Private sensitive')); assert.equal(calls.length, 2);
		assert.ok(!JSON.stringify(await AiRequest.find({ account: owner.account }).lean()).includes('local secret')); assert.equal(await Snippet.countDocuments({ id: 'local-refund' }), 0);
	}, call => ({ status: 'completed', output_text: call.body.instructions.includes('Extract') ? '{"terms":["refund"]}' : '{"indices":[0,1,0]}' }));
	await Fixture.provider(() => assert.rejects(Ai.search(member, { request_id: randomUUID(), query: 'refund' }), /invalid search results/), call => ({ status: 'completed', output_text: call.body.instructions.includes('Extract') ? '{"terms":["refund"]}' : '{"indices":[999]}' }));
	await Fixture.provider(async () => { const result = await Ai.search(member, { request_id: randomUUID(), query: 'refund' }); assert.equal(result.results.length, 0); }, async (call, count) => { if (count === 2) await Snippet.updateOne({ id: 'shared-refund', account: owner.account }, { $inc: { revision: 1 } }); return { status: 'completed', output_text: count === 1 ? '{"terms":["refund"]}' : '{"indices":[0]}' }; });
});

test('revocation during query expansion prevents sharing snippet content with the provider', async () => {
	const owner = await Fixture.context(); const member = await Fixture.context('member', await Account.findById(owner.account).lean()); await Fixture.configure(member);
	const library = await Library.create({ account: owner.account, creator: owner.user, name: 'Restricted', shared: true, members: [member.user], state: 'active', revision: 1 });
	await Snippet.create({ account: owner.account, library: library._id, id: 'restricted', title: 'Refund', content: { version: 1, type: 'plain_text', text: 'Restricted refund policy' }, revision: 1, state: 'active' });
	await Fixture.provider(async calls => { const result = await Ai.search(member, { request_id: randomUUID(), query: 'refund' }); assert.equal(result.results.length, 0); assert.equal(calls.length, 1); assert.ok(!JSON.stringify(calls).includes('Restricted refund')); }, async () => { await Library.updateOne({ _id: library._id }, { $set: { members: [] } }); return { status: 'completed', output_text: '{"terms":["refund"]}' }; });
});

test('disabling AI during inference discards the proposal', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx);
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author()), /disabled/), async () => { const setting = await Ai.setting(ctx, 'personal'); await Ai.save(ctx, 'personal', { enabled: false, routes: setting.routes }); return { status: 'completed', output_text: '{"text":"Hello","title":"Greeting"}' }; });
	assert.equal((await AiRequest.findOne({ account: ctx.account }).lean()).state, 'failed');
});

test('removed/stale connections cannot reappear and compatible no-auth clears saved keys', async () => {
	const ctx = await Fixture.context(); const result = await Fixture.configure(ctx); const setting = await Ai.setting(ctx, 'personal');
	await Ai.connection(ctx, 'personal', { id: result.id, revision: setting.revision }, false, true);
	await assert.rejects(Ai.connection(ctx, 'personal', { id: result.id, name: 'Old', provider: 'openai', api_key: 'dummy' }), /not found/);
	const added = await Ai.connection(ctx, 'personal', { name: 'Local', provider: 'compatible', base_url: 'https://example.test/v1', api_key: 'old-key' });
	await assert.rejects(Ai.connection(ctx, 'personal', { id: added.id, revision: 0, name: 'Stale', provider: 'compatible', base_url: 'https://example.test/v1' }), /changed/);
	const updated = await Ai.connection(ctx, 'personal', { id: added.id, name: 'Local', provider: 'compatible', base_url: 'https://example.test/v1', no_auth: true });
	assert.equal(updated.connection.key_configured, false); assert.equal(updated.connection.no_auth, true);
	assert.equal(AiProvider.privateOrigin('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
});

test('provider rejections before inference release managed allowance', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true'; const ctx = await Fixture.context();
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author()), /Rejected model/), () => { const error = new Fault(502, 'Rejected model'); error.no_inference = true; throw error; });
	assert.equal((await AiUsage.findOne({ account: ctx.account }).lean()).count, 0);
	process.env.TYPERELAY_HOSTED_EDITION = 'false';
});

test('HTTP settings, fragments, verification, proposal and OpenAPI contracts', async () => {
	const ctx = await Fixture.context(); const app = express(); app.use(express.json()); app.use((req, res, next) => { req.ctx = ctx; next(); }); Ai.mount(app); app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const origin = 'http://127.0.0.1:' + server.address().port + '/api/v2/ai';
	const request = async (path, method = 'GET', body) => { const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, value: await response.json() }; };
	try {
		const created = await request('/connections', 'POST', { name: 'API', provider: 'openai', api_key: 'fake-http-key' }); assert.equal(created.status, 200); assert.match(created.value.html, /data-ai-connection/); assert.ok(!JSON.stringify(created.value).includes('fake-http-key'));
		const saved = await request('/settings', 'PATCH', { enabled: true, routes: { authoring: { connection: created.value.id, model: 'gpt-6-luna' } } }); assert.equal(saved.status, 200);
		const settings = await request('/settings?scope=personal'); assert.match(settings.value.html, /data-ai-configuration/);
		const schema = await request('/openapi.json'); assert.equal(schema.value.openapi, '3.1.0'); assert.ok(schema.value.paths['/author'].post);
		await Fixture.provider(async () => { const verified = await request('/verify', 'POST', { connection: created.value.id, model: 'gpt-6-luna' }); assert.equal(verified.status, 200); const proposal = await request('/author', 'POST', Fixture.author()); assert.equal(proposal.status, 200); assert.equal(proposal.value.proposal.content.text, 'Hello, friend'); });
		const disabled = await request('/settings', 'PATCH', { enabled: false, routes: saved.value.settings.routes }); assert.equal(disabled.status, 200); assert.equal(disabled.value.status.enabled, false);
		await Fixture.provider(async calls => { const blocked = await request('/author', 'POST', Fixture.author()); assert.equal(blocked.status, 403); assert.equal(calls.length, 0); });
	} finally { await new Promise(resolve => server.close(resolve)); }
});
