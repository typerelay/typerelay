import Stripe from 'stripe';
import { Billing } from '../services/billing.js';

export class StripeProvisioner {
	static taxCode = 'txcd_10103001';
	static webhookEvents = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'subscription_schedule.updated', 'subscription_schedule.released', 'subscription_schedule.completed', 'subscription_schedule.canceled', 'subscription_schedule.aborted'];

	static client() {
		if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
		if (process.env.STRIPE_SECRET_KEY.includes('_live_') && process.env.STRIPE_PROVISION_LIVE !== 'true') throw new Error('Set STRIPE_PROVISION_LIVE=true to provision the live Stripe account');
		return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-07-29.dahlia', maxNetworkRetries: 2, timeout: 15000 });
	}

	static metadata(plan = '') { return { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, ...(plan ? { plan_key: plan } : {}) }; }

	static async validateTax(stripe) {
		if (process.env.STRIPE_TAX_ENABLED !== 'true') return;
		const [settings, registrations] = await Promise.all([stripe.tax.settings.retrieve(), stripe.tax.registrations.list({ status: 'active', limit: 100 })]);
		if (settings.status !== 'active' || !registrations.data.length) throw new Error('Stripe Tax requires active settings and at least one active registration before Checkout activation');
	}

	static async product(stripe, plan) {
		const products = await stripe.products.list({ active: true, limit: 100 });
		let product = products.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName && candidate.metadata?.plan_key === plan.key);
		const params = { name: `TypeRelay ${plan.name}`, tax_code: StripeProvisioner.taxCode, metadata: StripeProvisioner.metadata(plan.key) };
		if (!product) product = await stripe.products.create(params);
		else if (product.name !== params.name || product.tax_code !== params.tax_code || product.metadata?.catalog_version !== Billing.catalogVersion) product = await stripe.products.update(product.id, params);
		return product;
	}

	static priceParams(product, plan) {
		const common = { product: product.id, currency: 'usd', recurring: { interval: 'month', usage_type: 'licensed' }, tax_behavior: 'exclusive', metadata: StripeProvisioner.metadata(plan.key) };
		if (plan.key === 'team') return { ...common, billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: [{ up_to: 5, flat_amount: 3900, unit_amount: 0 }, { up_to: 'inf', unit_amount: 600 }] };
		return { ...common, unit_amount: plan.price * 100 };
	}

	static validPrice(price, product, plan) {
		if (price.product !== product.id || price.currency !== 'usd' || price.recurring?.interval !== 'month' || price.recurring?.usage_type !== 'licensed' || price.tax_behavior !== 'exclusive') return false;
		if (plan.key !== 'team') return price.billing_scheme === 'per_unit' && price.unit_amount === plan.price * 100;
		const tiers = price.tiers || [];
		return price.billing_scheme === 'tiered' && price.tiers_mode === 'graduated' && tiers.length === 2 && tiers[0].up_to === 5 && tiers[0].flat_amount === 3900 && tiers[0].unit_amount === 0 && (tiers[1].up_to === null || tiers[1].up_to === 'inf') && tiers[1].unit_amount === 600;
	}

	static async price(stripe, product, plan) {
		const prices = await stripe.prices.list({ product: product.id, active: true, type: 'recurring', limit: 100, expand: ['data.tiers'] });
		const price = prices.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName && candidate.metadata?.catalog_version === Billing.catalogVersion && candidate.metadata?.plan_key === plan.key && StripeProvisioner.validPrice(candidate, product, plan));
		return price || stripe.prices.create(StripeProvisioner.priceParams(product, plan));
	}

	static async portal(stripe, purpose, products) {
		const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
		let portal = configurations.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName && candidate.metadata?.purpose === purpose);
		const general = purpose === 'account_management';
		const params = {
			name: `TypeRelay ${Billing.catalogVersion} ${general ? 'account' : 'change'}`,
			business_profile: { headline: 'TypeRelay is made by Helpmonks LLC' },
			features: general ? { customer_update: { enabled: true, allowed_updates: ['address', 'name', 'phone', 'tax_id'] }, invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } }, subscription_update: { enabled: false } } : { customer_update: { enabled: false }, invoice_history: { enabled: false }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: false }, subscription_update: { enabled: true, default_allowed_updates: ['price', 'quantity'], proration_behavior: 'create_prorations', products: products.filter(entry => entry.plan.key !== 'free').map(entry => ({ product: entry.product.id, prices: [entry.price.id] })) } },
			metadata: { ...StripeProvisioner.metadata(), purpose },
		};
		portal = portal ? await stripe.billingPortal.configurations.update(portal.id, { ...params, active: true }) : await stripe.billingPortal.configurations.create(params);
		return portal;
	}

	static async webhook(stripe) {
		const url = process.env.STRIPE_WEBHOOK_URL || 'https://app.typerelay.com/billing/webhook';
		const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
		let endpoint = endpoints.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName || candidate.url === url);
		if (endpoint) endpoint = await stripe.webhookEndpoints.update(endpoint.id, { url, enabled_events: StripeProvisioner.webhookEvents, metadata: StripeProvisioner.metadata(), description: 'TypeRelay subscription billing' });
		else endpoint = await stripe.webhookEndpoints.create({ url, api_version: '2026-07-29.dahlia', enabled_events: StripeProvisioner.webhookEvents, metadata: StripeProvisioner.metadata(), description: 'TypeRelay subscription billing' });
		return endpoint;
	}

	static async run(stripe = StripeProvisioner.client()) {
		await StripeProvisioner.validateTax(stripe);
		const products = [];
		for (const plan of Object.values(Billing.plans)) {
			const product = await StripeProvisioner.product(stripe, plan);
			products.push({ plan, product, price: await StripeProvisioner.price(stripe, product, plan) });
		}
		const general = await StripeProvisioner.portal(stripe, 'account_management', products);
		const change = await StripeProvisioner.portal(stripe, 'change_confirmation', products);
		const webhook = await StripeProvisioner.webhook(stripe);
		return { products, general, change, webhook };
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	StripeProvisioner.run().then(result => {
		for (const entry of result.products) {
			console.log(`STRIPE_${entry.plan.key.toUpperCase()}_PRODUCT_ID=${entry.product.id}`);
			console.log(`STRIPE_${entry.plan.key.toUpperCase()}_PRICE_ID=${entry.price.id}`);
		}
		console.log(`STRIPE_PORTAL_CONFIG_ID=${result.general.id}`);
		console.log(`STRIPE_CHANGE_PORTAL_CONFIG_ID=${result.change.id}`);
		console.log(`STRIPE_WEBHOOK_ENDPOINT_ID=${result.webhook.id}`);
		if (result.webhook.secret) console.log(`STRIPE_WEBHOOK_SECRET=${result.webhook.secret}`);
	}).catch(error => { console.error(`TypeRelay Stripe provisioning failed: ${error.message}`); process.exitCode = 1; });
}
