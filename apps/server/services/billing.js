import Stripe from 'stripe';
import pug from 'pug';
import { randomBytes } from 'node:crypto';
import { Account, Device, Library, Member, Snippet, Ticket, User } from '../model/index.js';
import { scopes } from '../api/catalog.js';

export class Billing {
	static catalogName = 'typerelay_2026';
	static catalogVersion = '2026-09';
	static stripeClient = null;
	static plans = {
		free: { key: 'free', name: 'Free', rank: 0, price: 0, seats: 1, limits: { people: 1, snippets: 250, libraries: 1, machines: 1 }, capabilities: { api: false, mcp: false, sharing: false, team: false, white_label: false, sync: true, dynamic_extensions: true } },
		pro: { key: 'pro', name: 'Pro', rank: 1, price: 8, seats: 1, limits: { people: 1, snippets: 0, libraries: 0, machines: 0 }, capabilities: { api: true, mcp: true, sharing: false, team: false, white_label: false, sync: true, dynamic_extensions: true } },
		team: { key: 'team', name: 'Team', rank: 2, price: 39, seats: 5, additionalSeatPrice: 6, limits: { people: 0, snippets: 0, libraries: 0, machines: 0 }, capabilities: { api: true, mcp: true, sharing: true, team: true, white_label: true, sync: true, dynamic_extensions: true } },
	};

	static hosted() {
		if (process.env.TYPERELAY_HOSTED_EDITION === 'true') return true;
		try { return new URL(process.env.APP_URL || '').hostname === 'app.typerelay.com'; } catch { return false; }
	}

	static enabled() { return Billing.hosted() && process.env.BILLING_ENABLED === 'true'; }
	static trialDays() { return 7; }
	static priceId(plan) { return process.env[`STRIPE_${String(plan).toUpperCase()}_PRICE_ID`] || ''; }
	static portalConfig() { return process.env.STRIPE_PORTAL_CONFIG_ID || ''; }

	static stripe() {
		if (!Billing.stripeClient) {
			if (!process.env.STRIPE_SECRET_KEY) throw Billing.error(503, 'Stripe is not configured', 'billing_unavailable');
			Billing.stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-07-29.dahlia', maxNetworkRetries: 2, timeout: 15000 });
		}
		return Billing.stripeClient;
	}

	static error(status, message, code = '', details = null) {
		const error = new Error(message);
		error.status = status;
		error.code = code;
		error.details = details;
		return error;
	}

	static entitlements(account, now = new Date()) {
		if (!Billing.enabled()) return { ...Billing.plans.team, plan: 'team', trial: false, billing_enabled: false, limits: { people: 0, snippets: 0, libraries: 0, machines: 0 } };
		const billing = account?.billing || {};
		const trialEnds = billing.trial_ends_at ? new Date(billing.trial_ends_at) : null;
		const noCardTrial = billing.status === 'trialing' && billing.trial_source === 'no_card' && trialEnds && trialEnds > now;
		if (noCardTrial) return { ...Billing.plans.pro, plan: 'pro', trial: true, billing_enabled: true, trial_ends_at: trialEnds };
		const status = billing.status || 'incomplete';
		const stored = ['active', 'past_due', 'trialing'].includes(status) && ['pro', 'team'].includes(account?.plan) ? account.plan : 'free';
		return { ...Billing.plans[stored], plan: stored, trial: false, billing_enabled: true, trial_ends_at: trialEnds };
	}

	static trialText(account, now = new Date()) {
		const ends = account?.billing?.trial_ends_at ? new Date(account.billing.trial_ends_at) : null;
		if (!ends || !Number.isFinite(ends.getTime())) return 'Trial';
		const days = Math.max(0, Math.ceil((ends - now) / 86400000));
		return days === 0 ? 'Trial ends today' : `Trial ends in ${days} day${days === 1 ? '' : 's'}`;
	}

	static metadata(account, plan) {
		return { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, account_id: String(account._id), plan_key: plan };
	}

	static async account(id, session = null, secrets = false) {
		let query = Account.findById(id).session(session || null);
		if (secrets) query = query.select('+billing.stripe_customer_id +billing.stripe_subscription_id +billing.stripe_free_subscription_id +billing.scheduled_change.schedule_id +white_label.cloudflare_hostname_id +white_label.logo.storage_key +white_label.favicon.storage_key +white_label.login_logo.storage_key');
		return query.lean();
	}

