import { TestDatabase } from './database.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Account, Device, Library, Member, Snippet, Ticket, User, mongoose } from '../model/index.js';
import { Billing } from '../services/billing.js';
import { WhiteLabel } from '../services/white_label.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Libraries } from '../services/libraries.js';
import { StripeProvisioner } from '../scripts/provision-stripe.js';
import { Helpmonks } from '../services/helpmonks.js';
import { Team } from '../services/team.js';
import { Statistics } from '../services/statistics.js';
import { AdminSettings } from '../services/admin_settings.js';
import { StorageMigration } from '../services/storage_migration.js';

class Fixture {
	static environment = {};
	static owner;
	static account;
	static ctx;
	static async context(account = Fixture.account, user = Fixture.owner) { return Support.context(String(user._id), String(account._id)); }
}

before(async () => {
	for (const key of ['TYPERELAY_HOSTED_EDITION', 'BILLING_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_FREE_PRICE_ID', 'STRIPE_PRO_PRICE_ID', 'STRIPE_TEAM_PRICE_ID', 'STRIPE_PORTAL_CONFIG_ID', 'WHITE_LABEL_ENABLED', 'WHITE_LABEL_CNAME_TARGET', 'WHITE_LABEL_ASSETS_DIR', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID', 'HELPMONKS_API_URL', 'HELPMONKS_SIGNUP_API_URL', 'HELPMONKS_SIGNUP_HOST_ID', 'HELPMONKS_SIGNUP_SEQUENCE_ID']) Fixture.environment[key] = process.env[key];
	Object.assign(process.env, { TYPERELAY_HOSTED_EDITION: 'true', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_FREE_PRICE_ID: 'price_free', STRIPE_PRO_PRICE_ID: 'price_pro', STRIPE_TEAM_PRICE_ID: 'price_team', STRIPE_PORTAL_CONFIG_ID: 'portal_account', WHITE_LABEL_ENABLED: 'true', WHITE_LABEL_CNAME_TARGET: 'custom.typerelay.com', CLOUDFLARE_API_TOKEN: 'cloudflare-fixture', CLOUDFLARE_ZONE_ID: 'zone-fixture', HELPMONKS_API_URL: 'http://helpmonks-general.test', HELPMONKS_SIGNUP_API_URL: 'http://helpmonks-signup.test', HELPMONKS_SIGNUP_HOST_ID: '53837271b7b1cbce6da6ce06', HELPMONKS_SIGNUP_SEQUENCE_ID: '6a8694a0e4e1989c9dafdbf2' });
	const uri = TestDatabase.uri(process.env.MONGO_URI, 'typerelay_billing_test');
	await mongoose.connect(uri);
	await TestDatabase.drop(mongoose.connection, 'typerelay_billing_test');
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
	Fixture.owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Billing owner' });
	Fixture.account = await Account.create({ name: 'Billing account' });
	await Member.create({ account: Fixture.account._id, user: Fixture.owner._id, role: 'owner' });
	Fixture.ctx = await Fixture.context();
});

after(async () => {
	await TestDatabase.drop(mongoose.connection, 'typerelay_billing_test');
	await mongoose.disconnect();
	for (const [key, value] of Object.entries(Fixture.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('catalog exposes the approved Free, Pro and Team limits', () => {
	assert.deepEqual(Billing.plans.free.limits, { people: 1, snippets: 250, libraries: 1, machines: 1 });
	assert.equal(Billing.plans.pro.price, 4);
	assert.equal(Billing.plans.pro.limits.people, 5);
	assert.equal(Billing.plans.pro.capabilities.team, true);
	assert.equal(Billing.plans.pro.capabilities.sharing, true);
	assert.equal(Billing.plans.pro.capabilities.white_label, false);
	assert.equal(Billing.plans.team.price, 8);
	assert.equal(Billing.plans.team.seats, 1);
	assert.equal(Billing.entitlements(Fixture.account).plan, 'free');
	assert.equal(Billing.portalConfig(), 'portal_account');
	assert.throws(() => Billing.assertApi(Fixture.ctx), error => error.status === 403 && error.code === 'plan_required');
});

test('Free blocks API token creation and MCP authorization', async () => {
	await assert.rejects(Auth.createIntegration(Fixture.ctx, { name: 'Free unlimited API', days: 0, scopes: ['content:read'] }), error => error.status === 403 && error.code === 'plan_required');
	await assert.rejects(Auth.createIntegration(Fixture.ctx, { name: 'Free API', days: 1, scopes: ['content:read'] }), error => error.status === 403 && error.code === 'plan_required');
	const client = await Auth.registerIntegration({ client_name: 'Free MCP', redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'none' });
	const verifier = Support.token();
	const request = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', state: Support.token(), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: Auth.mcpResource(), scope: 'content:read', account: String(Fixture.account._id) };
	await assert.rejects(Auth.approveIntegration(String(Fixture.owner._id), request), error => error.status === 403 && error.code === 'plan_required');
});

test('Free resource gates reject a second library and second machine', async () => {
	await Libraries.mutate(Fixture.ctx, randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'First', snippets: [] }, session) }));
	await assert.rejects(Libraries.mutate(Fixture.ctx, randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'Second', snippets: [] }, session) })), error => error.status === 409 && error.code === 'plan_limit');
	await Device.create({ account: Fixture.account._id, user: Fixture.owner._id, name: 'Primary' });
	await assert.rejects(Billing.assertDeviceEnrollment(Fixture.ctx), error => error.code === 'plan_limit');
	assert.throws(() => Billing.assertLimit(Fixture.ctx, 'snippets', 250, 1), error => error.code === 'plan_limit');
});

