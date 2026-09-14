import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../services/scheduler.js';

class FakeCron {
	static instances = [];
	constructor(pattern, options, callback) {
		this.pattern = pattern;
		this.options = options;
		this.callback = callback;
		FakeCron.instances.push(this);
	}
}

test('scheduler registers one protected daily Trash cleanup without overlap', async () => {
	FakeCron.instances = [];
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let calls = 0;
	const logs = [];
	Scheduler.start({ CronClass: FakeCron, cleanup: async () => { calls++; await gate; return { libraries: 2, snippets: 3 }; }, logger: { log: message => logs.push(message), error: message => logs.push(message) } });
	assert.equal(FakeCron.instances.length, 1);
	const job = FakeCron.instances[0];
	assert.equal(job.pattern, '30 2 * * *');
	assert.equal(job.options.protect, true);
	const first = job.callback();
	const overlapping = job.callback();
	await Promise.resolve();
	assert.equal(calls, 1);
	release();
	await Promise.all([first, overlapping]);
	assert.deepEqual(logs, ['Trash cleanup complete: purged 2 libraries and 3 snippets']);
});

test('scheduler logs cleanup failure and permits the next run', async () => {
	FakeCron.instances = [];
	let calls = 0;
	const logs = [];
	Scheduler.start({ CronClass: FakeCron, cleanup: async () => { calls++; if (calls === 1) throw new Error('database unavailable'); return { libraries: 0, snippets: 1 }; }, logger: { log: message => logs.push(message), error: message => logs.push(message) } });
	const job = FakeCron.instances[0];
	await job.callback();
	await job.callback();
	assert.equal(calls, 2);
	assert.deepEqual(logs, ['Trash cleanup failed: database unavailable', 'Trash cleanup complete: purged 0 libraries and 1 snippets']);
});