	static assertCapability(ctx, capability, message = '') {
		if (!Billing.enabled() || ctx?.entitlements?.capabilities?.[capability]) return;
		throw Billing.error(403, message || `${Billing.plans.team.name} or Pro access required`, 'plan_required', { capability, upgrade_url: '/#settings-subscription' });
	}

	static assertApi(ctx) { Billing.assertCapability(ctx, 'api', 'API and MCP access require Pro or Team'); }
	static assertTeam(ctx, capability = 'team') { Billing.assertCapability(ctx, capability, 'Team plan required'); }

	static async usage(accountId, session = null) {
		const activeLibraries = await Library.find({ account: accountId, state: 'active' }).select('_id').session(session || null).lean();
		const [snippets, people, invitations, machines] = await Promise.all([
			Snippet.countDocuments({ account: accountId, library: { $in: activeLibraries.map(library => library._id) }, state: 'active' }).session(session || null),
			Member.countDocuments({ account: accountId }).session(session || null),
			Ticket.countDocuments({ account: accountId, kind: 'invite', expires: { $gt: new Date() } }).session(session || null),
			Device.countDocuments({ account: accountId, revoked: false }).session(session || null),
		]);
		return { libraries: activeLibraries.length, snippets, people, invitations, machines };
	}

	static assertLimit(ctx, resource, current, increase = 1) {
		const limit = ctx?.entitlements?.limits?.[resource] || 0;
		if (!Billing.enabled() || !limit || current + increase <= limit) return;
		throw Billing.error(409, `${Billing.plans.free.name} allows ${limit} ${resource}`, 'plan_limit', { resource, limit, usage: current, upgrade_url: '/#settings-subscription' });
	}

	static async assertResourceIncrease(ctx, resource, increase, session = null) {
		if (!increase || !Billing.enabled()) return;
		const usage = await Billing.usage(ctx.account, session);
		Billing.assertLimit(ctx, resource, usage[resource], increase);
	}

	static async assertDeviceEnrollment(ctx, session = null) {
		if (!Billing.enabled() || !ctx.entitlements.limits.machines) return;
		const count = await Device.countDocuments({ account: ctx.account, user: ctx.user, revoked: false }).session(session || null);
		Billing.assertLimit(ctx, 'machines', count, 1);
	}

	static async assertDevice(ctx, device, session = null) {
		if (!Billing.enabled() || !ctx.entitlements.limits.machines) return;
		const primary = await Device.findOne({ account: ctx.account, user: ctx.user, revoked: false }).sort({ createdAt: 1, _id: 1 }).select('_id').session(session || null).lean();
		if (!primary || String(primary._id) === String(device._id || device)) return;
		throw Billing.error(403, 'Free allows one connected machine', 'plan_limit', { resource: 'machines', limit: 1, upgrade_url: '/#settings-subscription' });
	}

	static async assertSeatCapacity(ctx, increase = 1, session = null) {
		Billing.assertTeam(ctx);
		const account = await Billing.account(ctx.account, session);
		const usage = await Billing.usage(ctx.account, session);
		const capacity = Math.max(Billing.plans.team.seats, Number(account?.billing?.seat_quantity) || Billing.plans.team.seats);
		if (usage.people + usage.invitations + increase <= capacity) return;
		throw Billing.error(409, `Team has ${capacity} purchased seats`, 'plan_limit', { resource: 'people', limit: capacity, usage: usage.people + usage.invitations, upgrade_url: '/#settings-subscription' });
	}

	static async owner(accountId) {
		const member = await Member.findOne({ account: accountId, role: 'owner' }).lean();
		return member ? User.findById(member.user).lean() : null;
	}

	static async ensureCustomer(account, user, options = {}) {
		if (account?.billing?.stripe_customer_id) return account.billing.stripe_customer_id;
		if (!user?.email || !user?.name) throw new Error('Account owner email and name are required');
		const stripe = options.stripe || Billing.stripe();
		const params = { id: String(account._id), email: user.email, name: user.name, metadata: { ...Billing.metadata(account, account.plan || 'free'), customer_type: 'typerelay', owner_user_id: String(user._id) } };
		let customer;
		try { customer = await stripe.customers.create(params); } catch (error) {
			if ((error?.code || error?.raw?.code) !== 'resource_already_exists' && !/already exists/i.test(error?.message || '')) throw error;
			customer = await stripe.customers.retrieve(params.id);
		}
		await Account.updateOne({ _id: account._id }, { $set: { 'billing.stripe_customer_id': customer.id } });
		account.billing ||= {};
		account.billing.stripe_customer_id = customer.id;
		return customer.id;
	}

