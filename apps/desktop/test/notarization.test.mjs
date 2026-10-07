import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PanelRelease } from '../../../scripts/release-panel.mjs';
import { DesktopVersion } from '../../../scripts/desktop-version.mjs';
import { NativeTools } from '../scripts/stage-native-tools.mjs';

class NotarizationFixture {
	static environment = { APPLE_ID: 'fixture@example.test', APPLE_TEAM_ID: 'TEAM', APPLE_PASSWORD: 'fixture-secret', TAURI_SIGNING_PRIVATE_KEY: 'fixture-updater-key' };
	static provenance = { commit: 'a'.repeat(40), version: '9.8.7', target: 'universal-apple-darwin' };
	static id = '12345678-1234-1234-1234-123456789abc';
	static async create(t) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-notarization-test-')); const app = path.join(directory, 'release/TypeRelay.app');
		await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true }); await fs.writeFile(path.join(app, 'Contents/MacOS/panel'), 'signed fixture', { mode: 0o755 });
		t.after(() => fs.rm(directory, { recursive: true, force: true }));
		t.mock.method(console, 'log', () => {});
		return { directory, app, state: { ...this.provenance, id: this.id, status: 'In Progress', app: path.relative(directory, app), fingerprint: await PanelRelease.fingerprint(app) } };
	}
}

test('notary authentication supports existing Apple ID and API key aliases', () => {
	assert.deepEqual(PanelRelease.notaryArguments(NotarizationFixture.environment), ['--apple-id', 'fixture@example.test', '--password', 'fixture-secret', '--team-id', 'TEAM']);
	assert.deepEqual(PanelRelease.notaryArguments({ APPLE_API_KEY: '/private/key.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER' }), ['--key', '/private/key.p8', '--key-id', 'KEY', '--issuer', 'ISSUER']);
});

test('hung external commands are killed within their deadline without leaking arguments', async () => {
	const started = Date.now();
	await assert.rejects(PanelRelease.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'fixture-secret'], { capture: true, timeoutMs: 100 }), error => /timed out/.test(error.message) && !error.message.includes('fixture-secret'));
	assert.ok(Date.now() - started < 3000);
});

test('notarization progress persists ID and status and bounds every status request', async t => {
	const { directory, state } = await NotarizationFixture.create(t); const statuses = ['In Progress', 'Accepted']; const requests = [];
	t.mock.method(PanelRelease, 'run', async (command, args, options) => { requests.push({ command, args, options }); return JSON.stringify({ id: state.id, status: statuses.shift() }); });
	await PanelRelease.waitForNotarization(state, directory, NotarizationFixture.environment, { timeoutMs: 1000, pollMs: 1 });
	assert.equal(requests.length, 2); assert.equal(state.status, 'Accepted');
	for (const request of requests) { assert.equal(request.args[1], 'info'); assert.ok(request.options.timeoutMs > 0 && request.options.timeoutMs <= 1000); assert.equal(request.options.environment.APPLE_PASSWORD, undefined); }
	assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'notarization.json'), 'utf8')).status, 'Accepted');
	assert.equal((await fs.stat(path.join(directory, 'notarization.json'))).mode & 0o777, 0o600);
});

test('pending submission times out and remains resumable without acceptance', async t => {
	const { directory, state } = await NotarizationFixture.create(t);
	t.mock.method(PanelRelease, 'run', async () => JSON.stringify({ id: state.id, status: 'In Progress' }));
	await assert.rejects(PanelRelease.waitForNotarization(state, directory, NotarizationFixture.environment, { timeoutMs: 20, pollMs: 5 }), /pending/);
	assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'notarization.json'), 'utf8')).id, state.id);
	await assert.rejects(fs.access(path.join(directory, 'release-verification.json')));
});

for (const status of ['Invalid', 'Rejected', 'unexpected']) test(`Apple status ${status} cannot reach packaging`, async t => {
	const { directory, state } = await NotarizationFixture.create(t);
	t.mock.method(PanelRelease, 'run', async () => JSON.stringify({ id: state.id, status }));
	await assert.rejects(PanelRelease.waitForNotarization(state, directory, NotarizationFixture.environment), /ended with/);
});