test('Free permits unlimited browser connections without consuming its machine slot', async () => {
	const ctx = await Fixture.context();
	const redirect_uri = new URL('/oauth/browser-callback', Auth.origin).href;
	await assert.rejects(Promise.resolve().then(() => Auth.redirect('https://example.com/callback', 'typerelay-browser')), /Invalid browser callback/);
	const tokens = [];
	for (let index = 0; index < 3; index++) {
		const verifier = Support.token();
		const request = { client_id: 'typerelay-browser', client_type: 'browser', os: 'web', account: String(Fixture.account._id), redirect_uri, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: Support.token() };
		const url = new URL(await Auth.authorize(String(Fixture.owner._id), request));
		const connected = await Auth.exchange({ grant_type: 'authorization_code', client_id: request.client_id, code: url.searchParams.get('code'), redirect_uri, code_verifier: verifier });
		tokens.push(connected);
		assert.equal((await Auth.bearer(connected.access_token)).device, connected.device);
	}
	assert.equal((await Billing.usage(Fixture.account._id)).machines, 1);
	await assert.rejects(Billing.assertDeviceEnrollment(ctx), error => error.code === 'plan_limit');
	const refreshed = await Auth.exchange({ grant_type: 'refresh_token', client_id: 'typerelay-browser', refresh_token: tokens[0].refresh_token });
	await assert.rejects(Auth.exchange({ grant_type: 'refresh_token', client_id: 'typerelay-mobile', refresh_token: refreshed.refresh_token }), /Invalid refresh client/);
	await Device.updateOne({ _id: tokens[0].device }, { $set: { revoked: true } });
	await assert.rejects(Auth.bearer(refreshed.access_token), /revoked/);
});

test('one-time Pro trial unlocks API and machines, then expires to Free', async () => {
	const startedAt = new Date();
	const account = await Billing.startTrial(Fixture.account._id, startedAt);
	assert.equal(account.billing.helpmonks_sequence.status, 'pending');
	let enrollmentRequest;
	const enrollment = await Helpmonks.enrollTrialUsers(startedAt, { fetch: async (url, options) => { enrollmentRequest = { url, options }; return { ok: true, status: 200, json: async () => ({ success: true, results: { _id: '6a8697777777777777777777' }, sequence_enrollment: { campaign_id: process.env.HELPMONKS_SIGNUP_SEQUENCE_ID } }) }; } });
	assert.deepEqual(enrollment, { checked: 1, enrolled: 1, retrying: 0, failed: 0, configured: true });
	assert.equal(enrollmentRequest.url, 'http://helpmonks-signup.test/api/v1/trusted/company_user/create');
	assert.deepEqual(JSON.parse(enrollmentRequest.options.body), { customer: { email: Fixture.owner.email, labels: [] }, host_id: process.env.HELPMONKS_SIGNUP_HOST_ID, campaign_id: process.env.HELPMONKS_SIGNUP_SEQUENCE_ID });
	assert.equal((await Account.findById(Fixture.account._id).lean()).billing.helpmonks_sequence.status, 'completed');
	const trial = Billing.entitlements(account, new Date(startedAt.getTime() + 86400000));
	assert.equal(trial.plan, 'pro');
	assert.equal(trial.trial, true);
	const trialLocals = Billing.locals(account, Fixture.ctx, null, new Date(startedAt.getTime() + 86400000));
	assert.equal(trialLocals.trialStartedAt, startedAt.toISOString());
	assert.equal(trialLocals.trialEndsAt, new Date(startedAt.getTime() + 7 * 86400000).toISOString());
	assert.equal(trialLocals.trialDays, 7);
	const ctx = await Fixture.context();
	assert.doesNotThrow(() => Billing.assertApi(ctx));
	await Billing.assertDeviceEnrollment(ctx);
	const secondary = await Device.create({ account: Fixture.account._id, user: Fixture.owner._id, name: 'Trial machine' });
	await Billing.assertDevice(ctx, secondary);
	const integration = await Auth.createIntegration(ctx, { name: 'Trial API', days: 1, scopes: ['content:read'] });
	assert.match(integration.token, /^tr_pat_/);
	const summary = await Billing.runTrialExpiry(new Date(startedAt.getTime() + 8 * 86400000));
	assert.equal(summary.expired, 1);
	const expired = await Account.findById(Fixture.account._id).lean();
	assert.equal(Billing.entitlements(expired).plan, 'free');
	await assert.rejects(Auth.integration(`Token ${integration.token}`), error => error.code === 'plan_required');
	await assert.rejects(Auth.integration(`Token ${integration.token}`, Auth.mcpResource()), error => error.code === 'plan_required');
	await assert.rejects(Billing.assertDevice(await Fixture.context(), secondary), error => error.code === 'plan_limit');
	await assert.rejects(Billing.startTrial(Fixture.account._id), error => error.code === 'trial_unavailable');
});

test('Helpmonks trial enrollment retries every five minutes and fails after twelve attempts', async () => {
	const user = await User.create({ email: `${randomUUID()}@example.test`, name: 'Retry owner' });
	const now = new Date();
	const account = await Account.create({ name: 'Retry account', billing: { helpmonks_sequence: { status: 'pending', attempts: 10, next_attempt_at: now } } });
	await Member.create({ account: account._id, user: user._id, role: 'owner' });
	const unavailable = async () => ({ ok: false, status: 503, json: async () => ({}) });
	assert.deepEqual(await Helpmonks.enrollTrialUsers(now, { fetch: unavailable }), { checked: 1, enrolled: 0, retrying: 1, failed: 0, configured: true });
	let stored = await Account.findById(account._id).lean();
	assert.equal(stored.billing.helpmonks_sequence.attempts, 11);
	assert.equal(stored.billing.helpmonks_sequence.next_attempt_at.getTime(), now.getTime() + Helpmonks.retryDelay);
	assert.deepEqual(await Helpmonks.enrollTrialUsers(new Date(now.getTime() + Helpmonks.retryDelay), { fetch: unavailable }), { checked: 1, enrolled: 0, retrying: 0, failed: 1, configured: true });
	stored = await Account.findById(account._id).lean();
	assert.equal(stored.billing.helpmonks_sequence.status, 'failed');
	assert.equal(stored.billing.helpmonks_sequence.attempts, 12);
	assert.equal(Helpmonks.configuration({ env: { HELPMONKS_API_URL: 'http://fallback.test' } }).apiUrl, 'http://fallback.test');
});

