import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PanelRelease, SigningBridge } from '../../../scripts/release-panel.mjs';
import { NativeTools } from '../scripts/stage-native-tools.mjs';
import { DesktopVersion } from '../../../scripts/desktop-version.mjs';

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
test('Tauri signing receives only one private key source', () => {
	const env = PanelRelease.buildEnvironment({ TAURI_SIGNING_PRIVATE_KEY: 'fixture-key', TAURI_SIGNING_PRIVATE_KEY_PATH: '/private/key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'fixture-password' });
	assert.deepEqual(env, { TAURI_SIGNING_PRIVATE_KEY: 'fixture-key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'fixture-password' });
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
	const first = path.join(allowed, 'app.exe'); const second = path.join(allowed, 'setup.exe'); const relative = path.join(allowed, 'relative.exe'); const outside = path.join(root, 'outside.exe');
	for (const file of [first, second, relative, outside]) await fs.writeFile(file, 'MZ fixture');
	let active = 0; let maximum = 0; const signed = [];
	const bridge = new SigningBridge(path.join(root, 'sign.sock'), [allowed], async file => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 15)); signed.push(file); active--; });
	try {
		await bridge.start(); assert.equal((await fs.stat(bridge.path)).mode & 0o777, 0o600);
		await Promise.all([SigningBridge.request(bridge.path, first), SigningBridge.request(bridge.path, second)]);
		await SigningBridge.request(bridge.path, path.basename(relative), allowed);
		assert.equal(maximum, 1); assert.deepEqual(new Set(signed), new Set(await Promise.all([first, second, relative].map(file => fs.realpath(file)))));
		await assert.rejects(SigningBridge.request(bridge.path, outside), /failed/);
		const link = path.join(allowed, 'linked.exe'); await fs.symlink(outside, link); await assert.rejects(SigningBridge.request(bridge.path, link), /failed/);
		const fake = path.join(allowed, 'bad.exe'); await fs.writeFile(fake, 'not PE'); await assert.rejects(SigningBridge.request(bridge.path, fake), /failed/);
		assert.equal(signed.length, 3);
	} finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('failed signer never reports a verified artifact', { skip: process.platform === 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-sign-fail-')); const file = path.join(root, 'app.exe'); await fs.writeFile(file, 'MZ fixture');
	const bridge = new SigningBridge(path.join(root, 'sign.sock'), [root], async () => { throw new Error('Fixture failure'); });
	try { await bridge.start(); await assert.rejects(SigningBridge.request(bridge.path, file), /failed/); assert.equal(bridge.signed.size, 0); } finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('extensionless NSIS uninstaller is signed only through the private bridge root', { skip: process.platform === 'win32' }, async () => {
	const root=await fs.mkdtemp(path.join(os.tmpdir(),'typerelay-nsis-sign-test-'));const uninstaller=path.join('/tmp',`makensis${process.pid}${Date.now()}`);const outside=path.join(root,'makensisOutside');const link=path.join('/tmp',`makensis${process.pid}link${Date.now()}`);await fs.writeFile(uninstaller,'MZ fixture');await fs.writeFile(outside,'MZ outside');await fs.symlink(outside,link);
	const bridge=new SigningBridge(path.join(root,'sign.sock'),[root],async file=>fs.appendFile(file,' signed'));
	try{await bridge.start();await SigningBridge.requestTauri(bridge.path,PanelRelease.root,uninstaller);assert.equal(await fs.readFile(uninstaller,'utf8'),'MZ fixture signed');assert.equal([...bridge.signed].filter(file=>path.basename(file).startsWith('nsis-uninstaller-')).length,1);await assert.rejects(SigningBridge.requestTauri(bridge.path,PanelRelease.root,outside),/Invalid/);await assert.rejects(SigningBridge.requestTauri(bridge.path,PanelRelease.root,link),/Invalid/);assert.deepEqual((await fs.readdir(root)).sort(),['makensisOutside','sign.sock']);}
	finally{await bridge.close();await fs.rm(uninstaller,{force:true});await fs.rm(link,{force:true});await fs.rm(root,{recursive:true,force:true});}
});

test('release tooling creates signed updater artifacts for every supported platform', async () => {
	const source = await fs.readFile(path.join(PanelRelease.root, 'scripts/release-panel.mjs'), 'utf8');
	const config = JSON.parse(await fs.readFile(path.join(PanelRelease.root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
	assert.match(source, /createUpdaterArtifacts: true/);
	assert.match(source, /TypeRelay-Linux-legacy-\$\{config\.version\}-x86_64\.tar\.gz/);
	assert.match(source, /windows-x86_64/);
	assert.match(source, /darwin-aarch64/);
	assert.match(source, /TypeRelay_\$\{config\.version\}_\$\{macArchitecture\}\.app\.tar\.gz/);
	assert.match(source, /Bundled macOS TUI version does not match/);
	assert.match(source, /linux-x86_64/);
	assert.match(source, /nativeTools=await NativeTools\.stage/);
	assert.match(source, /path\.dirname\(nativeTools\[0\]\)/);
	assert.match(source, /const panel=path\.join\(release,'typerelay-panel\.exe'\);.*executables=\[panel,\.\.\.nativeTools/);
	assert.match(source, /path\.join\(working, 'src-tauri'\), '%1'/);
	assert.match(source, /Tauri did not sign the NSIS uninstaller/);
	assert.equal(config.plugins.updater.endpoints[0], 'https://transfer.typerelay.com/apps/latest.json');
	assert.match(config.plugins.updater.pubkey, /^[A-Za-z0-9+/=]+$/);
});

test('desktop package version feeds Tauri and native builds', async () => {
	const config=JSON.parse(await fs.readFile(path.join(PanelRelease.root,'apps/desktop/src-tauri/tauri.conf.json'),'utf8'));const desktop=JSON.parse(await fs.readFile(path.join(PanelRelease.root,'apps/desktop/package.json'),'utf8'));const panel=await fs.readFile(path.join(PanelRelease.root,'apps/desktop/src-tauri/Cargo.toml'),'utf8');
	assert.equal(config.version,'../package.json');assert.equal((await DesktopVersion.config()).version,desktop.version);assert.doesNotMatch(panel,/^version = /m);
	for(const name of ['crates/client/src/main.rs','crates/client/src/tui/main.rs','apps/desktop/src-tauri/src/main.rs'])assert.match(await fs.readFile(path.join(PanelRelease.root,name),'utf8'),/env!\("TYPERELAY_VERSION"\)/);
	for(const name of ['crates/client/build.rs','apps/desktop/src-tauri/build.rs'])assert.match(await fs.readFile(path.join(PanelRelease.root,name),'utf8'),/DesktopVersion::emit/);
	assert.match(await fs.readFile(path.join(PanelRelease.root,'scripts/desktop-version-build.rs'),'utf8'),/cargo:rerun-if-changed/);
});

test('changing only the desktop package version changes the release version', async () => {
	const root=await fs.mkdtemp(path.join(os.tmpdir(),'typerelay-version-test-'));const originalRoot=DesktopVersion.root;
	try {
		for(const name of ['apps/desktop/package.json','apps/desktop/src-tauri/tauri.conf.json']) {const destination=path.join(root,name);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(originalRoot,name),destination);}
		const desktopPath=path.join(root,'apps/desktop/package.json');const desktop=JSON.parse(await fs.readFile(desktopPath,'utf8'));desktop.version='9.8.7';await fs.writeFile(desktopPath,JSON.stringify(desktop,null,2)+'\n');
		DesktopVersion.root=root;
		assert.equal(await DesktopVersion.version(),'9.8.7');assert.equal((await DesktopVersion.config()).version,'9.8.7');
	}finally{DesktopVersion.root=originalRoot;await fs.rm(root,{recursive:true,force:true});}
});

test('Linux packages stage the engine and TUI together for all formats', async () => {
	const plan = NativeTools.plan('x86_64-unknown-linux-gnu', { environment: {} });
	assert.equal(plan.command, 'cargo');
	assert.deepEqual(plan.args.slice(-6), ['--bin', 'typerelay', '--bin', 'typerelay-tui', '--bin', 'typerelay-ai']);
	assert.deepEqual(plan.files.map(file => path.basename(file.destination)), ['typerelay-x86_64-unknown-linux-gnu', 'typerelay-tui-x86_64-unknown-linux-gnu', 'typerelay-ai-x86_64-unknown-linux-gnu']);
	assert.equal(NativeTools.hostTarget('linux', 'x64'), 'x86_64-unknown-linux-gnu');
	const config = JSON.parse(await fs.readFile(path.join(PanelRelease.root, 'apps/desktop/src-tauri/tauri.linux.conf.json'), 'utf8'));
	assert.deepEqual(config.bundle.externalBin, ['binaries/typerelay', 'binaries/typerelay-tui', 'binaries/typerelay-ai']);
	assert.equal(config.build.beforeBundleCommand, 'node scripts/stage-native-tools.mjs');
});

test('legacy updater panel does not inherit the last packaged format', () => {
	for (const format of ['APP', 'DEB', 'RPM', 'UNK']) {
		const bytes = Buffer.from(`before__TAURI_BUNDLE_TYPE_VAR_${format}after`);
		const legacy = PanelRelease.legacyPanel(bytes);
		assert.equal(legacy.toString(), 'before__TAURI_BUNDLE_TYPE_VAR_UNKafter');
		assert.equal(legacy.length, bytes.length);
		assert.equal(bytes.toString(), `before__TAURI_BUNDLE_TYPE_VAR_${format}after`);
	}
});

test('AppImage-only flag is Linux-only and full releases remain the default', () => {
	assert.equal(PanelRelease.options(['linux'], 'linux').appimageOnly, false);
	assert.equal(PanelRelease.options(['linux', '--appimage'], 'linux').appimageOnly, true);
	for (const mode of ['windows', 'macos']) assert.throws(() => PanelRelease.options([mode, '--appimage', '--dry-run']), /only supported for Linux/);
});

for (const appimageOnly of [true, false]) test(`Linux release artifacts and verification with appimageOnly=${appimageOnly}`, { skip: process.platform !== 'linux' }, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-linux-release-test-')); const originalRoot = PanelRelease.root; const originalKey = process.env.TAURI_SIGNING_PRIVATE_KEY; const commands = []; const version = '9.8.7'; const triple = 'x86_64-unknown-linux-gnu';
	PanelRelease.root = root; process.env.TAURI_SIGNING_PRIVATE_KEY = 'fixture';
	t.mock.method(PanelRelease, 'repository', async () => '12345678901234567890');
	t.mock.method(DesktopVersion, 'config', async () => ({ version }));
	t.mock.method(NativeTools, 'stage', async () => []);
	t.mock.method(console, 'log', () => {});
	t.mock.method(PanelRelease, 'run', async (command, args, options = {}) => {
		commands.push([command, ...args]);
		if (command === 'git' && args[0] === 'rev-parse') return '12345678901234567890';
		if (command === 'rustup') return triple;
		if (command === 'file') return 'ELF 64-bit LSB executable, x86-64';
		if (command === 'rpm') return `${version} x86_64`;
		if (args[0] === '--version') return `${path.basename(command)} ${version}`;
		if (command === 'pnpm' && args[0] === 'tauri' && args[1] === 'build') {
			assert.equal(args[args.indexOf('--bundles') + 1], appimageOnly ? 'appimage' : 'appimage,deb,rpm');
			const release = path.join(options.environment.CARGO_TARGET_DIR, triple, 'release'); await fs.mkdir(release, { recursive: true });
			for (const name of ['typerelay', 'typerelay-tui', 'typerelay-panel', 'typerelay-ai']) await fs.writeFile(path.join(release, name), 'fixture');
			for (const [format, extension] of appimageOnly ? [['appimage', 'AppImage']] : [['appimage', 'AppImage'], ['deb', 'deb'], ['rpm', 'rpm']]) { const directory = path.join(release, 'bundle', format); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, `TypeRelay.${extension}`), 'fixture package'); }
		}
		if (command === 'tar') await fs.writeFile(args[1], 'fixture archive');
		if (command === 'pnpm' && args[1] === 'signer') await fs.writeFile(`${args[3]}.sig`, 'fixture signature');
		return '';
	});
	try {
		const reportPath = path.join(root, 'report.json');
		await PanelRelease.main(['linux', '--report', reportPath, ...(appimageOnly ? ['--appimage'] : [])]);
		const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
		assert.equal(report.verified, true); assert.equal(report.artifacts.length, appimageOnly ? 2 : 8);
		assert.equal(report.updater.target, appimageOnly ? 'linux-x86_64-appimage' : 'linux-x86_64');
		assert.deepEqual(report.packageUpdaters.map(item => item.target), (appimageOnly ? ['appimage'] : ['appimage', 'deb', 'rpm']).map(format => `linux-x86_64-${format}`));
		assert.equal(commands.some(([command, ...args]) => command === 'which' && args.includes('rpm')), !appimageOnly);
		assert.equal(commands.some(([command]) => command === 'rpm'), !appimageOnly);
		assert.equal(commands.some(([command]) => command === 'tar'), !appimageOnly);
		assert.equal(commands.some(([command, ...args]) => command === 'cargo' && args.includes('legacy-install')), !appimageOnly);
		if (appimageOnly) assert.ok(report.artifacts.every(item => /\.AppImage(\.sig)?$/.test(item.file)));
	} finally { PanelRelease.root = originalRoot; if (originalKey === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY; else process.env.TAURI_SIGNING_PRIVATE_KEY = originalKey; await fs.rm(root, { recursive: true, force: true }); }
});
