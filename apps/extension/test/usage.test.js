import test from 'node:test';
import assert from 'node:assert/strict';
import { Usage } from '../usage.js';

test('offline usage survives retry and stays bound to the originating identity', async () => {
	const identity = { server: 'https://example.test', account: 'one', user: 'owner' }; const state = { statisticsIdentity: identity }; let online = false; const sent = [];
	globalThis.chrome = { storage: { local: { async get(key) { return key === null ? { ...state } : { [key]: state[key] }; }, async set(values) { Object.assign(state, values); }, async remove(keys) { for (const key of keys) delete state[key]; } } } };
	try {
		const usage = new Usage(async request => { if (!online) throw new Error('offline'); const body = JSON.parse(request.options.body); sent.push(body); return { async json() { return { accepted: body.events.map(event => event.event_id), discarded: [] }; } }; }, () => identity.server);
		const event = { event_id: 'one-event', identity, library: 'library', characters: 10 };
		await usage.record(event); await usage.flush().catch(() => undefined); assert(state['usage-one-event']);
		state.statisticsIdentity = { ...identity, user: 'another' }; online = true; await usage.flush(); assert.equal(sent.length, 0); assert(state['usage-one-event']);
		state.statisticsIdentity = identity; await usage.flush(); assert.equal(sent.length, 1); assert.equal(sent[0].identity.user, 'owner'); assert.equal(state['usage-one-event'], undefined);
		await usage.flush(); assert.equal(sent.length, 1);
	} finally { delete globalThis.chrome; }
});

test('identity retention deletes only usage from other identities', async () => {
 const identity={server:'https://example.test',account:'one',user:'owner'};
 const state={'usage-old':{identity:{...identity,account:'two'}},'usage-current':{identity},tokens:{access_token:'secret'}};
 globalThis.chrome={storage:{local:{get:async()=>({...state}),remove:async keys=>{for(const key of keys)delete state[key];}}}};
 try { const usage=new Usage(()=>{},()=>identity.server);await usage.retain(identity);assert.equal(state['usage-old'],undefined);assert(state['usage-current']);await usage.retain(null);assert.equal(state['usage-current'],undefined);assert(state.tokens); }
 finally {delete globalThis.chrome;}
});