test('new Free account gets one Stripe customer and tracking subscription', async () => {
	const user = await User.create({ email: `${randomUUID()}@example.test`, name: 'New owner' });
	const account = await Account.create({ name: 'New account' });
	await Member.create({ account: account._id, user: user._id, role: 'owner' });
	const calls = [];
	const stripe = {
		customers: { create: async params => { calls.push(['customer', params]); return { id: params.id }; } },
		subscriptions: { list: async params => { calls.push(['list', params]); return { data: [] }; }, create: async params => { calls.push(['subscription', params]); return { id: 'sub_free', ...params }; } },
	};
	assert.equal(await Billing.initializeAccount(account, user, { stripe }), 'sub_free');
	const stored = await Billing.account(account._id, null, true);
	assert.equal(stored.billing.stripe_customer_id, String(account._id));
	assert.equal(stored.billing.stripe_free_subscription_id, 'sub_free');
	assert.equal(calls[0][1].metadata.catalog, Billing.catalogName);
	assert.equal(calls[2][1].items[0].price, 'price_free');
});

test('Checkout uses dynamic payment methods and approved Team quantity', async () => {
	const account = await Billing.account(Fixture.account._id, null, true);
	await Account.updateOne({ _id: account._id }, { $set: { 'billing.stripe_customer_id': String(account._id) } });
	let params;
	const stripe = { checkout: { sessions: { create: async value => { params = value; return { id: 'cs_fixture', url: 'https://checkout.example/session' }; } } } };
	const url = await Billing.checkout(account._id, Fixture.owner, { plan: 'team', seats: 7 }, { stripe, successUrl: 'https://app.typerelay.com/billing/success?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://app.typerelay.com/#settings-subscription' });
	assert.equal(url, 'https://checkout.example/session');
	assert.deepEqual(params.line_items, [{ price: 'price_team', quantity: 7 }]);
	assert.equal(Object.hasOwn(params, 'payment_method_types'), false);
	assert.deepEqual(params.automatic_tax, { enabled: true });
	assert.deepEqual(params.tax_id_collection, { enabled: true });
	assert.deepEqual(params.customer_update, { address: 'auto', name: 'auto' });
	assert.match(params.integration_identifier, /^typerelay_[a-z]{8}$/i);
});

test('Team seat capacity includes accepted members and live invitations', async () => {
	const account = await Account.create({ name: 'Team', plan: 'team', billing: { status: 'active', seat_quantity: 5 } });
	const owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Team owner' });
	await Member.create({ account: account._id, user: owner._id, role: 'owner' });
	for (let index = 0; index < 4; index++) { const user = await User.create({ email: `${randomUUID()}@example.test`, name: `Member ${index}` }); await Member.create({ account: account._id, user: user._id, role: 'member' }); }
	const ctx = await Fixture.context(account, owner);
	await assert.rejects(Billing.assertSeatCapacity(ctx), error => error.code === 'plan_limit' && error.details.limit === 5);
	assert.doesNotThrow(() => Billing.assertTeam(ctx));
});

test('Team to Pro downgrade uses a renewal subscription schedule', async () => {
	const account = await Account.create({ name: 'Scheduled Team', plan: 'team', billing: { stripe_customer_id: 'cus_team', stripe_subscription_id: 'sub_team', status: 'active', price_id: 'price_team', seat_quantity: 5 } });
	const owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Scheduled owner' });
	await Member.create({ account: account._id, user: owner._id, role: 'owner' });
	let phases;
	const subscription = { id: 'sub_team', customer: 'cus_team', status: 'active', metadata: Billing.metadata(account, 'team'), items: { data: [{ id: 'si_team', price: { id: 'price_team' }, quantity: 5, current_period_start: 100, current_period_end: 200 }] } };
	const stripe = { subscriptions: { retrieve: async () => subscription }, subscriptionSchedules: { create: async () => ({ id: 'sched', current_phase: { start: 100 } }), update: async (id, input) => { assert.equal(id, 'sched'); phases = input.phases; return { id }; } } };
	const result = await Billing.change(account._id, { plan: 'pro', seats: 1 }, { stripe, returnUrl: 'https://app.typerelay.com/#settings-subscription' });
	assert.equal(result.scheduled_change.plan, 'pro');
	assert.equal(result.scheduled_change.seat_quantity, 1);
	assert.equal(phases[1].items[0].price, 'price_pro');
	assert.equal(phases[1].start_date, 200);
});

test('non-owner access is dormant on Free without deleting membership', async () => {
	const account = await Account.create({ name: 'Downgraded', plan: 'free', billing: { status: 'active' } });
	const owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Owner' });
	const member = await User.create({ email: `${randomUUID()}@example.test`, name: 'Member' });
	await Member.create([{ account: account._id, user: owner._id, role: 'owner' }, { account: account._id, user: member._id, role: 'member' }]);
	await assert.rejects(Fixture.context(account, member), error => error.status === 403 && error.code === 'plan_required');
	assert.equal(await Member.countDocuments({ account: account._id }), 2);
});

test('white-label validation and Cloudflare readiness follow the Team contract', async () => {
	assert.equal(WhiteLabel.normalizeHostname('Portal.Example.com.'), 'portal.example.com');
	assert.throws(() => WhiteLabel.normalizeHostname('app.typerelay.com'), error => error.code === 'hostname_reserved');
	assert.equal(WhiteLabel.cloudflareState({ id: 'cf', status: 'active', ssl: { status: 'pending_validation' } }).state, 'pending_ssl');
	assert.equal(WhiteLabel.cloudflareState({ id: 'cf', status: 'active', ssl: { status: 'active' } }).state, 'active');
	const free = WhiteLabel.serialize(Fixture.account, false);
	assert.equal(free.logo_url, '');
});

test('Team custom hostname verifies DNS, Cloudflare status and request binding', async () => {
	const account = await Account.create({ name: 'Branded Team', plan: 'team', billing: { status: 'active', seat_quantity: 5 } });
	await WhiteLabel.configure(account._id, 'portal.customer.test');
	const fetch = async (url, input) => ({ ok: true, status: 200, json: async () => ({ success: true, result: { custom_metadata: JSON.parse(input.body).custom_metadata, id: 'cf-host', hostname: 'portal.customer.test', status: 'active', ssl: { status: 'active' } } }) });
	const settings = await WhiteLabel.verify(account._id, { resolveCname: async () => ['custom.typerelay.com.'], fetch });
	assert.equal(settings.state, 'active');
	let continued = false;
	const req = { headers: { host: 'portal.customer.test' }, hostname: 'portal.customer.test' };
	const res = { locals: {}, status: value => ({ send: () => { throw new Error(`Unexpected ${value}`); } }) };
	await WhiteLabel.resolveRequest(req, res, () => { continued = true; });
	assert.equal(continued, true);
	assert.equal(req.boundAccount, String(account._id));
	assert.equal(res.locals.whiteLabel.active, true);
});

