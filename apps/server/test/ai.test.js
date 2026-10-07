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

test('GPT-6.1 Sol and Astra use supported reasoning settings without changing Luna defaults', async () => {
	await Fixture.provider(async calls => {
		for (const model of ['gpt-6.1-sol', 'gpt-6.1-sol-2026-09-30', 'gpt-6-astra']) for (const protocol of ['responses', 'chat']) {
			await AiProvider.generate({ provider: 'openai' }, {}, { model, protocol }, 'Test', 'Hello', { tokens: 512 });
			const body = calls.at(-1).body; assert.equal(body.reasoning?.effort || body.reasoning_effort, 'low'); assert.equal(body.max_output_tokens || body.max_completion_tokens, 2048);
		}
		await AiProvider.generate({ provider: 'openai' }, {}, { model: 'gpt-6-luna', protocol: 'responses' }, 'Test', 'Hello', { tokens: 512 });
		assert.deepEqual(calls.at(-1).body.reasoning, { effort: 'none' }); assert.equal(calls.at(-1).body.max_output_tokens, 512);
	}, call => call.path === '/responses' ? { status: 'completed', output_text: 'OK' } : { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] });
});

test('Cloudflare discovery uses native paginated model names and leaves compatible gateways unchanged', async () => {
	const connection = { provider: 'compatible', base_url: 'https://api.cloudflare.com/client/v4/accounts/test/ai/v1/', key: 'discovery-key' };
	await Fixture.provider(async calls => {
		const models = await AiProvider.models(connection, {});
		assert.equal(models.length, 101); assert.equal(models.at(-1).id, '@cf/google/gemma-4-26b-a4b-it'); assert.equal(calls.length, 2);
		assert.equal(calls[0].connection.base_url, 'https://api.cloudflare.com/client/v4/accounts/test/ai'); assert.equal(calls[0].connection.key, connection.key); assert.match(calls[1].path, /page=2/); assert.match(calls[0].path, /task=Text\+Generation/); assert.equal(connection.base_url.endsWith('/v1/'), true);
	}, (call, count) => ({ success: true, result: count === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: 'internal-' + i, name: '@cf/test/model-' + i })) : [{ id: 'internal-gemma', name: '@cf/google/gemma-4-26b-a4b-it' }], result_info: { total_pages: 2 } }));
	await Fixture.provider(() => assert.rejects(AiProvider.models(connection, {}), /could not list models/), () => ({ success: false, result: [] }));
	await Fixture.provider(async calls => {
		for (const base_url of ['https://gateway.example/v1', 'https://api.cloudflare.com.example/client/v4/accounts/test/ai/v1']) assert.deepEqual(await AiProvider.models({ ...connection, base_url }, {}), [{ id: 'chat-model', name: 'Chat model' }]);
		assert.ok(calls.every(call => call.path === '/models'));
	}, () => ({ data: [{ id: 'chat-model', name: 'Chat model' }] }));
});

