import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { mongoose, Account, Member, User, Device, Ticket, Library } from '../model/index.js';
import { Support } from '../services/support.js';
import { Auth } from '../services/auth.js';
import { Libraries } from '../services/libraries.js';

class Fixture {
	static root; static server; static actor; static account; static cookie; static csrf; static one; static two;
	static origin = 'http://127.0.0.1:3140';
	static async request(path, method = 'GET', body) {
		const response = await fetch(Fixture.origin + path, { method, redirect: 'manual', headers: { Cookie: Fixture.cookie || '', 'Content-Type': 'application/json', 'X-CSRF-Token': Fixture.csrf || '', 'X-Account-Id': Fixture.account || '' }, body: body ? JSON.stringify({ operation_id: randomUUID(), ...body }) : undefined });
		if (response.headers.get('set-cookie')) Fixture.cookie = response.headers.get('set-cookie').split(';')[0];
		return response;
	}
	static async json(path, method, body) { const response = await Fixture.request('/api/v1/' + path, method, body); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; }
	static async device(name, user = Fixture.actor.user, account = Fixture.account) {
		const root = join(Fixture.root, name);
		await mkdir(join(root, 'typerelay/snippets'), { recursive: true });
		await mkdir(join(root, 'typerelay/sync'), { recursive: true });
		const access = Support.token(); const refresh = Support.token();
		const device = await Device.create({ account, user, name, access: Support.hash(access), access_expires: new Date(Date.now() + 900000), refresh: Support.hash(refresh), refresh_expires: new Date(Date.now() + 86400000) });
		await writeFile(join(root, 'typerelay/sync/credentials.json'), JSON.stringify({ server: Fixture.origin, access_token: access, refresh_token: refresh }), { mode: 0o600 });
		return { root, device, config: join(root, 'typerelay'), snippets: join(root, 'typerelay/snippets') };
	}
	static async cli(device, ...args) { return promisify(execFile)('/usr/local/bin/typerelay', args, { env: { ...process.env, XDG_CONFIG_HOME: device.root }, timeout: 30000 }); }
	static async state(device) { return JSON.parse(await readFile(join(device.config, 'sync/state.json'), 'utf8')); }
}
before(async () => {
	process.env.NODE_ENV = 'test';
	process.env.PORT = '3140';
	process.env.MONGODB_URI = process.env.MONGODB_URI.replace('/typerelay?', '/typerelay_e2e?');
	Fixture.root = await mkdtemp(join(tmpdir(), 'typerelay-e2e-'));
	process.env.SESSION_SECRET_FILE = join(Fixture.root, 'session');
	const { Server } = await import('../app.js');
	Fixture.server = await Server.start();
	const user = await User.create({ email: randomUUID() + '@example.test', name: 'Test owner' });
	const account = await Account.create({ name: 'Test team' });
	await Member.create({ user: user._id, account: account._id, role: 'owner' });
	Fixture.account = String(account._id);
	Fixture.actor = await Support.context(String(user._id), Fixture.account);
	const token = Support.token();
	await Ticket.create({ hash: Support.hash(token), kind: 'login', email: user.email, expires: new Date(Date.now() + 60000) });
	await Fixture.request('/auth/callback?token=' + token);
	const html = await (await Fixture.request('/')).text();
	const dom = new JSDOM(html);
	Fixture.csrf = dom.window.document.querySelector('meta[name=csrf-token]').content;
	dom.window.close();
	Fixture.one = await Fixture.device('one');
	Fixture.two = await Fixture.device('two');
});
after(async () => {
	await new Promise(resolve => Fixture.server.close(resolve));
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
	await rm(Fixture.root, { recursive: true, force: true });
});
test('actual desktop browser PKCE flow writes private credentials and settings', async () => {
	const root = join(Fixture.root, 'browser-connect');
	const child = spawn('/usr/local/bin/typerelay', ['connect', '--server', Fixture.origin, '--no-browser'], { env: { ...process.env, XDG_CONFIG_HOME: root } });
	const completed = new Promise((resolve, reject) => { child.on('exit', code => code === 0 ? resolve() : reject(new Error('CLI failed ' + code))); child.on('error', reject); });
	try {
		const authorize = await new Promise((resolve, reject) => {
			let output = '';
			const timer = setTimeout(() => reject(new Error('CLI did not print authorization URL')), 5000);
			child.stdout.on('data', data => { output += data; const match = output.match(/http[^\s]+oauth\/authorize[^\s]+/); if (match) { clearTimeout(timer); resolve(new URL(match[0])); } });
			child.on('exit', code => { if (code) { clearTimeout(timer); reject(new Error('CLI exited ' + code)); } });
		});
		const approval = await Fixture.request('/oauth/authorize', 'POST', { ...Object.fromEntries(authorize.searchParams), account: Fixture.account });
		assert.equal(approval.status, 302);
		const callback = await fetch(approval.headers.get('location'));
		assert.equal(callback.status, 200);
		await completed;
		const credentialsPath = join(root, 'typerelay/sync/credentials.json');
		const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
		assert.equal((await Auth.bearer(credentials.access_token)).account, Fixture.account);
		assert.ok((await readFile(join(root, 'typerelay/settings.yml'), 'utf8')).includes(Fixture.origin));
	} finally { child.kill(); await completed.catch(() => {}); }
});
test('desktop two-way sync, offline edits, recovery, missing files, activation collisions', async () => {
	const yaml = '# personal\nmatches:\n- trigger: alpha\n  replace: First\n- trigger: beta\n  replace: Second\n';
	await writeFile(join(Fixture.one.snippets, 'mine.yml'), yaml);
	await writeFile(join(Fixture.one.snippets, 'local-only.yml'), 'matches: [{trigger: local, replace: Only here}]\n');
	await Fixture.cli(Fixture.one, 'enroll', 'mine.yml');
	await Fixture.cli(Fixture.two, 'sync');
	const state = await Fixture.state(Fixture.one);
	const id = Object.keys(state.files)[0];
	const other = join(Fixture.two.snippets, 'library-' + id + '.yml');
	assert.equal(await readFile(other, 'utf8'), yaml);
	assert.equal((await readdir(Fixture.two.snippets)).filter(name => name.endsWith('.yml')).length, 1);
	await writeFile(join(Fixture.one.snippets, 'mine.yml'), yaml.replace('First', 'Device one'));
	await writeFile(other, yaml.replace('Second', 'Device two'));
	await Fixture.cli(Fixture.one, 'sync');
	await Fixture.cli(Fixture.two, 'sync');
	await Fixture.cli(Fixture.one, 'sync');
	const merged = await readFile(other, 'utf8');
	assert.ok(merged.includes('Device one') && merged.includes('Device two') && merged.includes('# personal'));
	// Same-snippet conflict preserves both and keeps local draft outside active files.
	await writeFile(join(Fixture.one.snippets, 'mine.yml'), merged.replace('Device one', 'Winner'));
	await writeFile(other, merged.replace('Device one', 'Conflicting draft'));
	await Fixture.cli(Fixture.one, 'sync');
	await Fixture.cli(Fixture.two, 'sync');
	assert.equal((await Fixture.state(Fixture.two)).conflicts.length, 1);
	const recoveries = await readdir(join(Fixture.two.config, 'sync/recovery'));
	assert.ok((await Promise.all(recoveries.map(name => readFile(join(Fixture.two.config, 'sync/recovery', name), 'utf8')))).some(content => content.includes('Conflicting draft')));
	assert.ok((await readFile(other, 'utf8')).includes('Winner'));
	await rm(other);
	await Fixture.cli(Fixture.two, 'sync');
	assert.ok((await readFile(other, 'utf8')).includes('Winner'));
	// A downloaded collision is staged, leaving the existing working file unchanged.
	await writeFile(join(Fixture.two.snippets, 'local.yml'), 'matches: [{trigger: collision, replace: Local}]\n');
	const created = await Fixture.json('libraries', 'POST', { name: 'Collision', yaml: 'matches: [{trigger: collision, replace: Remote}]\n' });
	await assert.rejects(Fixture.cli(Fixture.two, 'sync'), /Duplicate trigger/);
	assert.equal(await readFile(join(Fixture.two.snippets, 'local.yml'), 'utf8'), 'matches: [{trigger: collision, replace: Local}]\n');
	assert.ok((await readdir(join(Fixture.two.config, 'sync/staged'))).includes(created.library._id + '.json'));
	await rm(join(Fixture.two.snippets, 'local.yml'));
	await Fixture.cli(Fixture.two, 'sync');
});
test('offline enrollment queues durably and a lost-response retry cannot duplicate libraries', async () => {
	const device = await Fixture.device('offline');
	const credentialsPath = join(device.config, 'sync/credentials.json');
	const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
	await writeFile(join(device.snippets, 'offline.yml'), 'matches: [{trigger: offline, replace: Queued}]\n');
	await writeFile(credentialsPath, JSON.stringify({ ...credentials, server: 'http://127.0.0.1:1' }));
	await assert.rejects(Fixture.cli(device, 'enroll', 'offline.yml'));
	const pending = (await Fixture.state(device)).pending;
	assert.ok(pending.body.operation_id);
	await writeFile(credentialsPath, JSON.stringify(credentials));
	await Fixture.cli(device, 'sync');
	const state = await Fixture.state(device);
	const id = Object.entries(state.files).find(([, file]) => file.filename === 'offline.yml')[0];
	state.pending = pending;
	await writeFile(join(device.config, 'sync/state.json'), JSON.stringify(state));
	await Fixture.cli(device, 'sync');
	assert.equal(await Library.countDocuments({ account: Fixture.account, name: 'offline.yml' }), 1);
	assert.equal((await Fixture.state(device)).files[id].filename, 'offline.yml');
});
test('read-only manual edits never reach server; revoked files leave active directory', async () => {
	const user = await User.create({ email: randomUUID() + '@example.test', name: 'Member' });
	await Member.create({ account: Fixture.account, user: user._id, role: 'member' });
	const device = await Fixture.device('member', String(user._id));
	let { library } = await Fixture.json('libraries', 'POST', { name: 'Read only', yaml: 'matches: [{trigger: team, replace: Authorized}]\n' });
	({ library } = await Fixture.json('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: library.name, shared: true, editable: false, members: [String(user._id)], groups: [] }));
	await Fixture.cli(device, 'sync');
	const path = join(device.snippets, 'library-' + library._id + '.yml');
	await writeFile(path, 'matches: [{trigger: team, replace: Unauthorized}]\n');
	await Fixture.cli(device, 'sync');
	assert.ok((await readFile(path, 'utf8')).includes('Authorized'));
	assert.ok((await readdir(join(device.config, 'sync/recovery'))).length > 0);
	assert.ok((await Library.findById(library._id).lean()).yaml.includes('Authorized'));
	await writeFile(path, 'matches: [{trigger: team, replace: Unsent}]\n');
	await Fixture.json('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: library.name, shared: false, editable: false, members: [], groups: [] });
	await Fixture.cli(device, 'sync');
	assert.ok(!(await readdir(device.snippets)).some(name => name.endsWith('.yml')));
});
test('web AJAX updates only affected snippets; preserves panel, filter and multiline', async () => {
	const { library } = await Fixture.json('libraries', 'POST', { name: 'Browser library', yaml: 'matches: [{trigger: web, replace: Before}, {trigger: untouched, replace: Keep}]\n' });
	const html = await (await Fixture.request('/')).text();
	const dom = new JSDOM(html, { url: Fixture.origin, runScripts: 'outside-only' });
	const errors = [];
	dom.window.Swal = { fire: async value => { if (value.icon === 'error') errors.push(value.title); return { isConfirmed: true }; } };
	dom.window.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() {}, hide() {} }), getInstance: () => ({ hide() {} }) } };
	dom.window.fetch = async (path, options = {}) => {
		const response = await fetch(new URL(path, Fixture.origin), { ...options, headers: { ...options.headers, Cookie: Fixture.cookie } });
		return response;
	};
	const source = (await readFile('./public/app.js', 'utf8')).replace('new TypeRelay();', 'window.client = new TypeRelay();');
	dom.window.eval(source);
	const client = dom.window.client;
	await client.open(library._id);
	const panel = dom.window.document.querySelector('#editor');
	const untouched = dom.window.document.querySelector('[data-snippet="' + library.snippets[1].id + '"]');
	const search = dom.window.document.querySelector('#search');
	search.value = 'Browser';
	search.focus();
	await client.snippet(library.snippets[0].id, { trigger: 'web', replace: 'First\nSecond\n\n' });
	assert.equal(dom.window.document.querySelector('#editor'), panel);
	assert.equal(dom.window.document.querySelector('[data-snippet="' + library.snippets[1].id + '"]'), untouched);
	assert.equal(search.value, 'Browser');
	assert.equal(dom.window.document.activeElement, search);
	assert.equal(dom.window.document.querySelector('[data-snippet="' + library.snippets[0].id + '"] pre').textContent, 'First\nSecond\n\n');
	assert.deepEqual(errors, []);
	await client.form('library', { library: library._id }, () => {});
	assert.ok(dom.window.document.querySelector('#shared'));
	dom.window.close();
});
test('CSRF rejects writes, logout invalidates session', async () => {
	const response = await fetch(Fixture.origin + '/api/v1/libraries', { method: 'POST', headers: { Cookie: Fixture.cookie, 'Content-Type': 'application/json', 'X-Account-Id': Fixture.account }, body: JSON.stringify({ name: 'Blocked' }) });
	assert.equal(response.status, 403);
	assert.equal((await Fixture.request('/auth/logout', 'POST', {})).status, 200);
	assert.equal((await Fixture.request('/api/v1/libraries')).status, 403);
});
