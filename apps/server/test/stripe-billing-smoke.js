import Stripe from 'stripe';
import assert from 'node:assert/strict';
import { Billing } from '../services/billing.js';
import { StripeProvisioner } from '../scripts/provision-stripe.js';
if (!process.env.STRIPE_SECRET_KEY?.includes('_test_')) throw new Error('Test-mode Stripe key required');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia' });
let customer, product, subscription;
const prices = [];
const configurations = [];
try {
	product = await stripe.products.create({ name: 'TypeRelay temporary portal verification', metadata: { purpose: 'billing-test' } });
	for (const unit_amount of [800, 400]) prices.push(await stripe.prices.create({ product: product.id, unit_amount, currency: 'usd', recurring: { interval: 'month' }, metadata: { catalog: Billing.catalogName, catalog_version: Billing.catalogVersion, plan_key: 'pro' } }));
	process.env.STRIPE_PRO_PRICE_ID = prices[1].id;
	customer = await stripe.customers.create({ name: 'TypeRelay temporary portal verification' });
	subscription = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: prices[0].id, quantity: 1 }], trial_period_days: 7 });
	const management = await stripe.billingPortal.configurations.create(StripeProvisioner.portalParams());
	configurations.push(management.id);
	assert.equal(management.features.subscription_update.enabled, false);
	const general = await stripe.billingPortal.sessions.create({ customer: customer.id, configuration: management.id, return_url: 'https://tr.n.lan' });
	assert.ok(general.url);
	const configuration = await Billing.changePortalConfiguration(stripe, 'pro', 2);
	configurations.push(configuration);
	assert.equal(await Billing.changePortalConfiguration(stripe, 'pro', 2), configuration);
	const params = { customer: customer.id, configuration, return_url: 'https://tr.n.lan', flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscription.id, items: [{ id: subscription.items.data[0].id, price: prices[1].id, quantity: 2 }] }, after_completion: { type: 'redirect', redirect: { return_url: 'https://tr.n.lan' } } } };
	const session = await stripe.billingPortal.sessions.create(params);
	assert.ok(session.url);
	params.flow_data.subscription_update_confirm.items[0].quantity = 6;
	await assert.rejects(stripe.billingPortal.sessions.create(params));
	const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
	await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'release', phases: [{ items: [{ price: prices[0].id, quantity: 1 }], start_date: schedule.current_phase.start_date, end_date: subscription.items.data[0].current_period_end, trial_end: subscription.trial_end }, { items: [{ price: prices[1].id, quantity: 1 }], duration: { interval: 'month', interval_count: 1 } }] });
	await stripe.subscriptionSchedules.release(schedule.id);
	console.log(JSON.stringify({ managementPortal: true, confirmationPortal: true, proSeatCapEnforced: true, configurationReused: true, renewalSchedule: true }));

} finally {
	if (subscription) await stripe.subscriptions.cancel(subscription.id);
	if (customer) await stripe.customers.del(customer.id);
	for (const id of configurations) await stripe.billingPortal.configurations.update(id, { active: false });
	for (const price of prices) await stripe.prices.update(price.id, { active: false });
	if (product) await stripe.products.update(product.id, { active: false });
}