test('status from another submission cannot be accepted', async t => {
	const { directory, state } = await NotarizationFixture.create(t);
	t.mock.method(PanelRelease, 'run', async () => JSON.stringify({ id: 'another-id', status: 'Accepted' }));
	await assert.rejects(PanelRelease.waitForNotarization(state, directory, NotarizationFixture.environment), /different.*submission/);
	assert.equal(state.status, 'In Progress');
});

test('submission ID survives network failure and retry never resubmits or alters signed app', async t => {
	const { directory, app } = await NotarizationFixture.create(t); const calls = []; let disconnected = true;
	t.mock.method(PanelRelease, 'run', async (command, args) => {
		calls.push([command, ...args]);
		if (args[0] === 'notarytool' && args[1] === 'submit') { assert.ok(!args.includes('--wait')); return JSON.stringify({ id: NotarizationFixture.id, status: 'In Progress' }); }
		if (args[0] === 'notarytool' && args[1] === 'info') { if (disconnected) throw new Error('Network unavailable'); return JSON.stringify({ id: NotarizationFixture.id, status: 'Accepted' }); }
		if (command === 'ditto' && args[0] === app) await fs.cp(app, args[1], { recursive: true });
		if (args[0] === 'stapler') await fs.writeFile(path.join(args[2], 'ticket'), 'fixture ticket');
		return '';
	});
	await assert.rejects(PanelRelease.notarize(app, directory, NotarizationFixture.provenance, NotarizationFixture.environment), /Network unavailable[\s\S]*--resume/);
	const saved = await fs.readFile(path.join(directory, 'notarization.json'), 'utf8');
	assert.equal(JSON.parse(saved).id, NotarizationFixture.id); assert.ok(!saved.includes('fixture-secret')); assert.ok(!saved.includes('fixture-updater-key'));
	disconnected = false;
	const packaged = await PanelRelease.notarize(app, directory, NotarizationFixture.provenance, NotarizationFixture.environment);
	assert.equal(calls.filter(call => call[1] === 'notarytool' && call[2] === 'submit').length, 1);
	assert.equal(await fs.readFile(path.join(packaged, 'ticket'), 'utf8'), 'fixture ticket'); await assert.rejects(fs.access(path.join(app, 'ticket')));
	assert.equal(await PanelRelease.fingerprint(app), JSON.parse(saved).fingerprint);
});

test('unknown submission outcome preserves intent and refuses a duplicate submission', async t => {
	const { directory, app } = await NotarizationFixture.create(t); let submissions = 0;
	t.mock.method(PanelRelease, 'run', async (command, args) => { if (args[1] === 'submit') { submissions++; throw new Error('Upload timed out'); } return ''; });
	await assert.rejects(PanelRelease.notarize(app, directory, NotarizationFixture.provenance, NotarizationFixture.environment), /Upload timed out/);
	await assert.rejects(PanelRelease.notarize(app, directory, NotarizationFixture.provenance, NotarizationFixture.environment), /outcome unknown/);
	assert.equal(submissions, 1);
});

for (const change of ['bytes', 'mode', 'symlink', 'source']) test(`resume refuses changed ${change}`, async t => {
	const { directory, app, state } = await NotarizationFixture.create(t); await PanelRelease.saveNotarization(directory, state); let provenance = NotarizationFixture.provenance;
	if (change === 'bytes') await fs.appendFile(path.join(app, 'Contents/MacOS/panel'), 'changed');
	if (change === 'mode') await fs.chmod(path.join(app, 'Contents/MacOS/panel'), 0o644);
	if (change === 'symlink') await fs.symlink('/outside', path.join(app, 'Contents/link'));
	if (change === 'source') provenance = { ...provenance, commit: 'b'.repeat(40) };
	t.mock.method(PanelRelease, 'run', async () => { assert.fail('Changed app must not reach Apple or packaging'); });
	await assert.rejects(PanelRelease.notarize(app, directory, provenance, NotarizationFixture.environment), /changed/);
});