test('only a DNS-verified custom hostname blocks other accounts', async () => {
	await Account.collection.dropIndex('white_label_verified_hostname');
	await Account.collection.createIndex({ 'white_label.hostname': 1 }, { unique: true, partialFilterExpression: { 'white_label.hostname': { $type: 'string', $gt: '' } } });
	await StorageMigration.hostnames();
	await StorageMigration.hostnames();
	const owner = await Account.create({ name: 'Verified owner', plan: 'team', billing: { status: 'active', seat_quantity: 5 } });
	const other = await Account.create({ name: 'Late claimant', plan: 'team', billing: { status: 'active', seat_quantity: 5 } });
	await WhiteLabel.configure(owner._id, 'claimed.customer.test');
	await WhiteLabel.configure(other._id, 'claimed.customer.test');
	assert.equal(await WhiteLabel.claimed(other._id, 'claimed.customer.test'), null);
	const fetch = async (url, input) => ({ ok: true, status: 200, json: async () => ({ success: true, result: { custom_metadata: JSON.parse(input.body).custom_metadata, id: 'cf-claimed', hostname: 'claimed.customer.test', status: 'active', ssl: { status: 'active' } } }) });
	await WhiteLabel.verify(owner._id, { resolveCname: async () => ['custom.typerelay.com.'], fetch });
	assert.ok(await WhiteLabel.claimed(other._id, 'claimed.customer.test'));
	await assert.rejects(WhiteLabel.verify(other._id, { resolveCname: async () => ['custom.typerelay.com.'], fetch }), error => error.status === 409 && error.code === 'hostname_conflict');
	await assert.rejects(Account.updateOne({ _id: other._id }, { $set: { 'white_label.dns_verified_at': new Date() } }), error => error.code === 11000);
	await WhiteLabel.releaseHostname({ _id: other._id, white_label: { hostname: 'claimed.customer.test', cloudflare_hostname_id: 'cf-claimed' } }, { fetch: async () => assert.fail('another account hostname was deleted') });
});

test('concurrent hostname verification reserves one owner before Cloudflare creation', async t => {
	const accounts = await Account.create([{ name: 'Concurrent owner', plan: 'team', billing: { status: 'active' } }, { name: 'Concurrent claimant', plan: 'team', billing: { status: 'active' } }]);
	for (const account of accounts) await WhiteLabel.configure(account._id, 'concurrent.customer.test');
	t.mock.method(WhiteLabel, 'claimed', async () => null);
	let calls = 0;
	const options = { resolveCname: async () => ['custom.typerelay.com.'], fetch: async (url, input) => { calls++; return { ok: true, status: 200, json: async () => ({ success: true, result: { ...JSON.parse(input.body), id: 'cf-concurrent', status: 'active', ssl: { status: 'active' } } }) }; } };
	const results = await Promise.allSettled(accounts.map(account => WhiteLabel.verify(account._id, options)));
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
	assert.equal(calls, 1);
	const failure = results.find(result => result.status === 'rejected').reason;
	assert.equal(failure.status, 409);
	assert.equal(failure.code, 'hostname_conflict');
});

test('a failed DNS recheck retains ownership while external deletion is pending', async () => {
	const accounts = await Account.create([{ name: 'Removing domain owner', plan: 'team', billing: { status: 'active' } }, { name: 'Next domain owner', plan: 'team', billing: { status: 'active' } }]);
	for (const account of accounts) await WhiteLabel.configure(account._id, 'deleting.customer.test');
	let record;
	const options = { resolveCname: async () => ['custom.typerelay.com.'], fetch: async (url, input) => { if (input.method === 'POST') record = { ...JSON.parse(input.body), id: 'cf-deleting', status: 'active', ssl: { status: 'active' } }; return { ok: true, status: 200, json: async () => ({ success: true, result: record }) }; } };
	await WhiteLabel.verify(accounts[0]._id, options);
	let started; const ready = new Promise(resolve => { started = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
	const removal = WhiteLabel.remove(accounts[0]._id, { getHostname: async () => record, fetch: async () => { started(); await gate; return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) }; } });
	await ready;
	try {
		await assert.rejects(WhiteLabel.verify(accounts[0]._id, { resolveCname: async () => [] }), error => error.code === 'domain_busy');
		assert.ok(await WhiteLabel.claimed(accounts[1]._id, 'deleting.customer.test'));
		await assert.rejects(WhiteLabel.verify(accounts[1]._id, options), error => error.status === 409 && error.code === 'hostname_conflict');
	} finally { release(); await removal; }
	assert.equal((await WhiteLabel.verify(accounts[1]._id, options)).state, 'active');
});

test('Team branding validates and normalizes image assets', async () => {
	const directory = await mkdtemp('/tmp/typerelay-white-label-');
	process.env.WHITE_LABEL_ASSETS_DIR = directory;
	const account = await Account.create({ name: 'Brand assets', plan: 'team', billing: { status: 'active', seat_quantity: 5 } });
	const source = `${directory}/source.png`;
	await writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
	try {
		const settings = await WhiteLabel.upload(account._id, 'logo', { filepath: source, size: (await stat(source)).size });
		assert.match(settings.logo_url, new RegExp(`/white-label-assets/${account._id}/logo/logo-`));
		assert.equal(settings.logo.mime_type, 'image/png');
		assert.equal((await stat(`${directory}/${settings.logo_url.replace('/white-label-assets/', '')}`)).isFile(), true);
		assert.equal((await WhiteLabel.deleteAsset(account._id, 'logo')).logo, null);
	} finally { await rm(directory, { recursive: true, force: true }); delete process.env.WHITE_LABEL_ASSETS_DIR; }
});

