import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TrialCountdown } from '../public/trial-countdown.js';

test('trial countdown changes on local calendar boundaries including DST', () => {
	const startedAt = new Date(2026, 2, 7, 23, 30);
	assert.equal(TrialCountdown.text(startedAt, new Date(2026, 2, 7, 23, 59), 7), 'Trial ends in 7 days');
	assert.equal(TrialCountdown.text(startedAt, new Date(2026, 2, 8, 0, 5), 7), 'Trial ends in 6 days');
	assert.equal(TrialCountdown.text(startedAt, new Date(2026, 2, 13, 12), 7), 'Trial ends in 1 day');
	assert.equal(TrialCountdown.text(startedAt, new Date(2026, 2, 14, 0), 7), 'Trial ends today');
});

test('trial countdown refreshes billing at the exact expiry time', async () => {
	const dom = new JSDOM('<button data-trial-countdown data-trial-started-at="2026-09-17T15:00:00.000Z" data-trial-ends-at="2026-09-24T15:00:00.000Z" data-trial-days="7">Trial</button>');
	const previousDocument = globalThis.document;
	globalThis.document = dom.window.document;
	let refreshes = 0;
	const countdown = new TrialCountdown({ refreshBilling: async () => { refreshes++; }, toast: () => assert.fail('Unexpected error') });
	try {
		countdown.refresh(new Date('2026-09-24T15:00:00.000Z'));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(refreshes, 1);
		assert.equal(countdown.timer, null);
	} finally {
		countdown.stop();
		globalThis.document = previousDocument;
		dom.window.close();
	}
});