test('auto-resume selects matching pending run and refuses ambiguous candidates', async t => {
	const { directory, state } = await NotarizationFixture.create(t);
	for (const [name, values] of [['pending', state], ['old-source', { ...state, commit: 'b'.repeat(40) }], ['finished', { ...state, completed: true }]]) { await fs.mkdir(path.join(directory, name)); await PanelRelease.saveNotarization(path.join(directory, name), values); }
	assert.equal(await PanelRelease.pendingRun(directory, NotarizationFixture.provenance), path.join(directory, 'pending'));
	await fs.mkdir(path.join(directory, 'another')); await PanelRelease.saveNotarization(path.join(directory, 'another'), state);
	await assert.rejects(PanelRelease.pendingRun(directory, NotarizationFixture.provenance), /Multiple pending/);
});

test('resume option rejects missing paths, relative paths and other platforms', () => {
	for (const args of [['macos', '--resume'], ['macos', '--resume', 'relative'], ['linux', '--resume', '/absolute']]) assert.throws(() => PanelRelease.options([...args, '--dry-run']), /resume/);
});

test('release lock prevents concurrent packaging and safely recovers a dead owner', async t => {
	const { directory } = await NotarizationFixture.create(t); const lock = await PanelRelease.lockRun(directory);
	assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
	await assert.rejects(PanelRelease.lockRun(directory), /active/);
	assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
	await fs.writeFile(lock, '2147483647');
	const outcomes = await Promise.allSettled([PanelRelease.lockRun(directory), PanelRelease.lockRun(directory)]);
	assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
	assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
});

test('bundle mutation during Apple processing blocks stapling', async t => {
	const { directory, app, state } = await NotarizationFixture.create(t); await PanelRelease.saveNotarization(directory, state);
	t.mock.method(PanelRelease, 'waitForNotarization', async () => { await fs.appendFile(path.join(app, 'Contents/MacOS/panel'), 'changed while waiting'); });
	t.mock.method(PanelRelease, 'run', async () => { assert.fail('Changed app must not be stapled'); });
	await assert.rejects(PanelRelease.notarize(app, directory, NotarizationFixture.provenance, NotarizationFixture.environment), /changed/);
});