test('Stripe provisioner creates exact tax-exclusive price shapes', () => {
	const product = { id: 'prod' };
	assert.equal(StripeProvisioner.taxCode, 'txcd_10103001');
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.pro).unit_amount, 400);
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.team).unit_amount, 800);
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.team).billing_scheme, 'per_unit');
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.team).tiers, undefined);
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.team).tax_behavior, 'exclusive');
});

test('general Stripe Portal manages invoices, payments and cancellation without bypassing app plan checks', async () => {
	let created;
	const stripe = { billingPortal: { configurations: { list: async () => ({ data: [] }), create: async params => { created = params; return { id: 'portal', ...params }; } } } };
	const products = [{ plan: Billing.plans.pro, product: { id: 'prod_pro' }, price: { id: 'price_pro' } }, { plan: Billing.plans.team, product: { id: 'prod_team' }, price: { id: 'price_team' } }];
	const portal = await StripeProvisioner.portal(stripe, products);
	assert.equal(portal.id, 'portal');
	assert.equal(created.features.subscription_cancel.enabled, true);
	assert.equal(created.features.subscription_update.enabled, false);
	assert.equal(created.features.payment_method_update.enabled, true);
	assert.equal(created.metadata.purpose, 'account_management');
});

test('Stripe confirmation configurations restrict the target price and Pro seat range', async () => {
	let created;
	const price = { id: 'price_pro', product: 'prod_pro', active: true, currency: 'usd', unit_amount: 400, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, metadata: { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, plan_key: 'pro' } };
	const stripe = { prices: { retrieve: async () => price }, billingPortal: { configurations: { list: async () => ({ data: [] }), create: async params => { created = params; return { id: 'portal_offer' }; } } } };
	assert.equal(await Billing.changePortalConfiguration(stripe, 'pro', 3), 'portal_offer');
	assert.deepEqual(created.features.subscription_update.products, [{ product: 'prod_pro', prices: ['price_pro'], adjustable_quantity: { enabled: true, minimum: 1, maximum: 5 } }]);
	stripe.billingPortal.configurations.list = async () => ({ data: [{ id: 'portal_reused', ...created }] });
	assert.equal(await Billing.changePortalConfiguration(stripe, 'pro', 3), 'portal_reused');
	price.unit_amount = 800;
	await assert.rejects(Billing.changePortalConfiguration(stripe, 'pro', 3), error => error.code === 'billing_mismatch');
});

test('scheduled seat reductions reserve capacity during Stripe calls and can be canceled', async () => {
	const account = await Account.create({ name: 'Seat reduction', plan: 'pro', billing: { stripe_customer_id: 'cus_seats', stripe_subscription_id: 'sub_seats', status: 'active', price_id: 'price_pro', seat_quantity: 5 } });
	const owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Seat owner' });
	await Member.create({ account: account._id, user: owner._id, role: 'owner' });
	const ctx = await Fixture.context(account, owner);
	const subscription = { id: 'sub_seats', customer: 'cus_seats', status: 'active', metadata: Billing.metadata(account, 'pro'), items: { data: [{ id: 'si_seats', price: { id: 'price_pro' }, quantity: 5, current_period_start: 100, current_period_end: 200 }] } };
	let released = false;
	const stripe = { subscriptions: { retrieve: async () => subscription }, subscriptionSchedules: { create: async () => ({ id: 'sched_seats', current_phase: { start: 100 } }), retrieve: async () => ({ id: 'sched_seats', customer: 'cus_seats', status: 'active' }), release: async () => { released = true; }, update: async (id, input) => { await assert.rejects(Team.invite(ctx, `${randomUUID()}@example.test`), error => error.code === 'plan_limit'); assert.equal(input.phases[1].items[0].quantity, 1); } } };
	await Billing.change(account._id, { plan: 'pro', seats: 1 }, { stripe });
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 1);
	await assert.rejects(Billing.change(account._id, { plan: 'pro', seats: 4 }, { stripe }), error => error.code === 'billing_change_scheduled');
	await Billing.cancelChange(account._id, { stripe });
	assert.equal(released, true);
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 5);
});

test('open Checkout reserves trial seats, is reused, and releases capacity only after expiration or cancellation', async () => {
	const account = await Account.create({ name: 'Checkout reservation', billing: { stripe_customer_id: 'cus_checkout', status: 'trialing', trial_source: 'no_card', trial_ends_at: new Date(Date.now() + 86400000) } });
	const owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Checkout owner' });
	await Member.create({ account: account._id, user: owner._id, role: 'owner' });
	const checkout = { id: 'cs_reserved', status: 'open', url: 'https://checkout.example/reserved' };
	let creates = 0;
	const stripe = { checkout: { sessions: { create: async () => { creates++; return checkout; }, retrieve: async () => checkout, expire: async () => { checkout.status = 'expired'; } } } };
	await Billing.checkout(account._id, owner, { plan: 'pro', seats: 1 }, { stripe });
	assert.equal(await Billing.checkout(account._id, owner, { plan: 'pro', seats: 1 }, { stripe }), checkout.url);
	assert.equal(creates, 1);
	await assert.rejects(Billing.checkout(account._id, owner, { plan: 'pro', seats: 2 }, { stripe }), error => error.code === 'checkout_pending');
	const ctx = await Fixture.context(account, owner);
	await assert.rejects(Team.invite(ctx, `${randomUUID()}@example.test`), error => error.code === 'plan_limit');
	await Billing.cancelCheckout(account._id, { stripe });
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 5);
	checkout.id = 'cs_expiring'; checkout.status = 'open';
	await Billing.checkout(account._id, owner, { plan: 'pro', seats: 1 }, { stripe });
	await Billing.handleWebhook(null, null, { stripe, event: { type: 'checkout.session.expired', data: { object: { id: 'cs_reserved', customer: 'cus_checkout' } } } });
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 1);
	await Billing.handleWebhook(null, null, { stripe, event: { type: 'checkout.session.expired', data: { object: { id: 'cs_expiring', customer: 'cus_checkout' } } } });
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 5);
});