test('Cloudflare Gemma disables thinking for short JSON responses without changing other models', async () => {
	await Fixture.provider(async calls => {
		const connection = { provider: 'compatible', base_url: 'https://api.cloudflare.com/client/v4/accounts/test/ai/v1' };
		const text = await AiProvider.generate(connection, {}, { model: '@cf/google/gemma-4-26b-a4b-it' }, 'Return JSON', 'Find search words', { tokens: 512 });
		assert.deepEqual(AiProvider.json(text), { terms: ['damaged'] }); assert.equal(calls[0].body.max_tokens, 512);
		for (const model of ['@cf/qwen/qwen3-30b-a3b-fp8', 'another-gemma-model']) { await AiProvider.generate(connection, {}, { model }, 'Test', 'Hello'); assert.equal(calls.at(-1).body.chat_template_kwargs, undefined); }
	}, call => ({ choices: [{ finish_reason: call.body.model === '@cf/google/gemma-4-26b-a4b-it' && call.body.chat_template_kwargs?.enable_thinking !== false ? 'length' : 'stop', message: { content: '{"terms":["damaged"]}' } }] }));
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

test('endpoint approvals and defaults save independently without resetting other installation fields', async () => {
	const initial = await Ai.installation();
	try {
		const approvals = await Ai.save(null, 'installation', { revision: initial.revision, private_endpoints: 'http://127.0.0.1:11434\nhttp://127.0.0.1:11434' }, true);
		assert.deepEqual(approvals.settings.private_endpoints, ['http://127.0.0.1:11434']); assert.equal(approvals.settings.enabled, initial.enabled); assert.equal(approvals.settings.daily_limit, initial.daily_limit); assert.deepEqual(approvals.settings.routes, initial.routes); assert.deepEqual(approvals.settings.connections, Ai.summary(initial).connections);
		const defaults = await Ai.save(null, 'installation', { revision: approvals.settings.revision, enabled: false, daily_limit: 75, routes: initial.routes }, true);
		assert.equal(defaults.settings.daily_limit, 75); assert.equal(defaults.settings.enabled, false); assert.deepEqual(defaults.settings.private_endpoints, approvals.settings.private_endpoints);
		await assert.rejects(Ai.save(null, 'installation', { revision: initial.revision, private_endpoints: '' }, true), /changed/);
		await assert.rejects(Ai.save(null, 'installation', { daily_limit: 0 }, true), /Daily allowance/);
		await assert.rejects(Ai.save(null, 'installation', { private_endpoints: ['http://127.0.0.1'] }, true), /one per line/);
		process.env.TYPERELAY_HOSTED_EDITION = 'true'; await assert.rejects(Ai.save(null, 'installation', { private_endpoints: 'http://127.0.0.1' }, true), /self-hosted/); process.env.TYPERELAY_HOSTED_EDITION = 'false';
		const cleared = await Ai.save(null, 'installation', { private_endpoints: '' }, true); assert.deepEqual(cleared.settings.private_endpoints, []); assert.equal(cleared.settings.daily_limit, 75); assert.equal(cleared.settings.enabled, false);
	} finally { process.env.TYPERELAY_HOSTED_EDITION = 'false'; await Ai.save(null, 'installation', { enabled: initial.enabled, daily_limit: initial.daily_limit, routes: initial.routes, private_endpoints: initial.private_endpoints.join('\n') }, true); }
});

test('authoring yields a validated proposal without changing snippets', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx); const count = await Snippet.countDocuments();
	await Fixture.provider(async calls => { const result = await Ai.author(ctx, Fixture.author()); assert.equal(result.proposal.content.text, 'Hello, friend'); assert.equal(result.proposal.trigger, 'hello'); assert.equal(await Snippet.countDocuments(), count); assert.equal(calls[0].connection.key, 'private-test-key'); assert.equal(await AiUsage.countDocuments({ account: ctx.account }), 0); });
	const definitions = { name: { label: 'Name', default: '', required: true, multiline: false, format: '', timezone: 'local' } };
	await Fixture.provider(async () => { const result = await Ai.author(ctx, Fixture.author({ action: 'template', entry: { title: 'Name', content: { version: 1, type: 'template', text: 'Hello {{name}}, from London', variables: definitions } } })); assert.deepEqual(result.proposal.content.variables.name, definitions.name); assert.equal(result.proposal.content.variables.city.required, true); }, () => ({ status: 'completed', output_text: '{"title":"Name","text":"Hello {{name}}, from {{city}}"}' }));
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author({ entry: { content: { version: 1, type: 'template', text: 'Hello {{name}}', variables: definitions } } })), /existing template variable/));
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author()), /cursor position/), () => ({ status: 'completed', output_text: '{"title":"Bad","text":"Hi {{cursor:here}}"}' }));
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author()), /Enter action/), () => ({ status: 'completed', output_text: '{"title":"Bad","text":"Run {{key:enter}}"}' }));
});

test('ordinary authoring rejects unsolicited fields while preserving existing repeated fields and literal code', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx);
	for (const action of ['generate', 'improve', 'translate']) await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author({ action })), /unexpected template variable/), () => ({ status: 'completed', output_text: '{"title":"Reply","text":"Hello {{customer_name}}"}' }));
	await Fixture.provider(async () => {
		const result = await Ai.author(ctx, Fixture.author({ entry: { content: { version: 1, type: 'template', text: 'Hello {{name}}, thank you {{name}}', variables: { name: { label: 'Name', required: true } } } } }));
		assert.equal(result.proposal.content.text, 'Hi {{name}}, thanks {{name}}');
	}, () => ({ status: 'completed', output_text: '{"title":"Reply","text":"Hi {{name}}, thanks {{name}}"}' }));
	await Fixture.provider(async () => {
		const result = await Ai.author(ctx, Fixture.author({ action: 'generate', entry: { content: { version: 1, type: 'code', language: 'JavaScript', text: '' } } }));
		assert.equal(result.proposal.content.type, 'code'); assert.equal(result.proposal.content.text, 'const greeting = "{{name}}";');
	}, () => ({ status: 'completed', output_text: JSON.stringify({ title: 'Code', text: 'const greeting = "{{name}}";' }) }));
});

