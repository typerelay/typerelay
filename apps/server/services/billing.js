import Stripe from 'stripe';
import { AccountAccess } from './account_access.js';
import pug from 'pug';
import { randomBytes } from 'node:crypto';
import { Account, Device, Library, Member, Snippet, Ticket, User } from '../model/index.js';

export class Billing {
	static catalogName = 'typerelay_2026';
	static catalogVersion = '2026-10';
	static stripeClient = null;
	static plans = {
		free: { key: 'free', name: 'Free', rank: 0, price: 0, seats: 1, limits: { people: 1, snippets: 250, libraries: 1, machines: 1 }, capabilities: { sso: false, api: false, mcp: false, sharing: false, team: false, white_label: false, sync: true, dynamic_extensions: true } },
		pro: { key: 'pro', name: 'Pro', rank: 1, price: 4, seats: 1, limits: { people: 5, snippets: 0, libraries: 0, machines: 0 }, capabilities: { sso: true, api: true, mcp: true, sharing: true, team: true, white_label: false, sync: true, dynamic_extensions: true } },
		team: { key: 'team', name: 'Team', rank: 2, price: 8, seats: 1, limits: { people: 0, snippets: 0, libraries: 0, machines: 0 }, capabilities: { sso: true, api: true, mcp: true, sharing: true, team: true, white_label: true, sync: true, dynamic_extensions: true } },
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
			Billing.stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 2, timeout: 15000 });
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
		const base = Billing.baseEntitlements(account, now);
		const override = account?.admin_override;
		const result = override?.plan ? { ...Billing.plans[override.plan], plan: override.plan, billing_enabled: base.billing_enabled, trial: false } : { ...base };
		result.limits = { ...result.limits };
		for (const key of ['people', 'snippets', 'libraries', 'machines']) if (Number.isSafeInteger(override?.limits?.[key]) && override.limits[key] >= 0) result.limits[key] = override.limits[key];
		result.admin_override = Boolean(override?.plan || Object.values(override?.limits || {}).some(value => value !== null && value !== undefined));
		result.machine_override = override?.limits?.machines != null;
		return result;
	}
	static baseEntitlements(account, now = new Date()) {
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
		if (secrets) query = query.select('+billing.stripe_customer_id +billing.stripe_subscription_id +billing.stripe_free_subscription_id +billing.scheduled_change.schedule_id +billing.checkout.session_id +white_label.cloudflare_hostname_id +white_label.logo.storage_key +white_label.favicon.storage_key +white_label.login_logo.storage_key');
		const account = await query.lean();
		if (account) AccountAccess.assert(account);
		return account;
	}

	static assertCapability(ctx, capability, message = '') {
		if (ctx?.entitlements?.capabilities?.[capability]) return;
		throw Billing.error(403, message || `${Billing.plans.team.name} or Pro access required`, 'plan_required', { capability, upgrade_url: '/#settings-subscription' });
	}

	static assertApi(ctx) { Billing.assertCapability(ctx, 'api', 'API and MCP access require Pro or Team'); }
	static assertTeam(ctx, capability = 'team') { Billing.assertCapability(ctx, capability, 'Pro or Team plan required'); }

	static seatCapacity(account, entitlements = Billing.entitlements(account)) {
		if (account?.admin_override?.plan || account?.admin_override?.limits?.people != null || !entitlements.billing_enabled) return entitlements.limits.people;
		if (entitlements.plan === 'free') return 1;
		const purchased = Number(account?.billing?.seat_quantity);
		let capacity = entitlements.trial ? Billing.plans.pro.limits.people : Number.isSafeInteger(purchased) && purchased > 0 ? purchased : 1;
		if (entitlements.limits.people) capacity = Math.min(capacity, entitlements.limits.people);
		if (account?.billing?.checkout?.seat_quantity) capacity = Math.min(capacity, account.billing.checkout.seat_quantity);
		const scheduled = account?.billing?.scheduled_change;
		if (scheduled?.plan && Number.isSafeInteger(scheduled.seat_quantity) && scheduled.seat_quantity > 0) capacity = Math.min(capacity, scheduled.seat_quantity, Billing.plans[scheduled.plan].limits.people || Infinity);
		return capacity;
	}

	static async usage(accountId, session = null) {
		const activeLibraries = await Library.find({ account: accountId, state: 'active' }).select('_id').session(session || null).lean();
		const [snippets, people, invitations, machines] = await Promise.all([
			Snippet.countDocuments({ account: accountId, library: { $in: activeLibraries.map(library => library._id) }, state: 'active' }).session(session || null),
			Member.countDocuments({ account: accountId }).session(session || null),
			Ticket.countDocuments({ account: accountId, kind: 'invite', expires: { $gt: new Date() } }).session(session || null),
			Device.countDocuments({ account: accountId, revoked: false, client_type: { $ne: 'browser' } }).session(session || null),
		]);
		return { libraries: activeLibraries.length, snippets, people, invitations, machines };
	}

	static async memberAllowed(account, member, session = null) {
		if (!member) return false;
		if (member.role === 'owner') return true;
		const entitlements = Billing.entitlements(account);
		if (!entitlements.capabilities.team) return false;
		const capacity = Billing.seatCapacity(account, entitlements);
		if (!capacity) return true;
		// Retained memberships can outlive a paid plan. Keep the owner and earliest members within the effective capacity.
		const position = await Member.countDocuments({ account: account._id, $or: [{ role: 'owner' }, { role: { $ne: 'owner' }, _id: { $lte: member._id } }] }).session(session || null);
		return position <= capacity;
	}

	static assertLimit(ctx, resource, current, increase = 1) {
		const limit = ctx?.entitlements?.limits?.[resource] || 0;
		if (!limit || current + increase <= limit) return;
		throw Billing.error(409, `Account allows ${limit} ${resource}`, 'plan_limit', { resource, limit, usage: current, upgrade_url: '/#settings-subscription' });
	}

	static async assertResourceIncrease(ctx, resource, increase, session = null) {
		if (!increase) return;
		const usage = await Billing.usage(ctx.account, session);
		Billing.assertLimit(ctx, resource, usage[resource], increase);
	}

	static async assertDeviceEnrollment(ctx, session = null, client = 'typerelay-desktop') {
		if (client === 'typerelay-browser') return;
		if (!ctx.entitlements.limits.machines) return;
		const count = await Device.countDocuments({ account: ctx.account, user: ctx.user, revoked: false, client_type: { $ne: 'browser' } }).session(session || null);
		Billing.assertLimit(ctx, 'machines', count, 1);
	}

	static async assertDevice(ctx, device, session = null) {
		if (device.client_type === 'browser') return;
		if (!ctx.entitlements.limits.machines) return;
		if (ctx.entitlements.machine_override) return;
		const primary = await Device.findOne({ account: ctx.account, user: ctx.user, revoked: false, client_type: { $ne: 'browser' } }).sort({ createdAt: 1, _id: 1 }).select('_id').session(session || null).lean();
		if (!primary || String(primary._id) === String(device._id || device)) return;
		throw Billing.error(403, 'Free allows one connected machine', 'plan_limit', { resource: 'machines', limit: 1, upgrade_url: '/#settings-subscription' });
	}

	static async assertSeatCapacity(ctx, increase = 1, session = null) {
		const account = await Billing.account(ctx.account, session);
		const entitlements = Billing.entitlements(account);
		Billing.assertTeam({ ...ctx, entitlements });
		const capacity = Billing.seatCapacity(account, entitlements);
		if (!capacity) return;
		const usage = await Billing.usage(ctx.account, session);
		if (usage.people + usage.invitations + increase <= capacity) return;
		throw Billing.error(409, `Account allows ${capacity} people, including pending invitations`, 'plan_limit', { resource: 'people', limit: capacity, usage: usage.people + usage.invitations, upgrade_url: '/#settings-subscription' });
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
		if (account?.deletion?.requested_at || account?.is_active === false) return null;
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
		return AccountAccess.run(account._id || account, () => Billing.provisionBilling(account, user, options));
	}
	static async provisionBilling(account, user, options = {}) {
		if (!Billing.enabled() || !process.env.STRIPE_SECRET_KEY) return null;
		account = await Billing.account(account._id || account, null, true);
		await Billing.ensureCustomer(account, user, options);
		return Billing.ensureFreeSubscription(account, user, options);
	}

	static checkoutSeats(plan, value) {
		if (!['pro', 'team'].includes(plan)) throw Billing.error(400, 'Choose Pro or Team', 'invalid_plan');
		const seats = Number(value ?? Billing.plans[plan].seats);
		const maximum = Billing.plans[plan].limits.people || 10000;
		if (!Number.isSafeInteger(seats) || seats < 1 || seats > maximum) throw Billing.error(400, `${Billing.plans[plan].name} seats must be 1–${maximum.toLocaleString('en-US')}`, 'invalid_seat_quantity');
		return seats;
	}

	static async checkout(accountId, user, input = {}, options = {}) {
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const plan = ['pro', 'team'].includes(input.plan) ? input.plan : 'pro';
		const price = Billing.priceId(plan);
		if (!price) throw Billing.error(503, `${Billing.plans[plan].name} Stripe Price is not configured`, 'billing_unavailable');
		const seats = Billing.checkoutSeats(plan, input.seats);
		const account = await Billing.account(accountId, null, true);
		if (account) await AccountAccess.acquire(account._id);
		if (account.billing?.stripe_subscription_id && ['active', 'past_due', 'trialing'].includes(account.billing.status) && account.billing.trial_source !== 'no_card') throw Billing.error(409, 'Use subscription management to change an active plan', 'subscription_active');
		await Billing.validateChangeUsage(account, plan, seats);
		const stripe = options.stripe || Billing.stripe();
		if (account.billing?.checkout?.session_id) {
			const existing = await stripe.checkout.sessions.retrieve(account.billing.checkout.session_id);
			if (existing.status === 'open' && account.billing.checkout.plan === plan && account.billing.checkout.seat_quantity === seats) return existing.url;
			if (existing.status !== 'expired') throw Billing.error(409, 'Finish or cancel the existing checkout before choosing another subscription', 'checkout_pending');
			await Account.updateOne({ _id: account._id, 'billing.checkout.session_id': existing.id }, { $set: { 'billing.checkout': null } });
		}
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
			expires_at: Math.floor(Date.now() / 1000) + 1860,
		};
		Object.assign(params, { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } });
		const checkout = await stripe.checkout.sessions.create(params);
		try {
			await AccountAccess.write(account._id, async session => {
				const current = await Billing.account(account._id, session, true);
				if (current.billing?.checkout?.session_id || (current.billing?.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(current.billing.status) && current.billing.trial_source !== 'no_card')) throw Billing.error(409, 'A checkout or subscription is already active', 'checkout_pending');
				await Billing.validateChangeUsage(current, plan, seats, session);
				await Account.updateOne({ _id: account._id }, { $set: { 'billing.checkout': { session_id: checkout.id, plan, seat_quantity: seats } } }, { session });
			});
		} catch (error) { await stripe.checkout.sessions.expire(checkout.id); throw error; }
		return checkout.url;
	}

	static async cancelCheckout(accountId, options = {}) {
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const account = await Billing.account(accountId, null, true);
		await AccountAccess.acquire(account._id);
		const id = account.billing?.checkout?.session_id;
		if (!id) return;
		const stripe = options.stripe || Billing.stripe();
		const checkout = await stripe.checkout.sessions.retrieve(id);
		if (checkout.status === 'complete') throw Billing.error(409, 'Checkout is complete; wait for payment confirmation', 'checkout_complete');
		if (checkout.status === 'open') await stripe.checkout.sessions.expire(id);
		await Account.updateOne({ _id: account._id, 'billing.checkout.session_id': id }, { $set: { 'billing.checkout': null } });
	}

	static async portal(accountId, returnUrl, options = {}) {
		const account = await Billing.account(accountId, null, true);
		if (account) await AccountAccess.acquire(account._id);
		const user = options.user || await Billing.owner(accountId);
		const stripe = options.stripe || Billing.stripe();
		const customer = account.billing?.stripe_customer_id || await Billing.ensureCustomer(account, user, { stripe });
		const configuration = Billing.portalConfig();
		if (!configuration) throw Billing.error(503, 'Stripe Portal is not configured', 'billing_unavailable');
		return (await stripe.billingPortal.sessions.create({ customer, configuration, return_url: returnUrl })).url;
	}

	static async changePortalConfiguration(stripe, plan, seats) {
		Billing.checkoutSeats(plan, seats);
		const price = await stripe.prices.retrieve(Billing.priceId(plan));
		if (!price.active || price.currency !== 'usd' || price.unit_amount !== Billing.plans[plan].price * 100 || price.billing_scheme !== 'per_unit' || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed' || price.metadata?.catalog !== Billing.catalogName || price.metadata?.catalog_version !== Billing.catalogVersion || price.metadata?.plan_key !== plan) throw Billing.error(503, 'Stripe Price does not match the current Typerelay plan', 'billing_mismatch');
		// The general portal has no subscription editor. Deep links confirm server-selected changes with the target plan's seat bounds.
		let starting_after;
		do {
			const page = await stripe.billingPortal.configurations.list({ active: true, limit: 100, expand: ['data.features.subscription_update.products'], ...(starting_after ? { starting_after } : {}) });
			const existing = page.data.find(config => config.metadata?.catalog === Billing.catalogName && config.metadata?.catalog_version === Billing.catalogVersion && config.metadata?.purpose === 'confirmed_change' && config.metadata?.price_id === price.id && config.features?.subscription_update?.enabled && config.features.subscription_update.products?.length === 1 && config.features.subscription_update.products[0].prices?.length === 1 && config.features.subscription_update.products[0].prices[0] === price.id && config.features.subscription_update.products[0].adjustable_quantity?.minimum === 1 && config.features.subscription_update.products[0].adjustable_quantity?.maximum === (Billing.plans[plan].limits.people || 10000));
			if (existing) return existing.id;
			starting_after = page.has_more ? page.data.at(-1)?.id : null;
		} while (starting_after);
		const configuration = await stripe.billingPortal.configurations.create({ name: `TypeRelay ${plan} confirmation (${Billing.catalogVersion})`, business_profile: { headline: 'Confirm your TypeRelay subscription change' }, features: { payment_method_update: { enabled: true }, subscription_update: { enabled: true, default_allowed_updates: ['price', 'quantity'], proration_behavior: 'create_prorations', products: [{ product: price.product, prices: [price.id], adjustable_quantity: { enabled: true, minimum: 1, maximum: Billing.plans[plan].limits.people || 10000 } }] } }, metadata: { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, purpose: 'confirmed_change', price_id: price.id } }, { idempotencyKey: `typerelay-change-${Billing.catalogVersion}-${price.id}` });
		return configuration.id;
	}

	static async reconcileCheckout(sessionId, userId, options = {}) {
		const stripe = options.stripe || Billing.stripe();
		const checkout = await stripe.checkout.sessions.retrieve(sessionId);
		if (checkout.status !== 'complete' || checkout.mode !== 'subscription' || !checkout.subscription) throw Billing.error(409, 'Checkout is not complete', 'checkout_incomplete');
		const accountId = checkout.metadata?.account_id;
		const member = accountId ? await Member.exists({ account: accountId, user: userId }) : null;
		if (!member) throw Billing.error(403, 'Checkout account access denied', 'billing_mismatch');
		const account = await Billing.account(accountId, null, true);
		if (account) await AccountAccess.acquire(account._id);
		if (String(checkout.customer?.id || checkout.customer) !== String(account.billing?.stripe_customer_id) || String(checkout.client_reference_id) !== String(account._id)) throw Billing.error(409, 'Checkout ownership mismatch', 'billing_mismatch');
		const subscription = await stripe.subscriptions.retrieve(checkout.subscription.id || checkout.subscription);
		await Billing.applySubscription(account, subscription, { stripe });
		await Billing.cancelFreeSubscription(account, { stripe });
		return account;
	}

	static async validateChangeUsage(account, plan, seats, session = null) {
		const capacity = Billing.checkoutSeats(plan, seats);
		const usage = await Billing.usage(account._id, session);
		if (usage.people + usage.invitations > capacity) throw Billing.error(409, 'Purchased seats cannot be below members and invitations', 'plan_limit', { resource: 'people', limit: capacity, usage: usage.people + usage.invitations });
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
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const account = await Billing.account(accountId, null, true);
		if (account) await AccountAccess.acquire(account._id);
		const target = ['pro', 'team'].includes(input.plan) ? input.plan : null;
		if (!target) throw Billing.error(400, 'Choose Pro or Team', 'invalid_plan');
		const seats = Billing.checkoutSeats(target, input.seats);
		await Billing.validateChangeUsage(account, target, seats);
		if (!account.billing?.stripe_subscription_id || !['active', 'past_due', 'trialing'].includes(account.billing.status)) throw Billing.error(409, 'No paid subscription to change', 'subscription_missing');
		const stripe = options.stripe || Billing.stripe();
		const subscription = await stripe.subscriptions.retrieve(account.billing.stripe_subscription_id);
		const item = Billing.validateSubscription(account, subscription);
		if (subscription.schedule || account.billing?.scheduled_change?.plan) throw Billing.error(409, 'Cancel the scheduled change before making another change', 'billing_change_scheduled');
		const currentPlan = Billing.planFromSubscription(subscription);
		const currentSeats = Number(item.quantity || account.billing.seat_quantity || 1);
		const downgrade = Billing.plans[target].rank < Billing.plans[currentPlan].rank || seats < currentSeats;
		if (!downgrade) {
			const configuration = await Billing.changePortalConfiguration(stripe, target, seats);
			const session = await stripe.billingPortal.sessions.create({ customer: account.billing.stripe_customer_id, configuration, return_url: options.returnUrl, flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscription.id, items: [{ id: item.id, price: Billing.priceId(target), quantity: seats }] }, after_completion: { type: 'redirect', redirect: { return_url: options.returnUrl } } } });
			return { url: session.url };
		}
		const periodEnd = Number(item.current_period_end || subscription.current_period_end);
		if (!periodEnd) throw Billing.error(409, 'Stripe subscription period is unavailable', 'billing_mismatch');
		const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
		const currentStart = Number(schedule.current_phase?.start_date || item.current_period_start || subscription.current_period_start);
		const scheduled = { plan: target, seat_quantity: seats, effective_at: new Date(periodEnd * 1000), schedule_id: schedule.id, pending: true };
		try {
			await AccountAccess.write(account._id, async session => {
				const current = await Billing.account(account._id, session, true);
				if (current.billing?.scheduled_change?.plan || current.billing?.stripe_subscription_id !== subscription.id) throw Billing.error(409, 'Subscription changed; refresh and try again', 'billing_change_scheduled');
				await Billing.validateChangeUsage(current, target, seats, session);
				await Account.updateOne({ _id: account._id }, { $set: { 'billing.scheduled_change': scheduled } }, { session });
			});
		} catch (error) {
			await stripe.subscriptionSchedules.release(schedule.id);
			throw error;
		}
		// Reserve capacity before Stripe changes. On uncertain failure retain it until cancellation, so invitations cannot exceed the future seat count.
		await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'release', phases: [{ items: [{ price: item.price.id, quantity: currentSeats }], start_date: currentStart, end_date: periodEnd, ...(subscription.trial_end && subscription.trial_end > Date.now() / 1000 ? { trial_end: subscription.trial_end } : {}), proration_behavior: 'none', metadata: subscription.metadata }, { items: [{ price: Billing.priceId(target), quantity: seats }], start_date: periodEnd, duration: { interval: 'month', interval_count: 1 }, proration_behavior: 'none', metadata: Billing.metadata(account, target) }] });
		scheduled.pending = false;
		await Account.updateOne({ _id: account._id, 'billing.scheduled_change.schedule_id': schedule.id }, { $set: { 'billing.scheduled_change.pending': false } });
		return { scheduled_change: scheduled };
	}

	static async cancelChange(accountId, options = {}) {
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const account = await Billing.account(accountId, null, true);
		await AccountAccess.acquire(account._id);
		const id = account.billing?.scheduled_change?.schedule_id;
		if (!id) throw Billing.error(409, 'No scheduled change to cancel', 'billing_change_missing');
		const stripe = options.stripe || Billing.stripe();
		const schedule = await stripe.subscriptionSchedules.retrieve(id);
		if (String(schedule.customer?.id || schedule.customer) !== String(account.billing.stripe_customer_id)) throw Billing.error(409, 'Schedule ownership mismatch', 'billing_mismatch');
		if (['active', 'not_started'].includes(schedule.status)) await stripe.subscriptionSchedules.release(id);
		await Account.updateOne({ _id: account._id, 'billing.scheduled_change.schedule_id': id }, { $set: { 'billing.scheduled_change': null } });
		return { canceled: true };
	}

	static async startTrial(accountId, now = new Date()) {
		if (!Billing.enabled()) throw Billing.error(404, 'Billing is not available', 'not_found');
		const account = await Billing.account(accountId, null, true);
		if (account) await AccountAccess.acquire(account._id);
		if (!account || Billing.entitlements(account, now).plan !== 'free' || account.billing?.trial_started_at) throw Billing.error(409, 'The Pro trial is no longer available', 'trial_unavailable');
		const ends = new Date(now.getTime() + Billing.trialDays() * 86400000);
		const result = await Account.updateOne({ _id: accountId, plan: { $in: ['free', null] }, 'billing.trial_started_at': null, $or: [{ 'billing.status': { $in: ['incomplete', 'trial_expired', 'canceled'] } }, { 'billing.status': { $exists: false } }] }, { $set: { plan: 'free', 'billing.status': 'trialing', 'billing.trial_source': 'no_card', 'billing.trial_started_at': now, 'billing.trial_ends_at': ends, 'billing.status_changed_at': now, 'billing.helpmonks_sequence.status': 'pending', 'billing.helpmonks_sequence.attempts': 0, 'billing.helpmonks_sequence.next_attempt_at': now, 'billing.helpmonks_sequence.last_error': '', 'billing.helpmonks_sequence.contact_id': '', 'billing.helpmonks_sequence.enrolled_at': null } });
		if (result.modifiedCount !== 1) throw Billing.error(409, 'The Pro trial is no longer available', 'trial_unavailable');
		return Billing.account(accountId);
	}

	static async runTrialExpiry(now = new Date(), options = {}) {
		const accountModel = options.accountModel || Account;
		const result = await accountModel.updateMany({ ...AccountAccess.available, plan: 'free', 'billing.status': 'trialing', 'billing.trial_source': 'no_card', 'billing.trial_ends_at': { $lte: now } }, { $set: { 'billing.status': 'trial_expired', 'billing.status_changed_at': now } });
		return { expired: result.modifiedCount || 0 };
	}

	static planFromSubscription(subscription) {
		if (Billing.isFreeSubscription(subscription)) return 'free';
		const price = Billing.subscriptionItem(subscription).price;
		for (const plan of ['pro', 'team']) if (price?.id && price.id === Billing.priceId(plan)) return plan;
		// Stripe owns Price metadata. Keep earlier Typerelay catalog subscriptions recognizable after changing configured IDs.
		const plan = price?.metadata?.plan_key;
		if (price?.metadata?.catalog === Billing.catalogName && ['2026-09', Billing.catalogVersion].includes(price.metadata.catalog_version) && ['pro', 'team'].includes(plan) && price.currency === 'usd' && price.recurring?.interval === 'month' && price.recurring?.interval_count === 1 && price.recurring?.usage_type === 'licensed') {
			const legacy = price.metadata.catalog_version === '2026-09';
			if (legacy && plan === 'team' && price.billing_scheme === 'tiered' && price.tiers_mode === 'graduated') return plan;
			if (price.billing_scheme === 'per_unit' && price.unit_amount === (legacy ? 800 : Billing.plans[plan].price * 100)) return plan;
		}
		throw Billing.error(409, 'Stripe subscription uses an unknown Price', 'billing_mismatch');
	}

	static async applySubscription(account, subscription, options = {}) {
		const item = Billing.validateSubscription(account, subscription);
		if (account.billing?.stripe_subscription_id && account.billing.stripe_subscription_id !== subscription.id && ['active', 'past_due', 'trialing'].includes(account.billing.status) && account.billing.trial_source !== 'no_card') throw Billing.error(409, 'Another paid subscription is active', 'billing_mismatch');
		const plan = Billing.planFromSubscription(subscription);
		if (plan === 'free') return account;
		Billing.checkoutSeats(plan, item.quantity ?? 1);
		const now = new Date();
		const status = subscription.status;
		const active = ['active', 'trialing', 'past_due'].includes(status);
		const update = { plan: active ? plan : 'free', 'billing.stripe_subscription_id': subscription.id, 'billing.price_id': item.price.id, 'billing.seat_quantity': Number(item.quantity || 1), 'billing.status': status, 'billing.trial_source': subscription.trial_end ? 'stripe' : null, 'billing.trial_ends_at': subscription.trial_end ? new Date(subscription.trial_end * 1000) : null, 'billing.status_changed_at': now };
		const appliedSchedule = account.billing?.scheduled_change?.plan === plan && Number(account.billing.scheduled_change.seat_quantity) === Number(item.quantity || 1);
		if (active) update['billing.checkout'] = null;
		await Account.updateOne({ _id: account._id }, { $set: update });
		if (appliedSchedule) {
			const schedule = subscription.schedule?.id || subscription.schedule;
			if (schedule && schedule === account.billing.scheduled_change.schedule_id) await (options.stripe || Billing.stripe()).subscriptionSchedules.release(schedule);
			await Account.updateOne({ _id: account._id, 'billing.scheduled_change.schedule_id': account.billing.scheduled_change.schedule_id }, { $set: { 'billing.scheduled_change': null } });
		}
		Object.assign(account, { plan: update.plan, billing: { ...account.billing, status, price_id: item.price.id, seat_quantity: Number(item.quantity || 1), stripe_subscription_id: subscription.id } });
		if (Billing.entitlements(account).plan !== 'team') {
			const { WhiteLabel } = await import('./white_label.js');
			await WhiteLabel.disable(account, options).catch(error => console.error(`White-label disable after downgrade failed: ${error.message}`));
		}
		return account;
	}

	static async findWebhookAccount(object) {
		const customer = object?.customer?.id || object?.customer;
		const related = object?.parent?.subscription_details?.subscription || object?.subscription;
		const subscription = object?.object === 'subscription' ? object.id : related?.id || related;
		const accountId = object?.metadata?.account_id;
		const filters = [];
		if (accountId) filters.push({ _id: accountId });
		if (customer) filters.push({ 'billing.stripe_customer_id': customer });
		if (subscription) filters.push({ 'billing.stripe_subscription_id': subscription });
		if (!filters.length) return null;
		return Account.findOne({ $or: filters }).select('+billing.stripe_customer_id +billing.stripe_subscription_id +billing.stripe_free_subscription_id +billing.scheduled_change.schedule_id +billing.checkout.session_id +white_label.cloudflare_hostname_id').lean();
	}

	static async handleWebhook(rawBody, signature, options = {}) {
		const stripe = options.stripe || Billing.stripe();
		const event = options.event || stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
		const object = event.data.object;
		const account = await Billing.findWebhookAccount(object);
		if (!account || account.deletion?.requested_at) return { handled: false };
		return AccountAccess.run(account._id, () => Billing.processWebhook(account, event, stripe), true);
	}

	static async processWebhook(account, event, stripe) {
		const object = event.data.object;
		if (['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type)) {
			await Account.updateOne({ _id: account._id, 'billing.checkout.session_id': object.id }, { $set: { 'billing.checkout': null } });
			return { handled: true };
		}
		if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && object.subscription) {
			const subscription = await stripe.subscriptions.retrieve(object.subscription.id || object.subscription);
			if (!Billing.isFreeSubscription(subscription)) { await Billing.applySubscription(account, subscription, { stripe }); await Billing.cancelFreeSubscription(account, { stripe }); }
		} else if (['customer.subscription.created', 'customer.subscription.updated'].includes(event.type)) {
			if (Billing.isFreeSubscription(object)) return { handled: false };
			if (account.billing?.stripe_subscription_id && account.billing.stripe_subscription_id !== object.id) return { handled: false };
			const current = await stripe.subscriptions.retrieve(object.id);
			await Billing.applySubscription(account, current, { stripe });
		} else if (event.type === 'customer.subscription.deleted' && !Billing.isFreeSubscription(object)) {
			if (account.billing?.stripe_subscription_id !== object.id) return { handled: false };
			Billing.validateSubscription(account, object);
			await Account.updateOne({ _id: account._id }, { $set: { plan: 'free', 'billing.status': 'canceled', 'billing.stripe_subscription_id': null, 'billing.trial_source': null, 'billing.trial_ends_at': null, 'billing.scheduled_change': null, 'billing.status_changed_at': new Date() } });
			account.plan = 'free'; account.billing.status = 'canceled'; account.billing.stripe_subscription_id = null;
			const { WhiteLabel } = await import('./white_label.js');
			await WhiteLabel.disable(account, { stripe }).catch(error => console.error(`White-label disable after cancellation failed: ${error.message}`));
			await Billing.ensureFreeSubscription(account, null, { stripe }).catch(error => console.error(`Free subscription restore failed: ${error.message}`));
		} else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
			const related = object.parent?.subscription_details?.subscription || object.subscription;
			const id = related?.id || related;
			if (!id || id !== account.billing?.stripe_subscription_id) return { handled: false };
			const subscription = await stripe.subscriptions.retrieve(id);
			if (!Billing.isFreeSubscription(subscription)) await Billing.applySubscription(account, subscription, { stripe });
		} else if (event.type.startsWith('subscription_schedule.') && ['canceled', 'aborted', 'completed', 'released'].includes(String(object.status))) {
			await Account.updateOne({ _id: account._id, 'billing.scheduled_change.schedule_id': object.id }, { $set: { 'billing.scheduled_change': null } });
		}
		return { handled: true, type: event.type, account: String(account._id) };
	}

	static locals(account, ctx, usage = null, now = new Date()) {
		const entitlements = Billing.entitlements(account, now);
		const status = account?.billing?.status || 'incomplete';
		return { account, ctx, usage, entitlements, seatCapacity: Billing.seatCapacity(account, entitlements), plan: entitlements.plan, billingStatus: status, isTrialing: entitlements.trial, trialText: entitlements.trial ? Billing.trialText(account, now) : '', trialStartedAt: entitlements.trial && account?.billing?.trial_started_at ? new Date(account.billing.trial_started_at).toISOString() : '', trialEndsAt: entitlements.trial && account?.billing?.trial_ends_at ? new Date(account.billing.trial_ends_at).toISOString() : '', trialDays: Billing.trialDays(), trialAvailable: Billing.enabled() && entitlements.plan === 'free' && !account?.billing?.trial_started_at, canManageBilling: ['owner', 'admin'].includes(ctx?.role || ''), billingEnabled: Billing.enabled(), plans: Billing.plans };
	}

	static async fragments(accountId, ctx) {
		const account = await Billing.account(accountId);
		const locals = Billing.locals(account, ctx, await Billing.usage(accountId));
		const { Team } = await import('./team.js');
		locals.ctx = { ...ctx, entitlements: locals.entitlements };
		locals.team = await Team.list(locals.ctx);
		return { account, entitlements: locals.entitlements, subscription_html: pug.renderFile('./views/ajax/subscription.pug', locals), trial_html: pug.renderFile('./views/ajax/trial-button.pug', locals), team_notice_html: pug.renderFile('./views/ajax/team-plan-notice.pug', locals), team_add_html: pug.renderFile('./views/ajax/team-add.pug', locals), team_groups_html: pug.renderFile('./views/ajax/team-groups.pug', locals), statistics_scope_html: pug.renderFile('./views/ajax/statistics-scope.pug', locals), tokens_form_html: locals.entitlements.capabilities.api ? pug.renderFile('./views/ajax/access-token-form.pug') : '', oauth_client_form_html: locals.entitlements.capabilities.api && ['owner', 'admin'].includes(ctx.role) ? pug.renderFile('./views/ajax/oauth-client-form.pug') : '' };
	}
}