test('an applied renewal change releases its Stripe schedule and clears local pending state', async () => {
	const account = await Account.create({ name: 'Applied renewal', plan: 'team', billing: { stripe_customer_id: 'cus_renew', stripe_subscription_id: 'sub_renew', status: 'active', seat_quantity: 5, scheduled_change: { plan: 'pro', seat_quantity: 2, schedule_id: 'sched_renew' } } });
	const subscription = { id: 'sub_renew', customer: 'cus_renew', status: 'active', schedule: 'sched_renew', metadata: Billing.metadata(account, 'pro'), items: { data: [{ id: 'si_renew', price: { id: 'price_pro' }, quantity: 2 }] } };
	let released;
	const stripe = { subscriptionSchedules: { release: async id => { released = id; assert.equal((await Billing.account(account._id)).billing.seat_quantity, 2); } } };
	await Billing.applySubscription(await Billing.account(account._id, null, true), subscription, { stripe });
	assert.equal(released, 'sched_renew');
	assert.equal((await Billing.account(account._id)).billing.scheduled_change, null);
});

for (const delayed of ['update', 'cancellation']) test(`delayed subscription ${delayed} cannot overwrite a newer billing write`, async t => {
	const account = await Account.create({ name: 'Concurrent billing', plan: 'pro', billing: { stripe_customer_id: 'cus_race', stripe_subscription_id: 'sub_race', status: 'active' } });
	if (delayed === 'update') await Account.updateOne({ _id: account._id }, { $unset: { 'billing.revision': '' } });
	const snapshot = await Billing.account(account._id, null, true);
	const subscription = { id: 'sub_race', customer: 'cus_race', status: 'active', metadata: Billing.metadata(account, 'pro'), items: { data: [{ id: 'si_race', price: { id: 'price_pro' }, quantity: 1 }] } };
	const updated = { type: 'customer.subscription.updated', data: { object: subscription } };
	const canceled = { type: 'customer.subscription.deleted', data: { object: { ...subscription, status: 'canceled' } } };
	let release; let entered;
	const paused = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
	const updateOne = Account.updateOne.bind(Account); let first = true;
	t.mock.method(Account, 'updateOne', async (...args) => { if (args[0]['billing.revision'] !== undefined && first) { first = false; entered(); await gate; } return updateOne(...args); });
	t.mock.method(WhiteLabel, 'disable', async () => {}); t.mock.method(Billing, 'ensureFreeSubscription', async () => null);
	let current = subscription; const stripe = { subscriptions: { retrieve: async () => structuredClone(current) } };
	const pending = Billing.processWebhook({ ...snapshot, billing: { ...snapshot.billing } }, delayed === 'update' ? updated : canceled, stripe);
	const rejected = assert.rejects(pending, error => error.code === 'billing_changed');
	await paused;
	try { await Billing.processWebhook({ ...snapshot, billing: { ...snapshot.billing } }, delayed === 'update' ? canceled : updated, stripe); } finally { release(); }
	await rejected;
	assert.equal((await Billing.account(account._id)).billing.status, delayed === 'update' ? 'canceled' : 'active');
	// Retried deliveries reload both account and provider state, instead of replaying stale data.
	current = { ...subscription, status: 'canceled' };
	await Billing.processWebhook(await Billing.account(account._id, null, true), delayed === 'update' ? updated : canceled, stripe);
	assert.equal((await Billing.account(account._id)).plan, 'free');
});

test('delayed renewal reconciliation cannot release a newer scheduled change', async () => {
	const account = await Account.create({ name: 'Newer schedule', plan: 'pro', billing: { stripe_customer_id: 'cus_newer', stripe_subscription_id: 'sub_newer', status: 'active', seat_quantity: 2, scheduled_change: { plan: 'pro', seat_quantity: 2, schedule_id: 'sched_old' } } });
	const stale = await Billing.account(account._id, null, true);
	await Account.updateOne({ _id: account._id }, { $set: { 'billing.scheduled_change': { plan: 'pro', seat_quantity: 1, schedule_id: 'sched_new' } } });
	const subscription = { id: 'sub_newer', customer: 'cus_newer', status: 'active', schedule: 'sched_new', metadata: Billing.metadata(account, 'pro'), items: { data: [{ id: 'si_newer', price: { id: 'price_pro' }, quantity: 2 }] } };
	const stripe = { subscriptionSchedules: { release: async () => assert.fail('Must not release the newer schedule') } };
	await Billing.applySubscription(stale, subscription, { stripe });
	assert.equal((await Billing.account(account._id, null, true)).billing.scheduled_change.schedule_id, 'sched_new');
});

test('retained memberships cannot exceed Pro trial or purchased capacity', async () => {
	const account = await Account.create({ name: 'Retained members', plan: 'free', billing: { status: 'trialing', trial_source: 'no_card', trial_ends_at: new Date(Date.now() + 86400000) } });
	const users = [];
	for (let index = 0; index < 6; index++) { const user = await User.create({ email: `${randomUUID()}@example.test`, name: `Retained ${index}` }); users.push(user); await Member.create({ account: account._id, user: user._id, role: index ? 'member' : 'owner' }); }
	await Fixture.context(account, users[4]);
	await assert.rejects(Fixture.context(account, users[5]), error => error.code === 'plan_limit');
	await Account.updateOne({ _id: account._id }, { $set: { plan: 'pro', 'billing.status': 'active', 'billing.trial_source': null, 'billing.seat_quantity': 2 } });
	await Fixture.context(account, users[1]);
	await assert.rejects(Fixture.context(account, users[2]), error => error.code === 'plan_limit');
	await Account.updateOne({ _id: account._id }, { $set: { plan: 'team', 'billing.seat_quantity': 6 } });
	await Fixture.context(account, users[5]);
	assert.equal(await Member.countDocuments({ account: account._id }), 6);
});

