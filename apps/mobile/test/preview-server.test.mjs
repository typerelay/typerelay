import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { PreviewServer } from '../scripts/preview-server.mjs';

class Fixture {
 static async request(body, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method: 'POST', headers: { authorization: 'Bearer example', 'x-preview-client': '12345678-1234-1234-1234-123456789abc', origin: 'https://tr.n.lan', ...headers } });
  const result = {};
  const response = { headersSent: false, writeHead(status) { result.status = status; }, end(value) { result.body = JSON.parse(value); } };
  await PreviewServer.handle(request, response, '/__preview/native'); return result;
 }
}

test('preview enforces authentication, isolates account paths and keeps credentials out of saves', async t => {
 const fetch = globalThis.fetch; const execute = PreviewServer.execute; const env = { ...process.env };
 t.after(() => { globalThis.fetch = fetch; PreviewServer.execute = execute; process.env = env; });
 process.env.MOBILE_PREVIEW_ORIGIN = 'https://tr.n.lan/mobile'; process.env.MOBILE_API_ORIGIN = 'https://tr.n.lan';
 let user = 'one'; const calls = [];
 globalThis.fetch = async () => Response.json({ user, account: 'team', device: 'device' });
 PreviewServer.execute = async (root, request) => { calls.push({ root, request }); return { data: {} }; };
 assert.equal((await Fixture.request({ action: 'state' }, { origin: 'https://evil.test' })).status, 403);
 assert.equal((await Fixture.request({ action: 'state' }, { authorization: '' })).status, 401);
 assert.equal((await Fixture.request({ action: 'execute_arbitrary_command' })).status, 400);
 assert.equal(calls.length, 0);
 const save = { action: 'save', operation_id: 'same-operation', server: 'https://evil.test', access_token: 'wrong-token' };
 await Fixture.request(save); await Fixture.request(save, { authorization: 'Bearer rotated-token' });
 assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].request.access_token, undefined); assert.equal(calls[0].request.server, undefined);
 user = 'two'; await Fixture.request({ action: 'state' }); assert.notEqual(calls[0].root, calls[2].root);
 await Fixture.request({ action: 'sync', server: 'https://evil.test' }); assert.equal(calls[3].request.server, 'http://app:3040'); assert.equal(calls[3].request.access_token, 'example');
 globalThis.fetch = async () => new Response('', { status: 401 });
 assert.equal((await Fixture.request({ action: 'state' })).status, 401); assert.equal(calls.length, 4);
});