test('template conversion adds sender and booking fields and rejects proposals without new fields', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx); const count = await Snippet.countDocuments();
	const text = "If you or your team need any help or want a demo of the system, please feel free to schedule a time with me. To schedule, please go to https://meet.thenitai.com and select the day and time that works best for you and your team. If you don't find a time slot that works for you, please get in touch with me, and I'm sure we can arrange something.\n\nWe would love to welcome you to our ever-growing customer base as a new customer.\n\nBe sure to let me know if there’s anything else I can do for you. Just hit reply, and I'll be happy to help.\n\nCheers,\nNitai\nCEO & Founder";
	const proposed = text.replace('https://meet.thenitai.com', '{{booking_url}}').replace('Nitai', '{{sender_name}}').replace('CEO & Founder', '{{sender_title}}');
	for (const content of [{ version: 1, type: 'plain_text', text }, { version: 2, type: 'rich_text', markdown: text, variables: {}, assets: [] }]) {
		await Fixture.provider(async calls => {
			const result = await Ai.author(ctx, Fixture.author({ action: 'template', prompt: 'Add reusable fields', entry: { title: 'Demo invitation', content } }));
			assert.match(calls[0].body.instructions, /personal names, job titles/); assert.match(calls[0].body.instructions, /exception to preserving links/);
			for (const name of ['booking_url', 'sender_name', 'sender_title']) { assert.ok((result.proposal.content.markdown ?? result.proposal.content.text).includes('{{' + name + '}}')); assert.equal(result.proposal.content.variables[name].required, true); }
			assert.equal(result.proposal.content.type, content.type === 'rich_text' ? 'rich_text' : 'template'); assert.equal(await Snippet.countDocuments(), count);
		}, () => ({ status: 'completed', output_text: JSON.stringify({ title: 'Demo invitation', text: proposed }) }));
		await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author({ action: 'template', entry: { content } })), /did not add any reusable fields/), () => ({ status: 'completed', output_text: JSON.stringify({ title: 'Demo invitation', text }) }));
	}
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author({ action: 'template', entry: { content: { version: 1, type: 'template', text: 'Hello {{name}}', variables: { name: { label: 'Name', required: true } } } } })), /did not add any reusable fields/), () => ({ status: 'completed', output_text: JSON.stringify({ title: 'Greeting', text: 'Hi {{name}}' }) }));
});

test('authoring generates from an empty editor while retaining input and proposal validation', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx); const count = await Snippet.countDocuments();
	const library = await Library.create({ account: ctx.account, creator: ctx.user, name: 'New snippets', shared: false, state: 'active', revision: 1 });
	for (const content of [{ version: 1, type: 'plain_text', text: '' }, { version: 1, type: 'code', language: 'JavaScript', text: '' }, { version: 2, type: 'rich_text', markdown: '', variables: {} }]) {
		await Fixture.provider(async calls => {
			const result = await Ai.author(ctx, Fixture.author({ action: 'generate', library: String(library._id), prompt: 'Request a meeting', entry: { title: '', trigger: null, content } }));
			assert.equal(result.proposal.content.markdown ?? result.proposal.content.text, 'Hello, friend'); assert.equal(result.proposal.content.type, content.type); assert.equal(result.proposal.trigger, null); assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].body.input).text, '');
		});
	}
	assert.equal(await Snippet.countDocuments(), count);
	await Fixture.provider(async calls => {
		for (const text of ['', '\u0000', 'x'.repeat(65537)]) await assert.rejects(Ai.author(ctx, Fixture.author({ action: text === '' ? 'improve' : 'generate', entry: { content: { version: 1, type: 'plain_text', text } } })), /Replacements must/);
		assert.equal(calls.length, 0);
	});
	await Fixture.provider(() => assert.rejects(Ai.author(ctx, Fixture.author({ action: 'generate', entry: { content: { version: 1, type: 'plain_text', text: '' } } })), /Replacements must/), () => ({ status: 'completed', output_text: '{"title":"Empty","text":""}' }));
});

