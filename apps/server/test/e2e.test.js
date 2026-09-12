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
	static async json(path, method, body) { const response = await Fixture.request('/api/v2/' + path, method, body); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; }
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
	static async state(device) { return JSON.parse((await Fixture.cli(device, 'inspect')).stdout); }
	static async edit(device, name, trigger, text) { return Fixture.cli(device, 'database-edit', name, trigger, ...(text === null ? ['--trash'] : ['--text', text])); }
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
		const page = await Fixture.request(authorize.pathname + authorize.search);
		assert.ok(page.headers.get('content-security-policy').includes("form-action 'self' " + new URL(authorize.searchParams.get('redirect_uri')).origin + ';'));
		const dom = new JSDOM(await page.text(), { url: authorize.href, runScripts: 'outside-only' });
		dom.window.eval((await readFile('./public/app.js', 'utf8')).replace('export { client };', ''));
		const form = dom.window.document.querySelector('form[action="/oauth/authorize"]');
		form.elements.account.value = Fixture.account;
		const submit = new dom.window.Event('submit', { bubbles: true, cancelable: true });
		assert.equal(form.dispatchEvent(submit), true, 'Shared JavaScript must not cancel the native OAuth form');
		assert.equal(submit.defaultPrevented, false);
		const fields = Object.fromEntries(new dom.window.FormData(form));
		dom.window.close();
		const approval = await Fixture.request('/oauth/authorize', 'POST', fields);
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
test('SQLite two-device edits, conflict recovery and generated YAML isolation', async () => {
	const yaml = '# original comments\nmatches:\n- trigger: alpha\n  replace: First\n- trigger: beta\n  replace: Second\n';
	await writeFile(join(Fixture.one.snippets, 'mine.yml'), yaml);
	await writeFile(join(Fixture.one.snippets, 'local-only.yml'), 'matches: [{trigger: local, replace: Only here}]\n');
	await Fixture.cli(Fixture.one, 'enroll', 'mine.yml');
	await Fixture.cli(Fixture.one, 'sync');
	await Fixture.cli(Fixture.two, 'sync');
	let one = await Fixture.state(Fixture.one);
	let two = await Fixture.state(Fixture.two);
	const library = one.libraries.find(row => row.name === 'mine.yml');
	assert.equal(two.libraries.filter(row => row.state === 'active').length, 1);
	assert.ok(!two.libraries.some(row => row.name === 'local-only.yml'));
	await Fixture.edit(Fixture.one, 'mine.yml', 'alpha', 'Device one');
	await Fixture.edit(Fixture.two, 'mine.yml', 'beta', 'Device two');
	await Fixture.cli(Fixture.one, 'sync');
	await Fixture.cli(Fixture.two, 'sync');
	await Fixture.cli(Fixture.one, 'sync');
	two = await Fixture.state(Fixture.two);
	assert.deepEqual(two.libraries.find(row => row._id === library._id).records.filter(row => row.state === 'active').map(row => row.content.text), ['Device one', 'Device two']);
	await Fixture.edit(Fixture.one, 'mine.yml', 'alpha', 'Winner');
	await Fixture.edit(Fixture.two, 'mine.yml', 'alpha', 'Conflicting draft');
	await Fixture.cli(Fixture.one, 'sync');
	await Fixture.cli(Fixture.two, 'sync');
	two = await Fixture.state(Fixture.two);
	assert.equal(two.conflicts.length, 1);
	assert.ok(two.recovery > 0);
	assert.equal(two.libraries.find(row => row._id === library._id).records.find(row => row.trigger === 'alpha').content.text, 'Winner');
	const exportPath = join(Fixture.two.snippets, 'export.yml');
	await Fixture.cli(Fixture.two, 'export', 'mine.yml', exportPath);
	assert.ok((await readFile(exportPath, 'utf8')).startsWith('# Generated by TypeRelay.'));
	await writeFile(exportPath, 'matches: [{trigger: alpha, replace: Tampered}]');
	await Fixture.cli(Fixture.two, 'sync');
	assert.equal((await Fixture.state(Fixture.two)).libraries.find(row => row._id === library._id).records.find(row => row.trigger === 'alpha').content.text, 'Winner');
	// Remote collision is staged and does not replace the last working local snapshot.
	const source = join(Fixture.two.root, 'collision.yml');
	await writeFile(source, 'matches: [{trigger: collision, replace: Local}]');
	await Fixture.cli(Fixture.two, 'import', source, '--name', 'Local collision');
	await Fixture.json('libraries', 'POST', { name: 'Remote collision', snippets: [{ trigger: 'collision', content: { version: 1, type: 'plain_text', text: 'Remote' } }] });
	await assert.rejects(Fixture.cli(Fixture.two, 'sync'), /[Dd]uplicate/);
	two = await Fixture.state(Fixture.two);
	assert.ok(two.staged);
	assert.ok(!two.libraries.some(row => row.name === 'Remote collision'));
	await Fixture.edit(Fixture.two, 'Local collision', 'collision', null);
	await Fixture.cli(Fixture.two, 'sync');
	assert.ok((await Fixture.state(Fixture.two)).libraries.some(row => row.name === 'Remote collision'));
});
test('offline SQLite outbox and lost-response replay create a library only once', async () => {
	const device = await Fixture.device('offline');
	const credentialsPath = join(device.config, 'sync/credentials.json');
	const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
	await writeFile(join(device.snippets, 'offline.yml'), 'matches: [{trigger: offline, replace: Queued}]\n');
	await writeFile(credentialsPath, JSON.stringify({ ...credentials, server: 'http://127.0.0.1:1' }));
	await Fixture.cli(device, 'enroll', 'offline.yml');
	await assert.rejects(Fixture.cli(device, 'sync'));
	const pending = (await Fixture.state(device)).pending[0][1];
	assert.ok(pending.body.operation_id);
	await writeFile(credentialsPath, JSON.stringify(credentials));
	await Fixture.cli(device, 'sync');
	await Fixture.cli(device, 'database-replay', JSON.stringify(pending));
	await Fixture.cli(device, 'sync');
	assert.equal(await Library.countDocuments({ account: Fixture.account, name: 'offline.yml' }), 1);
});
test('permission changes reject local writes, preserve pending drafts and remove revoked records', async () => {
	const user = await User.create({ email: randomUUID() + '@example.test', name: 'Member' });
	await Member.create({ account: Fixture.account, user: user._id, role: 'member' });
	const device = await Fixture.device('member', String(user._id));
	let { library } = await Fixture.json('libraries', 'POST', { name: 'Team library', snippets: [{ trigger: 'team', content: { version: 1, type: 'plain_text', text: 'Authorized' } }] });
	({ library } = await Fixture.json('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: library.name, shared: true, editable: true, members: [String(user._id)], groups: [] }));
	await Fixture.cli(device, 'sync');
	await Fixture.edit(device, 'Team library', 'team', 'Unsent draft');
	({ library } = await Fixture.json('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: library.name, shared: true, editable: false, members: [String(user._id)], groups: [] }));
	await Fixture.cli(device, 'sync');
	const state = await Fixture.state(device);
	assert.ok(state.recovery > 0);
	assert.equal(state.libraries.find(row => row._id === library._id).records[0].content.text, 'Authorized');
	await assert.rejects(Fixture.edit(device, 'Team library', 'team', 'Blocked'), /read-only/);
	await Fixture.json('libraries/' + library._id, 'PATCH', { base_revision: library.revision, name: library.name, shared: false, editable: false, members: [], groups: [] });
	await Fixture.cli(device, 'sync');
	assert.ok(!(await Fixture.state(device)).libraries.some(row => row.state === 'active'));
});
test('Trash and restore cross devices; Empty Trash purges copies and protocol v1 is rejected', async () => {
	const device = await Fixture.device('trash-device');
	let { library } = await Fixture.json('libraries', 'POST', { name: 'Trash sync', snippets: [{ trigger: 'trashsync', content: { version: 1, type: 'plain_text', text: 'Recover me' } }] });
	await Fixture.cli(device, 'sync');
	await Fixture.edit(device, 'Trash sync', 'trashsync', null);
	await Fixture.cli(device, 'sync');
	let items = (await Fixture.json('trash')).items;
	const target = items.find(item => item.library === library._id);
	assert.ok(target);
	await Fixture.json('trash/action', 'POST', { target, action: 'restore' });
	await Fixture.cli(device, 'sync');
	assert.equal((await Fixture.state(device)).libraries.find(row => row._id === library._id).records[0].state, 'active');
	await Fixture.edit(device, 'Trash sync', 'trashsync', null);
	await Fixture.cli(device, 'sync');
	items = (await Fixture.json('trash')).items;
	await Fixture.json('trash/empty', 'POST', { targets: items.filter(item => item.library === library._id) });
	await Fixture.cli(device, 'sync');
	const record = (await Fixture.state(device)).libraries.find(row => row._id === library._id).records[0];
	assert.equal(record.state, 'purged');
	assert.equal(record.content, undefined);
	const legacy = await Fixture.request('/api/v1/sync');
	assert.equal(legacy.status, 426);
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
	const source = (await readFile('./public/app.js', 'utf8')).replace('new TypeRelay();', 'window.client = new TypeRelay();').replace('export { client };', '');
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
	const hiddenUser = await User.create({ email: randomUUID() + '@example.test', name: 'Private member' });
	await Member.create({ account: Fixture.account, user: hiddenUser._id, role: 'member' });
	const hiddenCtx = await Support.context(String(hiddenUser._id), Fixture.account);
	await Libraries.mutate(hiddenCtx, randomUUID(), {}, async (ctx, session) => ({ library: await Libraries.create(ctx, { name: 'HiddenNavTest', yaml: 'matches: [{trigger: hiddennav, replace: SecretOnly}]' }, session) }));
	const hiddenResults = await client.request('search?q=hiddennav', 'GET', null, true);
	assert.ok(!hiddenResults.includes('SecretOnly') && !hiddenResults.includes('HiddenNavTest'));
	// Settings switch panes without discarding draft DOM or navigating.
	const draft = dom.window.document.querySelector('#profile-name');
	draft.value = 'Unsaved profile draft';
	await client.onClick({ target: dom.window.document.querySelector('[data-settings-tab="security"]') });
	assert.equal(dom.window.document.querySelector('#settings-pane-profile').hidden, true);
	assert.equal(dom.window.document.querySelector('#settings-pane-security').hidden, false);
	client.settingsTab('profile');
	assert.equal(dom.window.document.querySelector('#profile-name'), draft);
	assert.equal(draft.value, 'Unsaved profile draft');
	assert.ok(![...dom.window.document.querySelectorAll('h1')].some(node => node.textContent === 'Your libraries'));
	assert.ok(dom.window.document.querySelector('header #search-trigger'));
	// Every part of the card loads its library, including the count/badge area.
	const card = dom.window.document.querySelector('[data-id="' + library._id + '"]');
	client.selected = null;
	await client.onClick({ target: card.querySelector('.text-muted') });
	assert.equal(client.selected, library._id);
	assert.equal(card.getAttribute('role'), 'button');
	const modal = dom.window.document.querySelector('#search-modal');
	dom.window.bootstrap.Modal.getOrCreateInstance = element => ({ show() { element.classList.add('show'); }, hide() { element.classList.remove('show'); } });
	dom.window.bootstrap.Modal.getInstance = dom.window.bootstrap.Modal.getOrCreateInstance;
	for (const options of [{ key: '/' }, { key: 'k', ctrlKey: true }, { key: 'k', metaKey: true }]) {
		modal.classList.remove('show');
		const event = new dom.window.KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
		dom.window.document.body.dispatchEvent(event);
		assert.equal(event.defaultPrevented, true);
		assert.ok(modal.classList.contains('show'));
	}
	modal.classList.remove('show');
	const slash = new dom.window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
	draft.dispatchEvent(slash);
	assert.equal(slash.defaultPrevented, false);
	assert.ok(!modal.classList.contains('show'));
	search.value = 'Second';
	await client.filter();
	const result = dom.window.document.querySelector('[data-search-snippet="' + library.snippets[0].id + '"]');
	assert.ok(result, 'Search matches expansion text, not just the abbreviation');
	modal.classList.add('show');
	await client.onClick({ target: result });
	assert.equal(client.selected, library._id);
	assert.ok(!modal.classList.contains('show'));
	// Late search responses never replace a newer query.
	const request = client.request.bind(client);
	let finishOld;
	client.request = (path, ...args) => path === 'search?q=old' ? new Promise(resolve => { finishOld = resolve; }) : request(path, ...args);
	search.value = 'old';
	const old = client.filter();
	search.value = 'Second';
	await client.filter();
	const currentResults = dom.window.document.querySelector('#search-results').firstElementChild;
	finishOld('<p>Outdated response</p>');
	await old;
	assert.equal(dom.window.document.querySelector('#search-results').firstElementChild, currentResults);
	client.request = request;
	await client.form('library', { library: library._id }, () => {});
	assert.ok(dom.window.document.querySelector('#shared'));
	dom.window.close();
});
test('CSRF rejects writes, logout invalidates session', async () => {
	const response = await fetch(Fixture.origin + '/api/v2/libraries', { method: 'POST', headers: { Cookie: Fixture.cookie, 'Content-Type': 'application/json', 'X-Account-Id': Fixture.account }, body: JSON.stringify({ name: 'Blocked' }) });
	assert.equal(response.status, 403);
	assert.equal((await Fixture.request('/auth/logout', 'POST', {})).status, 200);
	assert.equal((await Fixture.request('/api/v2/libraries')).status, 403);
});
