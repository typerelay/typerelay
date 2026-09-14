import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PanelRelease, SigningBridge } from '../../../scripts/release-panel.mjs';

test('release mode requires the right host and rejects publishing/unsupported targets', () => {
	assert.equal(PanelRelease.options(['windows', '--dry-run'], 'darwin').target, 'x86_64-pc-windows-msvc');
	assert.throws(() => PanelRelease.options(['windows'], 'darwin'), /Omarchy/);
	assert.throws(() => PanelRelease.options(['macos'], 'linux'), /Mac/);
	assert.equal(PanelRelease.options(['linux', '--dry-run'], 'darwin').target, 'x86_64-unknown-linux-gnu');
	assert.throws(() => PanelRelease.options(['linux'], 'darwin'), /Linux packaging/);
	assert.throws(() => PanelRelease.options(['windows', '--publish'], 'linux'), /publication/);
	assert.throws(() => PanelRelease.options(['windows', '--target', 'aarch64-pc-windows-msvc'], 'linux'), /Unsupported target/);
	assert.throws(() => PanelRelease.options(['linux', '--report', 'relative.json'], 'linux'), /absolute/);
});
test('build children never receive the hardware PIN or publishing credentials', () => {
	const env = PanelRelease.buildEnvironment({ PATH: '/bin', WINDOWS_SIGNING_PIN: 'fixture-pin', BUNNY_STORAGE_PASSWORD_TEST: 'fixture-storage', APPLE_PASSWORD: 'fixture-apple' });
	assert.deepEqual(env, { PATH: '/bin' });
});
test('Apple credential aliases match the existing Electron release environment', () => {
	const env = PanelRelease.appleEnvironment({ APPLE_API_KEY: '/private/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'ISSUER', WINDOWS_SIGNING_PIN: 'fixture-pin' });
	assert.equal(env.APPLE_API_KEY, 'KEYID'); assert.equal(env.APPLE_API_KEY_PATH, '/private/AuthKey.p8'); assert.equal(env.WINDOWS_SIGNING_PIN, undefined);
	assert.equal(PanelRelease.appleEnvironment({ APPLE_ID: 'person@example.test', APPLE_TEAM_ID: 'TEAM', APPLE_APP_SPECIFIC_PASSWORD: 'fixture' }).APPLE_PASSWORD, 'fixture');
	assert.throws(() => PanelRelease.appleEnvironment({}), /missing/);
});
test('private signing bridge confines paths, serializes requests and verifies before success', { skip: process.platform === 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-sign-test-')); await fs.chmod(root, 0o700);
	const allowed = path.join(root, 'artifacts'); await fs.mkdir(allowed);
	const first = path.join(allowed, 'app.exe'); const second = path.join(allowed, 'setup.exe'); const outside = path.join(root, 'outside.exe');
	for (const file of [first, second, outside]) await fs.writeFile(file, 'MZ fixture');
	let active = 0; let maximum = 0; const signed = [];
	const bridge = new SigningBridge(path.join(root, 'sign.sock'), [allowed], async file => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 15)); signed.push(file); active--; });
	try {
		await bridge.start(); assert.equal((await fs.stat(bridge.path)).mode & 0o777, 0o600);
		await Promise.all([SigningBridge.request(bridge.path, first), SigningBridge.request(bridge.path, second)]);
		assert.equal(maximum, 1); assert.equal(signed.length, 2);
		await assert.rejects(SigningBridge.request(bridge.path, outside), /failed/);
		const link = path.join(allowed, 'linked.exe'); await fs.symlink(outside, link); await assert.rejects(SigningBridge.request(bridge.path, link), /failed/);
		const fake = path.join(allowed, 'bad.exe'); await fs.writeFile(fake, 'not PE'); await assert.rejects(SigningBridge.request(bridge.path, fake), /failed/);
		assert.equal(signed.length, 2);
	} finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('failed signer never reports a verified artifact', { skip: process.platform === 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-sign-fail-')); const file = path.join(root, 'app.exe'); await fs.writeFile(file, 'MZ fixture');
	const bridge = new SigningBridge(path.join(root, 'sign.sock'), [root], async () => { throw new Error('Fixture failure'); });
	try { await bridge.start(); await assert.rejects(SigningBridge.request(bridge.path, file), /failed/); assert.equal(bridge.signed.size, 0); } finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('release tooling creates signed updater artifacts for every supported platform', async () => {
	const source = await fs.readFile(path.join(PanelRelease.root, 'scripts/release-panel.mjs'), 'utf8');
	const config = JSON.parse(await fs.readFile(path.join(PanelRelease.root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
	assert.match(source, /createUpdaterArtifacts: true/);
	assert.match(source, /TypeRelay-Omarchy-\$\{config\.version\}-x86_64\.tar\.gz/);
	assert.match(source, /windows-x86_64/);
	assert.match(source, /darwin-aarch64/);
	assert.match(source, /linux-x86_64/);
	assert.equal(config.plugins.updater.endpoints[0], 'https://transfer.typerelay.com/apps/latest.json');
	assert.match(config.plugins.updater.pubkey, /^[A-Za-z0-9+/=]+$/);
});