for (const explicit of [false, true]) test(`complete macOS pipeline resumes without rebuilding or resubmitting (explicit=${explicit})`, async t => {
	const { directory } = await NotarizationFixture.create(t); const root = path.join(directory, 'repo'); const originalRoot = PanelRelease.root; const originalEnvironment = { ...process.env }; const commands = []; const options = PanelRelease.options; let unavailable = true; let packagingFailure = true; let installations = 0; let compilations = 0; let stages = 0; let submissions = 0; let repositoryCalls = 0;
	await fs.mkdir(root); PanelRelease.root = root; Object.assign(process.env, NotarizationFixture.environment);
	t.after(() => { PanelRelease.root = originalRoot; for (const key of Object.keys(NotarizationFixture.environment)) { if (originalEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = originalEnvironment[key]; } });
	t.mock.method(PanelRelease, 'options', args => options(args, 'darwin', 'arm64'));
	t.mock.method(PanelRelease, 'repository', async () => { repositoryCalls++; return NotarizationFixture.provenance.commit; });
	t.mock.method(DesktopVersion, 'config', async () => ({ version: NotarizationFixture.provenance.version }));
	t.mock.method(NativeTools, 'stage', async () => { stages++; return []; });
	t.mock.method(PanelRelease, 'run', async (command, args, settings = {}) => {
		commands.push([command, ...args]);
		if (command === 'git') { if (args[0] === 'rev-parse') return NotarizationFixture.provenance.commit; if (args[0] === 'branch') return 'develop'; return ''; }
		if (command === 'rustup') return 'aarch64-apple-darwin\nx86_64-apple-darwin';
		if (command === 'security') return '"Developer ID Application: Fixture (TEAM)"';
		if (command === 'pnpm' && args[0] === 'install') installations++;
		if (command === 'pnpm' && args[0] === 'tauri' && args[1] === 'build') {
			compilations++;
			assert.equal(args[args.indexOf('--bundles') + 1], 'app');
			for (const key of Object.keys(settings.environment)) assert.ok(!key.startsWith('APPLE_'), 'Tauri must not inherit Apple notarization credentials');
			const overlay = JSON.parse(await fs.readFile(args[args.indexOf('--config') + 1], 'utf8')); assert.equal(overlay.bundle.createUpdaterArtifacts, false); assert.equal(overlay.bundle.macOS.signingIdentity, 'Developer ID Application: Fixture (TEAM)');
			const binaries = path.join(settings.environment.CARGO_TARGET_DIR, NotarizationFixture.provenance.target, 'release/bundle/macos/TypeRelay.app/Contents/MacOS'); await fs.mkdir(binaries, { recursive: true });
			for (const name of ['typerelay-panel', 'typerelay-tui', 'typerelay-ai']) await fs.writeFile(path.join(binaries, name), 'signed fixture', { mode: 0o755 });
		}
		if (command === 'xcrun' && args[0] === 'notarytool') {
			if (args[1] === 'submit') { submissions++; return JSON.stringify({ id: NotarizationFixture.id, status: 'In Progress' }); }
			if (unavailable) throw new Error('Connection lost');
			return JSON.stringify({ id: NotarizationFixture.id, status: 'Accepted' });
		}
		if (command === 'ditto' && args.length === 2) await fs.cp(args[0], args[1], { recursive: true });
		if (command === 'xcrun' && args[0] === 'stapler') { if (args[1] === 'staple') await fs.writeFile(path.join(args[2], 'ticket'), 'ticket'); else await fs.access(path.join(args[2], 'ticket')); }
		if (args[0] === '--version') return `${path.basename(command)} ${NotarizationFixture.provenance.version}`;
		if (command === 'hdiutil') { await fs.access(path.join(args[args.indexOf('-srcfolder') + 1], 'TypeRelay.app/ticket')); await fs.writeFile(args.at(-1), 'fixture DMG'); if (packagingFailure) throw new Error('DMG interrupted'); }
		if (command === 'tar') { assert.equal(args.at(-1), 'TypeRelay.app'); await fs.access(path.join(args[args.indexOf('-C') + 1], 'TypeRelay.app/ticket')); await fs.writeFile(args[1], 'stapled fixture archive'); }
		if (command === 'pnpm' && args[1] === 'signer') { assert.equal(args[args.indexOf('--app-version') + 1], NotarizationFixture.provenance.version); await fs.writeFile(`${args[3]}.sig`, 'fixture updater signature'); }
		return '';
	});
	const firstReport = path.join(root, 'report-one.json'); const secondReport = path.join(root, 'report-two.json');
	await assert.rejects(PanelRelease.main(['macos', '--target', NotarizationFixture.provenance.target, '--report', firstReport]), /Connection lost/);
	const releaseRoot = path.join(root, 'target/desktop-releases/macos'); const [name] = await fs.readdir(releaseRoot); const run = path.join(releaseRoot, name);
	await assert.rejects(fs.access(firstReport)); await assert.rejects(fs.access(path.join(run, 'release-verification.json')));
	const saved = JSON.parse(await fs.readFile(path.join(run, 'notarization.json'), 'utf8')); assert.equal(saved.id, NotarizationFixture.id); assert.notEqual(saved.completed, true);
	unavailable = false;
	await assert.rejects(PanelRelease.main(['macos', ...(explicit ? ['--resume', run] : ['--target', NotarizationFixture.provenance.target]), '--report', secondReport]), /DMG interrupted[\s\S]*Resume:/);
	await assert.rejects(fs.access(secondReport)); await assert.rejects(fs.access(path.join(run, 'release-verification.json'))); await assert.rejects(fs.access(path.join(run, 'release.lock')));
	packagingFailure = false;
	await PanelRelease.main(['macos', ...(explicit ? ['--resume', run] : ['--target', NotarizationFixture.provenance.target]), '--report', secondReport]);
	assert.equal(installations, 1); assert.equal(compilations, 1); assert.equal(stages, 1); assert.equal(submissions, 1); assert.equal(repositoryCalls, explicit ? 1 : 3);
	const report = JSON.parse(await fs.readFile(secondReport, 'utf8')); assert.equal(report.verified, true); assert.equal(report.commit, NotarizationFixture.provenance.commit); assert.equal(report.target, 'universal-apple-darwin'); assert.equal(report.artifacts.length, 3); assert.equal(report.directory, run);
	assert.equal(JSON.parse(await fs.readFile(path.join(run, 'notarization.json'), 'utf8')).completed, true);
	assert.equal(await PanelRelease.fingerprint(path.join(run, saved.app)), saved.fingerprint);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(run, 'release-verification.json'), 'utf8')), report);
});