test('delayed subscription and invoice events reconcile current Stripe state without reviving old subscriptions', async () => {
	const account = await Account.create({ name: 'Webhook order', plan: 'pro', billing: { stripe_customer_id: 'cus_order', stripe_subscription_id: 'sub_current', status: 'active', price_id: 'price_pro', seat_quantity: 1 } });
	const current = { object: 'subscription', id: 'sub_current', customer: 'cus_order', status: 'active', metadata: Billing.metadata(account, 'team'), items: { data: [{ id: 'si_order', price: { id: 'price_team' }, quantity: 2 }] } };
	const stale = { ...current, metadata: Billing.metadata(account, 'pro'), items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] } };
	const stripe = { subscriptions: { retrieve: async id => { assert.equal(id, 'sub_current'); return current; } } };
	await Billing.handleWebhook(null, null, { stripe, event: { type: 'customer.subscription.updated', data: { object: stale } } });
	assert.equal((await Billing.account(account._id)).plan, 'team');
	await Billing.handleWebhook(null, null, { stripe, event: { type: 'invoice.payment_failed', data: { object: { customer: 'cus_order', parent: { subscription_details: { subscription: 'sub_current' } } } } } });
	assert.equal((await Billing.account(account._id)).billing.status, 'active');
	await Billing.handleWebhook(null, null, { stripe, event: { type: 'customer.subscription.deleted', data: { object: { ...stale, id: 'sub_old' } } } });
	assert.equal((await Billing.account(account._id)).plan, 'team');
});

test('Stripe provisioner requires an active Tax registration', async () => {
	const stripe = { tax: { settings: { retrieve: async () => ({ status: 'active' }) }, registrations: { list: async () => ({ data: [] }) } } };
	await assert.rejects(StripeProvisioner.validateTax(stripe), /active registration/);
	stripe.tax.registrations.list = async () => ({ data: [{ id: 'taxreg' }] });
	await StripeProvisioner.validateTax(stripe);
});

test('billing and white-label browser mutations replace only their fragments', async () => {
	const source = await readFile('./public/app.js', 'utf8');
	assert.match(source, /applyBilling\(result\)/);
	assert.match(source, /update\('#subscription-content'/);
	assert.match(source, /update\('#white-label-content'/);
	assert.doesNotMatch(source, /location\.reload/);
});


test('paid seat quantities accept Pro 1–5 and Team from one, rejecting invalid quantities', () => {
	for (const seats of [1, 2, 5]) assert.equal(Billing.checkoutSeats('pro', seats), seats);
	for (const seats of [1, 5, 6, 15]) assert.equal(Billing.checkoutSeats('team', seats), seats);
	for (const seats of [0, -1, 1.5, 6, NaN, Infinity, 'bad', '']) assert.throws(() => Billing.checkoutSeats('pro', seats), error => error.code === 'invalid_seat_quantity');
	assert.equal(Billing.checkoutSeats('team'), 1);
	assert.throws(() => Billing.checkoutSeats('free', 1), error => error.code === 'invalid_plan');
});

test('Pro collaboration admits paid members but reserves seats atomically for invitations', async () => {
	const account = await Account.create({ name: 'Pro collaboration', plan: 'pro', billing: { status: 'active', seat_quantity: 2 } });
	const owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Pro owner' });
	await Member.create({ account: account._id, user: owner._id, role: 'owner' });
	const ctx = await Fixture.context(account, owner);
	assert.doesNotThrow(() => Billing.assertTeam(ctx, 'sharing'));
	assert.equal(Statistics.scope(ctx, 'team').user, null);
	assert.equal(ctx.entitlements.capabilities.white_label, false);
	const send = AdminSettings.send;
	const sent = [];
	AdminSettings.send = async (kind, email, variables) => { sent.push({ email, variables }); };
	try {
		const results = await Promise.allSettled([Team.invite(ctx, `${randomUUID()}@example.test`), Team.invite(ctx, `${randomUUID()}@example.test`)]);
		assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
		assert.equal(results.find(result => result.status === 'rejected').reason.code, 'plan_limit');
		assert.equal(await Ticket.countDocuments({ account: account._id, kind: 'invite' }), 1);
		const member = await User.create({ email: sent[0].email, name: 'Accepted Pro member' });
		const token = new URL(sent[0].variables.url).searchParams.get('invite');
		await mongoose.connection.transaction(session => Team.accept({ user: String(member._id) }, token, session));
		assert.equal(await Ticket.countDocuments({ account: account._id, kind: 'invite' }), 0);
		assert.equal(await Member.countDocuments({ account: account._id }), 2);
		const memberCtx = await Fixture.context(account, member);
		assert.equal(memberCtx.entitlements.capabilities.sharing, true);
		assert.throws(() => Statistics.scope(memberCtx, 'team'), error => error.status === 403);
		await assert.rejects(Billing.validateChangeUsage(account, 'pro', 1), error => error.code === 'plan_limit');
		await Billing.validateChangeUsage(account, 'pro', 2);
	} finally { AdminSettings.send = send; }
});

test('capacity honors purchased seats, Pro cap, scheduled reductions, trials and self-hosting', () => {
	const paid = { plan: 'pro', billing: { status: 'active', seat_quantity: 2 } };
	assert.equal(Billing.seatCapacity(paid), 2);
	assert.equal(Billing.seatCapacity({ ...paid, billing: { status: 'active', seat_quantity: 20 } }), 5);
	assert.equal(Billing.seatCapacity({ plan: 'team', billing: { status: 'active', seat_quantity: 1 } }), 1);
	assert.equal(Billing.seatCapacity({ plan: 'team', billing: { status: 'active', seat_quantity: 8, scheduled_change: { plan: 'pro', seat_quantity: 3 } } }), 3);
	assert.equal(Billing.seatCapacity({ plan: 'free', billing: { status: 'trialing', trial_source: 'no_card', trial_ends_at: new Date(Date.now() + 60000) } }), 5);
	assert.equal(Billing.seatCapacity(paid, { billing_enabled: false, limits: { people: 0 } }), 0);
	assert.equal(Billing.seatCapacity({ ...paid, admin_override: { plan: 'team' } }), 0);
});

test('legacy Typerelay price metadata is recognized without accepting other product catalogs', () => {
	const price = { id: 'price_legacy', currency: 'usd', billing_scheme: 'per_unit', unit_amount: 800, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, metadata: { catalog: Billing.catalogName, catalog_version: '2026-09', plan_key: 'pro' } };
	const subscription = { items: { data: [{ price }] } };
	assert.equal(Billing.planFromSubscription(subscription), 'pro');
	price.metadata = { ...price.metadata, plan_key: 'team' }; price.billing_scheme = 'tiered'; price.tiers_mode = 'graduated';
	assert.equal(Billing.planFromSubscription(subscription), 'team');
	price.metadata.catalog = 'streamient';
	assert.throws(() => Billing.planFromSubscription(subscription), error => error.code === 'billing_mismatch');
	price.metadata = { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, plan_key: 'pro' }; price.billing_scheme = 'per_unit'; price.unit_amount = 400;
	assert.equal(Billing.planFromSubscription(subscription), 'pro');
	price.unit_amount = 1;
	assert.throws(() => Billing.planFromSubscription(subscription), error => error.code === 'billing_mismatch');
});

test('legacy Team keeps five included seats until explicitly moved to per-user pricing', async () => {
	const account = await Account.create({ name: 'Legacy Team', plan: 'team', billing: { stripe_customer_id: 'cus_legacy', stripe_subscription_id: 'sub_legacy', price_id: 'price_legacy_team', status: 'active', seat_quantity: 1 } });
	const members = [];
	for (let index = 0; index < 5; index++) { const user = await User.create({ email: `${randomUUID()}@example.test`, name: `Legacy member ${index}` }); members.push(await Member.create({ account: account._id, user: user._id, role: index === 0 ? 'owner' : 'member' })); }
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 5);
	const price = { id: 'price_legacy_team', currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, metadata: { catalog: Billing.catalogName, catalog_version: '2026-09', plan_key: 'team' } };
	const subscription = { id: 'sub_legacy', customer: 'cus_legacy', status: 'active', metadata: Billing.metadata(account, 'team'), items: { data: [{ id: 'si_legacy', price, quantity: 1 }] } };
	await Billing.applySubscription(await Billing.account(account._id, null, true), subscription);
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 5);
	await Support.context(String(members[4].user), String(account._id));
	const fragments = await Billing.fragments(account._id, await Support.context(String(members[0].user), String(account._id)));
	assert.equal(fragments.member_actions.length, 5);
	assert.match(fragments.member_actions.find(item => item.id === String(members[4]._id)).html, /Make admin/);
	subscription.items.data[0].price = { id: 'price_team' };
	await Billing.applySubscription(await Billing.account(account._id, null, true), subscription);
	assert.equal(Billing.seatCapacity(await Billing.account(account._id)), 1);
	await assert.rejects(Support.context(String(members[4].user), String(account._id)), error => error.code === 'plan_limit');
});

