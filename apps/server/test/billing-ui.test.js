import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pug from 'pug';
import { JSDOM } from 'jsdom';
import { Billing } from '../services/billing.js';

class Fixture {
	static async open(plan = 'free', quantity = 1) {
		const entitlements = { ...Billing.plans[plan], plan, billing_enabled: true };
		const account = { plan, billing: { status: 'active', seat_quantity: quantity } };
		const locals = { account, usage: { people: 1, invitations: 0, libraries: 1, snippets: 2, machines: 1 }, entitlements, seatCapacity: quantity, plan, billingStatus: 'active', isTrialing: false, trialAvailable: true, canManageBilling: true, billingEnabled: true, plans: Billing.plans };
		const dom = new JSDOM(pug.renderFile('./views/ajax/subscription.pug', locals), { runScripts: 'outside-only', url: 'https://tr.n.lan' });
		const source = (await readFile('./public/app.js', 'utf8')).replace(/^import .*;$/gm, '').replace('const client = new TypeRelay();', '').replace('export { client };', 'window.TypeRelay = TypeRelay;');
		dom.window.eval(source);
		const client = Object.create(dom.window.TypeRelay.prototype);
		const calls = [];
		client.request = async (...args) => { calls.push(args); return { scheduled_change: { plan, seat_quantity: quantity } }; };
		client.applyBilling = () => {};
		client.toast = () => {};
		return { dom, client, calls, document: dom.window.document };
	}
}

test('checkout forms expose per-user prices and Pro/Team seat ranges', async () => {
	const { dom, document } = await Fixture.open();
	try {
		assert.match(document.body.textContent, /Pro — \$4\/user\/month/);
		assert.match(document.body.textContent, /Team — \$8\/user\/month/);
		assert.equal(document.querySelector('#checkout-pro-seats').min, '1');
		assert.equal(document.querySelector('#checkout-pro-seats').max, '5');
		assert.equal(document.querySelector('#checkout-team-seats').min, '1');
		assert.equal(document.querySelector('#checkout-team-seats').value, '1');
		assert.doesNotMatch(document.body.textContent, /\$39|\$6\/month|5 people included/);
	} finally { dom.window.close(); }
});

test('both checkout and existing-plan changes send selected Pro/Team quantities', async () => {
	for (const [plan, selector, target, seats, endpoint] of [['free', '#checkout-pro-form', 'pro', 5, 'billing/checkout'], ['free', '#checkout-team-form', 'team', 1, 'billing/checkout'], ['pro', '#subscription-seats-form', 'pro', 3, 'billing/change'], ['team', '#change-plan-form', 'pro', 4, 'billing/change']]) {
		const { dom, client, calls, document } = await Fixture.open(plan, 2);
		try {
			const form = document.querySelector(selector);
			form.elements.seats.value = String(seats);
			const submitter = form.querySelector('[type="submit"]');
			await client.onSubmit({ target: form, submitter, preventDefault() {} });
			assert.equal(calls.length, 1);
			assert.equal(calls[0][0], endpoint);
			assert.equal(calls[0][2].plan, target);
			assert.equal(calls[0][2].seats, seats);
			assert.equal(submitter.disabled, false);
		} finally { dom.window.close(); }
	}
});

test('starting Pro access updates collaboration controls without replacing members or report filters', async () => {
	const { dom, client, document } = await Fixture.open();
	try {
		const locals = { ctx: { role: 'owner', entitlements: { capabilities: { team: false } } }, team: { groups: [], members: [] } };
		locals.member = { _id: 'retained-member', user: 'another-user', role: 'member', profile: { name: 'Retained member', email: 'retained@example.test' } };
		const render = name => pug.renderFile(`./views/ajax/${name}.pug`, locals);
		document.body.insertAdjacentHTML('beforeend', `<section id="settings-pane-team">${render('team-plan-notice')}<div id="team-controls">${render('team-add')}<div id="team-members-column"><input id="member-filter" value="kept"></div></div><div id="team-groups-row">${render('team-groups')}</div></section><div>${render('statistics-scope')}<input id="report-filter" value="30"></div>`);
		const memberFilter = document.querySelector('#member-filter');
		const reportFilter = document.querySelector('#report-filter');
		document.querySelector('#team-members-column').insertAdjacentHTML('beforeend', render('member'));
		const memberRow = document.querySelector('[data-member="retained-member"]');
		const memberName = memberRow.querySelector('strong');
		assert.equal(memberRow.querySelector('[data-role]'), null);
		locals.ctx.entitlements.capabilities.team = true;
		delete client.applyBilling;
		client.trialCountdown = { refresh() {} };
		let initialized = false;
		client.rotateTeamPassword = () => { initialized = true; };
		const result = () => ({ entitlements: locals.ctx.entitlements, team_notice_html: render('team-plan-notice'), team_add_html: render('team-add'), team_groups_html: render('team-groups'), statistics_scope_html: render('statistics-scope'), member_actions: [{ id: locals.member._id, html: render('member-actions') }] });
		client.applyBilling(result());
		assert.ok(document.querySelector('#team-member-form'));
		assert.ok(document.querySelector('#new-group'));
		assert.ok(document.querySelector('#statistics-scope option[value="team"]'));
		assert.equal(initialized, true);
		assert.equal(document.querySelector('#member-filter'), memberFilter);
		assert.equal(document.querySelector('#report-filter'), reportFilter);
		assert.equal(document.querySelector('[data-member="retained-member"]'), memberRow);
		assert.equal(memberRow.querySelector('strong'), memberName);
		assert.equal(memberRow.querySelector('[data-role]').textContent, 'Make admin');
		locals.ctx.entitlements.capabilities.team = false;
		client.applyBilling(result());
		assert.equal(memberRow.querySelector('[data-role]'), null);
		assert.ok(memberRow.querySelector('[data-remove-member]'));
	} finally { dom.window.close(); }
});
