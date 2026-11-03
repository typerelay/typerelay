import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { PreviewServer } from '../scripts/preview-server.mjs';

class Fixture {
 static async request(body, headers = {}, path = '/__preview/native') {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method: 'POST', headers: { authorization: 'Bearer example', 'x-preview-client': '12345678-1234-1234-1234-123456789abc', origin: 'https://tr.n.lan', ...headers } });
  const result = {};
  const response = { headersSent: false, writeHead(status) { result.status = status; }, end(value) { result.body = JSON.parse(value); } };
  await PreviewServer.handle(request, response, path); return result;
 }
}

test('preview enforces authentication, isolates account paths and keeps credentials out of saves', async t => {
 const fetch = globalThis.fetch; const execute = PreviewServer.execute; const env = { ...process.env };
 t.after(() => { globalThis.fetch = fetch; PreviewServer.execute = execute; process.env = env; });
 delete process.env.MOBILE_API_URL; process.env.MOBILE_PREVIEW_ORIGIN = 'https://tr.n.lan/mobile'; process.env.MOBILE_API_ORIGIN = 'https://tr.n.lan';
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
 await Fixture.request({ action: 'sync', server: 'https://evil.test' }); assert.equal(calls[3].request.server, 'http://localhost:3040'); assert.equal(calls[3].request.access_token, 'example');
 const usage = { action: 'keyboard_usage', generation: 'current', library: 'library', id: 'snippet', kind: 'copy', characters: 12 };
 assert.equal((await Fixture.request(usage)).status, 200); assert.deepEqual(calls[4].request, usage); assert.equal(calls[4].root, calls[2].root);
 globalThis.fetch = async () => new Response('', { status: 401 });
 assert.equal((await Fixture.request({ action: 'state' })).status, 401); assert.equal(calls.length, 5);
});

test('development backend DNS, hostname validation and all preview consumers use the same origin', async t => {
 const fetch = globalThis.fetch; const execute = PreviewServer.execute; const env = { ...process.env };
 t.after(() => { globalThis.fetch = fetch; PreviewServer.execute = execute; process.env = env; });
 const compose = readFileSync(new URL('../../../compose.yml', import.meta.url), 'utf8');
 const dbh = readFileSync(new URL('../../../compose.dbh.yml', import.meta.url), 'utf8');
 const backend = compose.match(/^      MOBILE_API_URL: (\S+)$/m)[1];
 const hostname = new URL(backend).hostname;
 assert.equal(new URL(backend).port, '3040');
 for (const config of [compose, dbh]) {
  const app = config.split(/^  app:\n/m)[1].split(/^  \S/m)[0];
  assert.ok(app.includes('    networks:\n      default:\n        aliases:\n          - ' + hostname), 'The app must advertise the preview backend alias on its default network');
 }
 process.env.MOBILE_API_URL = backend; process.env.MOBILE_API_ORIGIN = 'https://tr.n.lan'; process.env.MOBILE_PREVIEW_ORIGIN = 'https://tr.n.lan/mobile'; process.env.WHITE_LABEL_ENABLED = 'true'; process.env.APP_URL = 'https://tr.n.lan';
 const context = { URL, process, Billing: { hosted: () => true }, AccountAccess: { available: {} }, Account: { findOne: () => ({ lean: async () => null }) } };
 vm.createContext(context);
 vm.runInContext(readFileSync(new URL('../../server/services/white_label.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export class WhiteLabel', 'globalThis.WhiteLabel = class WhiteLabel'), context);
 const { WhiteLabel } = context;
 assert.equal(WhiteLabel.platformHostname('app'), false);
 delete process.env.MOBILE_API_URL; assert.equal(WhiteLabel.platformHostname(new URL(PreviewServer.backend()).hostname), true); process.env.MOBILE_API_URL = backend;
 const targets = []; const native = [];
 globalThis.fetch = async (url, options) => {
  const target = new URL(url); let accepted = false; let status;
  await WhiteLabel.resolveRequest({ headers: { host: target.host } }, { locals: {}, status(value) { status = value; return this; }, send() {} }, error => { assert.ifError(error); accepted = true; });
  assert.equal(accepted, true, 'Backend hostname was rejected: ' + url); assert.equal(status, undefined);
  targets.push({ url, options });
  return target.pathname === '/oauth/token' ? Response.json({ error: 'Unsupported grant' }, { status: 400 }) : Response.json({ user: 'user', account: 'team' });
 };
 PreviewServer.execute = async (root, request) => { native.push(request); return { data: {} }; };
 const token = await Fixture.request({}, {}, '/__preview/api/oauth/token'); assert.equal(token.status, 400); assert.equal(token.body.error, 'Unsupported grant');
 for (const action of ['sync', 'asset_fetch']) {
  assert.equal((await Fixture.request({ action, server: 'https://evil.test', access_token: 'wrong' })).status, 200);
  assert.equal(native.at(-1).server, backend); assert.equal(native.at(-1).access_token, 'example');
 }
 assert.deepEqual(targets.map(call => call.url), [backend + '/oauth/token', backend + '/api/v2/mobile-preview/identity', backend + '/api/v2/mobile-preview/identity']);
 assert.equal(targets[0].options.body, '{}');
 assert.equal(targets[1].options.headers.Authorization, 'Bearer example');
 let rejected;
 await WhiteLabel.resolveRequest({ headers: { host: 'unconfigured.example.com' } }, { locals: {}, status(value) { rejected = value; return this; }, send() {} }, () => assert.fail('Unverified custom domain was accepted'));
 assert.equal(rejected, 404);
});
