import { test } from 'node:test';
import assert from 'node:assert/strict';

test('insertion recovers a missing page listener once and preserves the target frame', async () => {
	let listener;
	let attempts = 0;
	let injections = 0;
	let failure = 'missing';
	let url = 'https://example.com/editor';
	globalThis.chrome = {
		storage: { local: { get: async () => ({}) }, session: { get: async () => ({ 'frame-7': 3 }) } },
		runtime: { onMessage: { addListener: value => { listener = value; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
		alarms: { onAlarm: { addListener() {} } },
		tabs: {
			query: async () => [{ id: 7, url }],
			onUpdated: { addListener() {} },
			sendMessage: async (tabId, message, target) => {
				assert.equal(tabId, 7);
				assert.deepEqual(message, { type: 'insert', id: 'snippet' });
				assert.deepEqual(target, { frameId: 3 });
				attempts++;
				if (failure === 'missing' && attempts === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
				if (failure === 'closed') throw new Error('The message port closed before a response was received.');
				return failure === 'field' ? { ok: false, error: 'Focus an editable field first' } : { ok: true };
			},
		},
		scripting: { executeScript: async details => { injections++; assert.deepEqual(details, { target: { tabId: 7, frameIds: [3] }, files: ['content.js'] }); } },
	};
	await import('../worker.js?insertion-test');
	const send = () => new Promise(resolve => listener({ type: 'insert', id: 'snippet' }, {}, resolve));
	assert.equal((await send()).ok, true);
	assert.equal(attempts, 2);
	assert.equal(injections, 1);
	failure = 'closed';
	assert.match((await send()).error, /message port closed/);
	assert.equal(attempts, 3);
	assert.equal(injections, 1);
	failure = 'field';
	assert.equal((await send()).error, 'Focus an editable field first');
	url = 'https://docs.google.com/document/d/example/edit';
	assert.match((await send()).error, /Google Docs insertion is not supported yet/);
	assert.equal(attempts, 4);
	assert.equal(injections, 1);
	const ownership = await new Promise(resolve => listener({ type: 'claim' }, { url: 'about:blank', tab: { id: 7, url }, frameId: 3 }, resolve));
	assert.equal(ownership.value.verified, false);
	url = 'chrome://extensions';
	assert.match((await send()).error, /Open a web page/);
	assert.equal(attempts, 4);
	url = 'https://chromewebstore.google.com/';
	failure = 'missing';
	attempts = 0;
	chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents'); };
	assert.match((await send()).error, /Cannot access this page/);
	assert.equal(attempts, 1);
});