	static isFreeSubscription(subscription) {
		return Boolean(Billing.priceId('free') && subscription?.items?.data?.[0]?.price?.id === Billing.priceId('free'));
	}

	static async ensureFreeSubscription(account, user = null, options = {}) {
		if (!Billing.enabled() || !process.env.STRIPE_SECRET_KEY || !Billing.priceId('free')) return null;
		account = account?.billing?.stripe_customer_id !== undefined ? account : await Billing.account(account._id || account, null, true);
		if (!account || account.billing?.stripe_free_subscription_id) return account?.billing?.stripe_free_subscription_id || null;
		if (account.billing?.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(account.billing.status)) return null;
		user ||= await Billing.owner(account._id);
		const stripe = options.stripe || Billing.stripe();
		const customer = await Billing.ensureCustomer(account, user, { stripe });
		const existing = await stripe.subscriptions.list({ customer, price: Billing.priceId('free'), status: 'active', limit: 1 });
		const subscription = existing.data?.[0] || await stripe.subscriptions.create({ customer, items: [{ price: Billing.priceId('free'), quantity: 1 }], metadata: Billing.metadata(account, 'free') });
		await Account.updateOne({ _id: account._id }, { $set: { 'billing.stripe_free_subscription_id': subscription.id } });
		return subscription.id;
	}

	static async cancelFreeSubscription(account, options = {}) {
		account = account?.billing?.stripe_free_subscription_id !== undefined ? account : await Billing.account(account._id || account, null, true);
		const id = account?.billing?.stripe_free_subscription_id;
		if (!id) return false;
		try { await (options.stripe || Billing.stripe()).subscriptions.cancel(id); } catch (error) { if ((error?.code || error?.raw?.code) !== 'resource_missing' && !/canceled/i.test(error?.message || '')) throw error; }
		await Account.updateOne({ _id: account._id }, { $unset: { 'billing.stripe_free_subscription_id': '' } });
		return true;
	}

	static async initializeAccount(account, user, options = {}) {
		if (!Billing.enabled() || !process.env.STRIPE_SECRET_KEY) return null;
		account = await Billing.account(account._id || account, null, true);
		await Billing.ensureCustomer(account, user, options);
		return Billing.ensureFreeSubscription(account, user, options);
	}

	static checkoutSeats(plan, value) {
		if (plan === 'pro') return 1;
		const seats = Number(value || Billing.plans.team.seats);
		if (!Number.isSafeInteger(seats) || seats < Billing.plans.team.seats || seats > 10000) throw Billing.error(400, 'Team seats must be 5–10,000', 'invalid_seat_quantity');
		return seats;
	}