test('authoring checks library edit access before contacting the provider', async () => {
	const owner = await Fixture.context(); const account = await Account.findById(owner.account).lean(); const member = await Fixture.context('member', account); const outsider = await Fixture.context(); await Fixture.configure(member);
	const library = await Library.create({ account: owner.account, creator: owner.user, name: 'Shared authoring', shared: true, editable: false, members: [member.user], state: 'active', revision: 1 });
	await Fixture.provider(async calls => {
		await assert.rejects(Ai.author(member, Fixture.author({ library: String(library._id) })), error => error.status === 403 && error.message === 'Library is read-only');
		await assert.rejects(Ai.author(outsider, Fixture.author({ library: String(library._id) })), error => error.status === 404 && error.message === 'Library not found');
		assert.equal(calls.length, 0);
		await Library.updateOne({ _id: library._id }, { $set: { editable: true } });
		const result = await Ai.author(member, Fixture.author({ library: String(library._id) })); assert.equal(result.proposal.content.text, 'Hello, friend'); assert.equal(calls.length, 1);
	});
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

test('paid and trial users receive managed AI while free users retain BYO access', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true'; process.env.BILLING_ENABLED = 'true';
	try {
		for (const [plan, status, trial, eligible] of [['pro', 'active', false, true], ['team', 'active', false, true], ['free', 'trialing', true, true], ['free', 'trial_expired', true, false], ['pro', 'canceled', false, false], ['free', 'active', false, false]]) {
			const ctx = await Fixture.context();
			await Account.updateOne({ _id: ctx.account }, { $set: { 'admin_override.plan': null, plan, 'billing.status': status, 'billing.trial_source': trial ? 'no_card' : null, 'billing.trial_ends_at': new Date(Date.now() + (status === 'trial_expired' ? -86400000 : 86400000)) } });
			const state = await Ai.state(ctx);
			if (eligible) assert.equal(Ai.route(state, 'authoring').managed, true); else assert.throws(() => Ai.route(state, 'authoring'), /Pro\/Team/);
			await Fixture.configure(ctx); assert.equal(Ai.route(await Ai.state(ctx), 'authoring').scope, 'personal'); assert.equal(Ai.route(await Ai.state(ctx), 'authoring').managed, false);
		}
	} finally { process.env.TYPERELAY_HOSTED_EDITION = 'false'; process.env.BILLING_ENABLED = 'false'; }
});

test('two-call managed search counts once and BYO works after the managed allowance is exhausted', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true'; process.env.BILLING_ENABLED = 'true';
	const installation = await Ai.installation();
	try {
		await Ai.save(null, 'installation', { daily_limit: 1 }, true); const ctx = await Fixture.context();
		await Fixture.provider(async calls => {
			const result = await Ai.search(ctx, { request_id: randomUUID(), query: 'refund', local: [{ id: 'refund', library: 'local', revision: 1, text: 'Refund instructions' }] });
			assert.equal(calls.length, 2); assert.equal(result.results.length, 1); assert.equal((await Ai.status(ctx)).allowance.used, 1);
			await assert.rejects(Ai.author(ctx, Fixture.author()), /allowance/); assert.equal(calls.length, 2);
		}, (call, count) => ({ status: 'completed', output_text: count === 1 ? '{"terms":["refund"]}' : '{"indices":[0]}' }));
		await Fixture.configure(ctx); await Fixture.provider(async () => { await Ai.author(ctx, Fixture.author()); assert.equal((await Ai.status(ctx)).allowance.used, 1); });
	} finally { await Ai.save(null, 'installation', { daily_limit: installation.daily_limit }, true); process.env.TYPERELAY_HOSTED_EDITION = 'false'; process.env.BILLING_ENABLED = 'false'; }
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

test('multiword expansion retrieves relevant snippets even without an exact phrase match', async () => {
	const ctx = await Fixture.context(); await Fixture.configure(ctx);
	const library = await Library.create({ account: ctx.account, creator: ctx.user, name: 'Support', shared: false, state: 'active', revision: 1 });
	await Snippet.create({ account: ctx.account, library: library._id, id: 'damaged-delivery', title: 'Damaged delivery', content: { version: 1, type: 'plain_text', text: 'For broken goods, send a photograph and order number to request a replacement.' }, revision: 1, state: 'active' });
	await Fixture.provider(async calls => {
		const result = await Ai.search(ctx, { request_id: randomUUID(), query: 'My parcel arrived smashed' });
		assert.equal(calls.length, 2); assert.equal(result.results[0].id, 'damaged-delivery');
	}, (call, count) => ({ status: 'completed', output_text: count === 1 ? '{"terms":["damaged package","broken parcel"]}' : '{"indices":[0]}' }));
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
	const library = await Library.create({ account: ctx.account, creator: ctx.user, name: 'HTTP authoring', shared: false, state: 'active', revision: 1 });
	const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const origin = 'http://127.0.0.1:' + server.address().port + '/api/v2/ai';
	const request = async (path, method = 'GET', body) => { const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, value: await response.json() }; };
	try {
		const created = await request('/connections', 'POST', { name: 'API', provider: 'openai', api_key: 'fake-http-key' }); assert.equal(created.status, 200); assert.match(created.value.html, /data-ai-connection/); assert.ok(!JSON.stringify(created.value).includes('fake-http-key'));
		const saved = await request('/settings', 'PATCH', { enabled: true, routes: { authoring: { connection: created.value.id, model: 'gpt-6-luna' } } }); assert.equal(saved.status, 200);
		const settings = await request('/settings?scope=personal'); assert.match(settings.value.html, /data-ai-configuration/);
		const schema = await request('/openapi.json'); assert.equal(schema.value.openapi, '3.1.0'); assert.ok(schema.value.paths['/author'].post);
		await Fixture.provider(async () => { const verified = await request('/verify', 'POST', { connection: created.value.id, model: 'gpt-6-luna' }); assert.equal(verified.status, 200); const proposal = await request('/author', 'POST', Fixture.author({ action: 'generate', library: String(library._id), entry: { title: '', trigger: null, content: { version: 1, type: 'plain_text', text: '' } } })); assert.equal(proposal.status, 200); assert.equal(proposal.value.proposal.content.text, 'Hello, friend'); });
		const disabled = await request('/settings', 'PATCH', { enabled: false, routes: saved.value.settings.routes }); assert.equal(disabled.status, 200); assert.equal(disabled.value.status.enabled, false);
		await Fixture.provider(async calls => { const blocked = await request('/author', 'POST', Fixture.author()); assert.equal(blocked.status, 403); assert.equal(calls.length, 0); });
	} finally { await new Promise(resolve => server.close(resolve)); }
});


test('explicit managed AI bypasses team providers and preserves BYO routes through toggles', async () => {
	process.env.TYPERELAY_HOSTED_EDITION = 'true';
	try {
		const ctx = await Fixture.context(); await Fixture.configure(null, 'installation', 'managed-key', true); await Fixture.configure(ctx, 'team', 'team-key'); await Fixture.configure(ctx);
		const before = await Ai.setting(ctx, 'personal'); await Ai.save(ctx, 'personal', { use_managed: true });
		assert.equal(Ai.route(await Ai.state(ctx), 'authoring').scope, 'installation'); assert.equal(Ai.route(await Ai.state(ctx), 'search').scope, 'installation'); assert.deepEqual((await Ai.setting(ctx, 'personal')).routes, before.routes);
		await Ai.save(ctx, 'personal', { use_managed: false }); assert.equal(Ai.route(await Ai.state(ctx), 'authoring').scope, 'personal');
		await Ai.save(ctx, 'personal', { routes: {} }); await Ai.save(ctx, 'team', { use_managed: true }); assert.equal(Ai.route(await Ai.state(ctx), 'authoring').scope, 'installation');
		await Account.updateOne({ _id: ctx.account }, { $set: { admin_override: { plan: 'free' } } }); const state = await Ai.state(ctx); assert.throws(() => Ai.route(state, 'authoring'), /Pro\/Team/); await assert.rejects(Ai.save(ctx, 'personal', { use_managed: true }), /Pro\/Team/);
	} finally { process.env.TYPERELAY_HOSTED_EDITION = 'false'; }
});
