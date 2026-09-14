import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Account, Device, Library, Member, Snippet, User, mongoose } from '../model/index.js';
import { Billing } from '../services/billing.js';
import { WhiteLabel } from '../services/white_label.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Libraries } from '../services/libraries.js';
import { StripeProvisioner } from '../scripts/provision-stripe.js';

class Fixture {
	static environment = {};
	static owner;
	static account;
	static ctx;
	static async context(account = Fixture.account, user = Fixture.owner) { return Support.context(String(user._id), String(account._id)); }
}

before(async () => {
	for (const key of ['TYPERELAY_HOSTED_EDITION', 'BILLING_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_FREE_PRICE_ID', 'STRIPE_PRO_PRICE_ID', 'STRIPE_TEAM_PRICE_ID', 'STRIPE_PORTAL_CONFIG_ID', 'WHITE_LABEL_ENABLED', 'WHITE_LABEL_CNAME_TARGET', 'WHITE_LABEL_ASSETS_DIR', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID']) Fixture.environment[key] = process.env[key];
	Object.assign(process.env, { TYPERELAY_HOSTED_EDITION: 'true', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_FREE_PRICE_ID: 'price_free', STRIPE_PRO_PRICE_ID: 'price_pro', STRIPE_TEAM_PRICE_ID: 'price_team', STRIPE_PORTAL_CONFIG_ID: 'portal_account', WHITE_LABEL_ENABLED: 'true', WHITE_LABEL_CNAME_TARGET: 'custom.typerelay.com', CLOUDFLARE_API_TOKEN: 'cloudflare-fixture', CLOUDFLARE_ZONE_ID: 'zone-fixture' });
	await mongoose.connect(process.env.MONGO_URI.replace('/typerelay?', '/typerelay_billing_test?'));
	await mongoose.connection.dropDatabase();
	await Promise.all(Object.values(mongoose.models).map(model => model.init()));
	Fixture.owner = await User.create({ email: `${randomUUID()}@example.test`, name: 'Billing owner' });
	Fixture.account = await Account.create({ name: 'Billing account' });
	await Member.create({ account: Fixture.account._id, user: Fixture.owner._id, role: 'owner' });
	Fixture.ctx = await Fixture.context();
});

after(async () => {
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
	for (const [key, value] of Object.entries(Fixture.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('catalog exposes the approved Free, Pro and Team limits', () => {
	assert.deepEqual(Billing.plans.free.limits, { people: 1, snippets: 250, libraries: 1, machines: 1 });
	assert.equal(Billing.plans.pro.price, 8);
	assert.equal(Billing.plans.team.price, 39);
	assert.equal(Billing.plans.team.additionalSeatPrice, 6);
	assert.equal(Billing.entitlements(Fixture.account).plan, 'free');
	assert.equal(Billing.portalConfig(), 'portal_account');
	assert.throws(() => Billing.assertApi(Fixture.ctx), error => error.status === 403 && error.code === 'plan_required');
});

test('Free resource gates reject a second library and second machine', async () => {
	await Libraries.mutate(Fixture.ctx, randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'First', snippets: [] }, session) }));
	await assert.rejects(Libraries.mutate(Fixture.ctx, randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'Second', snippets: [] }, session) })), error => error.status === 409 && error.code === 'plan_limit');
	await Device.create({ account: Fixture.account._id, user: Fixture.owner._id, name: 'Primary' });
	await assert.rejects(Billing.assertDeviceEnrollment(Fixture.ctx), error => error.code === 'plan_limit');
	assert.throws(() => Billing.assertLimit(Fixture.ctx, 'snippets', 250, 1), error => error.code === 'plan_limit');
});

test('one-time Pro trial unlocks API and machines, then expires to Free', async () => {
	const startedAt = new Date();
	const account = await Billing.startTrial(Fixture.account._id, startedAt);
	const trial = Billing.entitlements(account, new Date(startedAt.getTime() + 86400000));
	assert.equal(trial.plan, 'pro');
	assert.equal(trial.trial, true);
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
	await assert.rejects(Billing.assertDevice(await Fixture.context(), secondary), error => error.code === 'plan_limit');
	await assert.rejects(Billing.startTrial(Fixture.account._id), error => error.code === 'trial_unavailable');
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
	const stripe = { checkout: { sessions: { create: async value => { params = value; return { url: 'https://checkout.example/session' }; } } } };
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

test('non-owner access is dormant after Team downgrades without deleting membership', async () => {
	const account = await Account.create({ name: 'Downgraded', plan: 'pro', billing: { status: 'active' } });
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
	const fetch = async (url, input) => ({ ok: true, status: 200, json: async () => ({ success: true, result: { id: 'cf-host', hostname: 'portal.customer.test', status: 'active', ssl: { status: 'active' } } }) });
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
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.pro).unit_amount, 800);
	assert.deepEqual(StripeProvisioner.priceParams(product, Billing.plans.team).tiers, [{ up_to: 5, flat_amount: 3900, unit_amount: 0 }, { up_to: 'inf', unit_amount: 600 }]);
	assert.equal(StripeProvisioner.priceParams(product, Billing.plans.team).tax_behavior, 'exclusive');
});

test('Stripe provisioner uses one Portal configuration for management and confirmed changes', async () => {
	let created;
	const stripe = { billingPortal: { configurations: { list: async () => ({ data: [] }), create: async params => { created = params; return { id: 'portal', ...params }; } } } };
	const products = [{ plan: Billing.plans.pro, product: { id: 'prod_pro' }, price: { id: 'price_pro' } }, { plan: Billing.plans.team, product: { id: 'prod_team' }, price: { id: 'price_team' } }];
	const portal = await StripeProvisioner.portal(stripe, products);
	assert.equal(portal.id, 'portal');
	assert.equal(created.features.subscription_cancel.enabled, true);
	assert.equal(created.features.subscription_update.enabled, true);
	assert.equal(created.features.payment_method_update.enabled, true);
	assert.deepEqual(created.features.subscription_update.products, [{ product: 'prod_pro', prices: ['price_pro'] }, { product: 'prod_team', prices: ['price_team'] }]);
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
