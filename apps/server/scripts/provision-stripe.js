import Stripe from 'stripe';
import { Billing } from '../services/billing.js';

export class StripeProvisioner {
	static taxCode = 'txcd_10103001';
	static webhookEvents = ['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_failed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'subscription_schedule.updated', 'subscription_schedule.released', 'subscription_schedule.completed', 'subscription_schedule.canceled', 'subscription_schedule.aborted'];

	static client() {
		if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
		if (process.env.STRIPE_SECRET_KEY.includes('_live_') && process.env.PROVISION_LIVE !== 'true') throw new Error('Set PROVISION_LIVE=true to provision the live Stripe account');
		return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 2, timeout: 15000 });
	}

	static metadata(plan = '') { return { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, ...(plan ? { plan_key: plan } : {}) }; }

	static async validateTax(stripe) {
		const [settings, registrations] = await Promise.all([stripe.tax.settings.retrieve(), stripe.tax.registrations.list({ status: 'active', limit: 100 })]);
		if (settings.status !== 'active' || !registrations.data.length) throw new Error('Stripe Tax requires active settings and at least one active registration before Checkout activation');
	}

	static async product(stripe, plan) {
		const products = await stripe.products.list({ active: true, limit: 100 });
		let product = products.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName && candidate.metadata?.plan_key === plan.key);
		const params = { name: `TypeRelay ${plan.name}`, tax_code: StripeProvisioner.taxCode, metadata: StripeProvisioner.metadata(plan.key) };
		if (!product) product = await stripe.products.create(params);
		else if (product.name !== params.name || product.metadata?.catalog_version !== Billing.catalogVersion) product = await stripe.products.update(product.id, { name: params.name, metadata: params.metadata });
		return product;
	}

	static priceParams(product, plan) {
		const common = { product: product.id, currency: 'usd', recurring: { interval: 'month', usage_type: 'licensed' }, tax_behavior: 'exclusive', metadata: StripeProvisioner.metadata(plan.key) };
		return { ...common, billing_scheme: 'per_unit', unit_amount: plan.price * 100 };
	}

	static validPrice(price, product, plan) {
		return price.product === product.id && price.currency === 'usd' && price.recurring?.interval === 'month' && price.recurring?.interval_count === 1 && price.recurring?.usage_type === 'licensed' && price.tax_behavior === 'exclusive' && price.billing_scheme === 'per_unit' && price.unit_amount === plan.price * 100;
	}

	static async price(stripe, product, plan) {
		const prices = await stripe.prices.list({ product: product.id, active: true, type: 'recurring', limit: 100, expand: ['data.tiers'] });
		const price = prices.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName && (plan.key === 'free' || candidate.metadata?.catalog_version === Billing.catalogVersion) && candidate.metadata?.plan_key === plan.key && StripeProvisioner.validPrice(candidate, product, plan));
		return price || stripe.prices.create(StripeProvisioner.priceParams(product, plan));
	}

	static portalParams() {
		return {
			name: `TypeRelay ${Billing.catalogVersion}`,
			business_profile: { headline: 'TypeRelay is made by Helpmonks LLC' },
			features: { customer_update: { enabled: true, allowed_updates: ['address', 'name', 'phone', 'tax_id'] }, invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } }, subscription_update: { enabled: false } },
			metadata: { ...StripeProvisioner.metadata(), purpose: 'account_management' },
		};
	}

	static async portal(stripe) {
		const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
		const portal = configurations.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName && candidate.metadata?.catalog_version === Billing.catalogVersion && candidate.metadata?.purpose === 'account_management');
		const params = StripeProvisioner.portalParams();
		return portal ? stripe.billingPortal.configurations.update(portal.id, { ...params, active: true }) : stripe.billingPortal.configurations.create(params);
	}

	static async webhook(stripe) {
		const url = 'https://app.typerelay.com/billing/webhook';
		const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
		let endpoint = endpoints.data.find(candidate => candidate.metadata?.catalog === Billing.catalogName || candidate.url === url);
		if (endpoint) endpoint = await stripe.webhookEndpoints.update(endpoint.id, { url, enabled_events: StripeProvisioner.webhookEvents, metadata: StripeProvisioner.metadata(), description: 'TypeRelay subscription billing' });
		else endpoint = await stripe.webhookEndpoints.create({ url, api_version: '2026-08-26.dahlia', enabled_events: StripeProvisioner.webhookEvents, metadata: StripeProvisioner.metadata(), description: 'TypeRelay subscription billing' });
		return endpoint;
	}

	static async run(stripe = StripeProvisioner.client()) {
		await StripeProvisioner.validateTax(stripe);
		const products = [];
		for (const plan of Object.values(Billing.plans)) {
			const product = await StripeProvisioner.product(stripe, plan);
			const price = await StripeProvisioner.price(stripe, product, plan);
			if (product.default_price !== price.id) await stripe.products.update(product.id, { default_price: price.id });
			products.push({ plan, product, price });
		}
		const portal = await StripeProvisioner.portal(stripe);
		const webhook = await StripeProvisioner.webhook(stripe);
		return { products, portal, webhook };
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	StripeProvisioner.run().then(result => {
		for (const entry of result.products) console.log(`STRIPE_${entry.plan.key.toUpperCase()}_PRICE_ID=${entry.price.id}`);
		console.log(`STRIPE_PORTAL_CONFIG_ID=${result.portal.id}`);
		if (result.webhook.secret) console.log(`STRIPE_WEBHOOK_SECRET=${result.webhook.secret}`);
	}).catch(error => { console.error(`TypeRelay Stripe provisioning failed: ${error.message}`); process.exitCode = 1; });
}
