import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Assets } from '../services/assets.js';

test('remote image connections use only validated addresses and retain the original host', async t => {
	const lookups = [];
	t.mock.method(Assets, 'publicHost', async url => { lookups.push(url.href); return ['8.8.8.8']; });
	t.mock.method(Assets, 'put', async (ctx, bytes) => bytes.toString());
	let calls = 0;
	t.mock.method(http, 'get', (url, options, callback) => {
		assert.equal(url.hostname, 'image.example.test');
		assert.equal(options.agent, false);
		options.lookup(url.hostname, { all: true }, (error, addresses) => assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]));
		options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
		const response = Readable.from([Buffer.from('image')]);
		response.statusCode = calls++ ? 200 : 302;
		response.headers = response.statusCode === 302 ? { location: '/next' } : {};
		queueMicrotask(() => callback(response));
		return new EventEmitter();
	});
	assert.equal(await Assets.remote({}, 'http://image.example.test/start'), 'image');
	assert.deepEqual(lookups, ['http://image.example.test/start', 'http://image.example.test/next']);
});

test('redirects to private hosts are rejected before connecting and oversized bodies are destroyed', async t => {
	let calls = 0; let response;
	t.mock.method(Assets, 'publicHost', async url => { if (url.hostname === '127.0.0.1') throw new Error('Remote image host is not public'); return ['8.8.8.8']; });
	t.mock.method(http, 'get', (url, options, callback) => {
		calls++;
		response = Readable.from([Buffer.alloc(Assets.maximumInput + 1)]);
		response.statusCode = calls === 1 ? 302 : 200;
		response.headers = calls === 1 ? { location: 'http://127.0.0.1/private' } : {};
		queueMicrotask(() => callback(response));
		return new EventEmitter();
	});
	await assert.rejects(Assets.remote({}, 'http://image.example.test/start'), /not public/);
	assert.equal(calls, 1); assert.equal(response.destroyed, true);
	await assert.rejects(Assets.remote({}, 'http://image.example.test/large'), /exceeds 5 MiB/);
	assert.equal(response.destroyed, true);
});