	static async checkout(accountId, user, input = {}, options = {}) {
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const plan = ['pro', 'team'].includes(input.plan) ? input.plan : 'pro';
		const price = Billing.priceId(plan);
		if (!price) throw Billing.error(503, `${Billing.plans[plan].name} Stripe Price is not configured`, 'billing_unavailable');
		const seats = Billing.checkoutSeats(plan, input.seats);
		const account = await Billing.account(accountId, null, true);
		if (account.billing?.stripe_subscription_id && ['active', 'past_due', 'trialing'].includes(account.billing.status) && account.billing.trial_source !== 'no_card') throw Billing.error(409, 'Use subscription management to change an active plan', 'subscription_active');
		const stripe = options.stripe || Billing.stripe();
		const customer = await Billing.ensureCustomer(account, user, { stripe });
		const metadata = Billing.metadata(account, plan);
		const suffix = randomBytes(6).toString('base64url').replace(/[^a-z]/gi, '').slice(0, 8).padEnd(8, 'x');
		const params = {
			customer,
			mode: 'subscription',
			payment_method_collection: 'always',
			line_items: [{ price, quantity: seats }],
			client_reference_id: String(account._id),
			metadata,
			subscription_data: { metadata },
			success_url: options.successUrl,
			cancel_url: options.cancelUrl,
			integration_identifier: `typerelay_${suffix}`,
		};
		Object.assign(params, { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } });
		const checkout = await stripe.checkout.sessions.create(params);
		return checkout.url;
	}

	static async portal(accountId, returnUrl, options = {}) {
		const account = await Billing.account(accountId, null, true);
		const user = options.user || await Billing.owner(accountId);
		const stripe = options.stripe || Billing.stripe();
		const customer = account.billing?.stripe_customer_id || await Billing.ensureCustomer(account, user, { stripe });
		const configuration = Billing.portalConfig();
		if (!configuration) throw Billing.error(503, 'Stripe Portal is not configured', 'billing_unavailable');
		return (await stripe.billingPortal.sessions.create({ customer, configuration, return_url: returnUrl })).url;
	}

	static async reconcileCheckout(sessionId, userId, options = {}) {
		const stripe = options.stripe || Billing.stripe();
		const checkout = await stripe.checkout.sessions.retrieve(sessionId);
		if (checkout.status !== 'complete' || checkout.mode !== 'subscription' || !checkout.subscription) throw Billing.error(409, 'Checkout is not complete', 'checkout_incomplete');
		const accountId = checkout.metadata?.account_id;
		const member = accountId ? await Member.exists({ account: accountId, user: userId }) : null;
		if (!member) throw Billing.error(403, 'Checkout account access denied', 'billing_mismatch');
		const account = await Billing.account(accountId, null, true);
		if (String(checkout.customer?.id || checkout.customer) !== String(account.billing?.stripe_customer_id) || String(checkout.client_reference_id) !== String(account._id)) throw Billing.error(409, 'Checkout ownership mismatch', 'billing_mismatch');
		const subscription = await stripe.subscriptions.retrieve(checkout.subscription.id || checkout.subscription);
		await Billing.applySubscription(account, subscription, { stripe });
		await Billing.cancelFreeSubscription(account, { stripe });
		return account;
	}

	static async validateChangeUsage(account, plan, seats) {
		const usage = await Billing.usage(account._id);
		if (plan !== 'team' && usage.people + usage.invitations > 1) throw Billing.error(409, 'Remove extra members and invitations before changing to this plan', 'plan_limit', { resource: 'people', limit: 1, usage: usage.people + usage.invitations });
		if (plan === 'team' && usage.people + usage.invitations > seats) throw Billing.error(409, 'Purchased seats cannot be below members and invitations', 'plan_limit', { resource: 'people', limit: seats, usage: usage.people + usage.invitations });
		return usage;
	}

	static subscriptionItem(subscription) {
		if (subscription?.items?.data?.length !== 1) throw Billing.error(409, 'TypeRelay subscriptions require one item', 'billing_mismatch');
		return subscription.items.data[0];
	}

	static validateSubscription(account, subscription) {
		if (!subscription || String(subscription.customer?.id || subscription.customer) !== String(account.billing?.stripe_customer_id)) throw Billing.error(409, 'Stripe subscription customer mismatch', 'billing_mismatch');
		if (subscription.metadata?.catalog !== Billing.catalogName || subscription.metadata?.account_id !== String(account._id)) throw Billing.error(409, 'Stripe subscription ownership mismatch', 'billing_mismatch');
		return Billing.subscriptionItem(subscription);
	}

	static async change(accountId, input = {}, options = {}) {
		const account = await Billing.account(accountId, null, true);
		const target = ['pro', 'team'].includes(input.plan) ? input.plan : null;
		if (!target) throw Billing.error(400, 'Choose Pro or Team', 'invalid_plan');
		const seats = Billing.checkoutSeats(target, input.seats);
		await Billing.validateChangeUsage(account, target, seats);
		if (!account.billing?.stripe_subscription_id || !['active', 'past_due', 'trialing'].includes(account.billing.status)) throw Billing.error(409, 'No paid subscription to change', 'subscription_missing');
		const stripe = options.stripe || Billing.stripe();
		const subscription = await stripe.subscriptions.retrieve(account.billing.stripe_subscription_id);
		const item = Billing.validateSubscription(account, subscription);
		const currentPlan = account.plan;
		const currentSeats = Number(item.quantity || account.billing.seat_quantity || 1);
		const downgrade = Billing.plans[target].rank < Billing.plans[currentPlan].rank || (target === currentPlan && seats < currentSeats);
		if (!downgrade) {
			const configuration = Billing.portalConfig();
			if (!configuration) throw Billing.error(503, 'Stripe change Portal is not configured', 'billing_unavailable');
			const session = await stripe.billingPortal.sessions.create({ customer: account.billing.stripe_customer_id, configuration, return_url: options.returnUrl, flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscription.id, items: [{ id: item.id, price: Billing.priceId(target), quantity: seats }] }, after_completion: { type: 'redirect', redirect: { return_url: options.returnUrl } } } });
			return { url: session.url };
		}
		const periodEnd = Number(item.current_period_end || subscription.current_period_end);
		if (!periodEnd) throw Billing.error(409, 'Stripe subscription period is unavailable', 'billing_mismatch');
		let schedule = subscription.schedule ? await stripe.subscriptionSchedules.retrieve(subscription.schedule.id || subscription.schedule) : await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
		const currentStart = Number(schedule.current_phase?.start || item.current_period_start || subscription.current_period_start);
		schedule = await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'release', phases: [{ items: [{ price: item.price.id, quantity: currentSeats }], start_date: currentStart, end_date: periodEnd, proration_behavior: 'none', metadata: subscription.metadata }, { items: [{ price: Billing.priceId(target), quantity: seats }], start_date: periodEnd, iterations: 1, proration_behavior: 'none', metadata: Billing.metadata(account, target) }] });
		const scheduled = { plan: target, seat_quantity: seats, effective_at: new Date(periodEnd * 1000), schedule_id: schedule.id };
		await Account.updateOne({ _id: account._id }, { $set: { 'billing.scheduled_change': scheduled } });
		return { scheduled_change: scheduled };
	}

	static async startTrial(accountId, now = new Date()) {
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const account = await Billing.account(accountId, null, true);
		if (!account || Billing.entitlements(account, now).plan !== 'free' || account.billing?.trial_started_at) throw Billing.error(409, 'The Pro trial is no longer available', 'trial_unavailable');
		const ends = new Date(now.getTime() + Billing.trialDays() * 86400000);
		const result = await Account.updateOne({ _id: accountId, plan: { $in: ['free', null] }, 'billing.trial_started_at': null, $or: [{ 'billing.status': { $in: ['incomplete', 'trial_expired', 'canceled'] } }, { 'billing.status': { $exists: false } }] }, { $set: { plan: 'free', 'billing.status': 'trialing', 'billing.trial_source': 'no_card', 'billing.trial_started_at': now, 'billing.trial_ends_at': ends, 'billing.status_changed_at': now } });
		if (result.modifiedCount !== 1) throw Billing.error(409, 'The Pro trial is no longer available', 'trial_unavailable');
		return Billing.account(accountId);
	}

	static async runTrialExpiry(now = new Date(), options = {}) {
		const accountModel = options.accountModel || Account;
		const result = await accountModel.updateMany({ plan: 'free', 'billing.status': 'trialing', 'billing.trial_source': 'no_card', 'billing.trial_ends_at': { $lte: now } }, { $set: { 'billing.status': 'trial_expired', 'billing.status_changed_at': now } });
		return { expired: result.modifiedCount || 0 };
	}

	static planFromSubscription(subscription) {
		if (Billing.isFreeSubscription(subscription)) return 'free';
		const price = Billing.subscriptionItem(subscription).price?.id;
		if (price === Billing.priceId('pro')) return 'pro';
		if (price === Billing.priceId('team')) return 'team';
		throw Billing.error(409, 'Stripe subscription uses an unknown Price', 'billing_mismatch');
	}

	static async applySubscription(account, subscription, options = {}) {
		const item = Billing.validateSubscription(account, subscription);
		const plan = Billing.planFromSubscription(subscription);
		if (plan === 'free') return account;
		const now = new Date();
		const status = subscription.status;
		const active = ['active', 'trialing', 'past_due'].includes(status);
		const update = { plan: active ? plan : 'free', 'billing.stripe_subscription_id': subscription.id, 'billing.price_id': item.price.id, 'billing.seat_quantity': Number(item.quantity || 1), 'billing.status': status, 'billing.trial_source': subscription.trial_end ? 'stripe' : null, 'billing.trial_ends_at': subscription.trial_end ? new Date(subscription.trial_end * 1000) : null, 'billing.status_changed_at': now };
		if (account.billing?.scheduled_change?.plan === plan && Number(account.billing.scheduled_change.seat_quantity) === Number(item.quantity || 1)) Object.assign(update, { 'billing.scheduled_change': null });
		await Account.updateOne({ _id: account._id }, { $set: update });
		Object.assign(account, { plan: update.plan, billing: { ...account.billing, status, price_id: item.price.id, seat_quantity: Number(item.quantity || 1), stripe_subscription_id: subscription.id } });
		if (update.plan !== 'team') {
			const { WhiteLabel } = await import('./white_label.js');
			await WhiteLabel.disable(account, options).catch(error => console.error(`White-label disable after downgrade failed: ${error.message}`));
		}
		return account;
	}

	static async findWebhookAccount(object) {
		const customer = object?.customer?.id || object?.customer;
		const subscription = object?.object === 'subscription' ? object.id : object?.subscription?.id || object?.subscription;
		const accountId = object?.metadata?.account_id;
		const filters = [];
		if (accountId) filters.push({ _id: accountId });
		if (customer) filters.push({ 'billing.stripe_customer_id': customer });
		if (subscription) filters.push({ 'billing.stripe_subscription_id': subscription });
		if (!filters.length) return null;
		return Account.findOne({ $or: filters }).select('+billing.stripe_customer_id +billing.stripe_subscription_id +billing.stripe_free_subscription_id +billing.scheduled_change.schedule_id +white_label.cloudflare_hostname_id').lean();
	}

	static async handleWebhook(rawBody, signature, options = {}) {
		const stripe = options.stripe || Billing.stripe();
		const event = options.event || stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
		const object = event.data.object;
		const account = await Billing.findWebhookAccount(object);
		if (!account) return { handled: false };
		if (event.type === 'checkout.session.completed' && object.subscription) {
			const subscription = await stripe.subscriptions.retrieve(object.subscription.id || object.subscription);
			if (!Billing.isFreeSubscription(subscription)) { await Billing.applySubscription(account, subscription, { stripe }); await Billing.cancelFreeSubscription(account, { stripe }); }
		} else if (['customer.subscription.created', 'customer.subscription.updated'].includes(event.type)) {
			if (!Billing.isFreeSubscription(object)) await Billing.applySubscription(account, object, { stripe });
		} else if (event.type === 'customer.subscription.deleted' && !Billing.isFreeSubscription(object)) {
			await Account.updateOne({ _id: account._id }, { $set: { plan: 'free', 'billing.status': 'canceled', 'billing.trial_source': null, 'billing.trial_ends_at': null, 'billing.scheduled_change': null, 'billing.status_changed_at': new Date() } });
			account.plan = 'free'; account.billing.status = 'canceled'; account.billing.stripe_subscription_id = null;
			const { WhiteLabel } = await import('./white_label.js');
			await WhiteLabel.disable(account, { stripe }).catch(error => console.error(`White-label disable after cancellation failed: ${error.message}`));
			await Billing.ensureFreeSubscription(account, null, { stripe }).catch(error => console.error(`Free subscription restore failed: ${error.message}`));
		} else if (event.type === 'invoice.payment_failed') {
			await Account.updateOne({ _id: account._id }, { $set: { 'billing.status': 'past_due', 'billing.status_changed_at': new Date() } });
		} else if (event.type === 'invoice.paid' && object.subscription) {
			const subscription = await stripe.subscriptions.retrieve(object.subscription.id || object.subscription);
			if (!Billing.isFreeSubscription(subscription)) await Billing.applySubscription(account, subscription, { stripe });
		} else if (event.type.startsWith('subscription_schedule.') && ['canceled', 'aborted', 'completed', 'released'].includes(String(object.status))) {
			await Account.updateOne({ _id: account._id }, { $set: { 'billing.scheduled_change': null } });
		}
		return { handled: true, type: event.type, account: String(account._id) };
	}

	static locals(account, ctx, usage = null, now = new Date()) {
		const entitlements = Billing.entitlements(account, now);
		const status = account?.billing?.status || 'incomplete';
		return { account, ctx, usage, entitlements, plan: entitlements.plan, billingStatus: status, isTrialing: entitlements.trial, trialText: entitlements.trial ? Billing.trialText(account, now) : '', trialAvailable: Billing.enabled() && entitlements.plan === 'free' && !account?.billing?.trial_started_at, canManageBilling: ['owner', 'admin'].includes(ctx?.role || ''), billingEnabled: Billing.enabled(), plans: Billing.plans };
	}

	static async fragments(accountId, ctx) {
		const account = await Billing.account(accountId);
		const locals = Billing.locals(account, ctx, await Billing.usage(accountId));
		return { account, entitlements: locals.entitlements, subscription_html: pug.renderFile('./views/ajax/subscription.pug', locals), trial_html: pug.renderFile('./views/ajax/trial-button.pug', locals), tokens_form_html: locals.entitlements.capabilities.api ? pug.renderFile('./views/ajax/access-token-form.pug', { integrationScopes: scopes }) : '' };
	}
}