test('already-applied legacy schedules are released while future changes remain protected', async () => {
	const account = await Account.create({ name: 'Orphaned schedule', plan: 'pro', billing: { stripe_customer_id: 'cus_orphan', stripe_subscription_id: 'sub_orphan', status: 'active', seat_quantity: 3 } });
	const subscription = { id: 'sub_orphan', customer: 'cus_orphan', status: 'active', schedule: 'sched_orphan', metadata: Billing.metadata(account, 'pro'), items: { data: [{ id: 'si_orphan', price: { id: 'price_pro' }, quantity: 3, current_period_start: 200, current_period_end: 300 }] } };
	const schedule = { id: 'sched_orphan', customer: 'cus_orphan', status: 'active', end_behavior: 'release', current_phase: { start_date: 100 }, phases: [{ start_date: 100 }, { start_date: 200, metadata: Billing.metadata(account, 'pro'), items: [{ price: 'price_pro', quantity: 3 }] }] };
	const released = [];
	const stripe = { subscriptions: { retrieve: async () => structuredClone(subscription) }, subscriptionSchedules: { retrieve: async () => schedule, release: async id => { released.push(id); subscription.schedule = null; }, create: async () => ({ id: 'sched_next', current_phase: { start_date: 200 } }), update: async () => ({ id: 'sched_next' }) } };
	await assert.rejects(Billing.change(account._id, { plan: 'pro', seats: 2 }, { stripe }), error => error.code === 'billing_change_scheduled');
	assert.deepEqual(released, []);
	schedule.current_phase.start_date = 200;
	const result = await Billing.change(account._id, { plan: 'pro', seats: 2 }, { stripe });
	assert.deepEqual(released, ['sched_orphan']);
	assert.equal(result.scheduled_change.schedule_id, 'sched_next');
});

test('moving legacy included seats to fewer per-user seats waits for renewal and preserves the current quantity', async () => {
	const account = await Account.create({ name: 'Legacy seat migration', plan: 'team', billing: { stripe_customer_id: 'cus_migrate', stripe_subscription_id: 'sub_migrate', status: 'active', seat_quantity: 1, price_id: 'price_old_team' } });
	const price = { id: 'price_old_team', currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, metadata: { catalog: Billing.catalogName, catalog_version: '2026-09', plan_key: 'team' } };
	const subscription = { id: 'sub_migrate', customer: 'cus_migrate', status: 'active', metadata: Billing.metadata(account, 'team'), items: { data: [{ id: 'si_migrate', price, quantity: 1, current_period_start: 100, current_period_end: 200 }] } };
	let phases;
	const released = [];
	const stripe = { subscriptions: { retrieve: async () => subscription }, subscriptionSchedules: { create: async () => { subscription.schedule = 'sched_migrate'; return { id: 'sched_migrate', current_phase: { start_date: 100 } }; }, update: async (id, input) => { phases = input.phases; }, release: async id => { released.push(id); } } };
	const result = await Billing.change(account._id, { plan: 'team', seats: 1 }, { stripe });
	assert.equal(result.scheduled_change.seat_quantity, 1);
	assert.equal(result.scheduled_change.price_id, 'price_team');
	assert.equal(phases[0].items[0].quantity, 1);
	assert.equal(phases[1].items[0].price, 'price_team');
	assert.equal(phases[1].start_date, 200);
	await Billing.applySubscription(await Billing.account(account._id, null, true), subscription, { stripe });
	assert.deepEqual(released, []);
	assert.equal((await Billing.account(account._id, null, true)).billing.scheduled_change.schedule_id, 'sched_migrate');
	subscription.items.data[0].price = { id: 'price_team' };
	await Billing.applySubscription(await Billing.account(account._id, null, true), subscription, { stripe });
	assert.deepEqual(released, ['sched_migrate']);
	assert.equal((await Billing.account(account._id)).billing.scheduled_change, null);
});
