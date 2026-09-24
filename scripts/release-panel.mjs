#!/usr/bin/env node
// Maintainer release entry point. Reuses the Helpmonks hardware signer; never publishes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NativeTools } from '../apps/desktop/scripts/stage-native-tools.mjs';
import { DesktopVersion } from './sync-desktop-version.mjs';

export class SigningBridge {
	constructor(socketPath, roots, sign) { this.path = socketPath; this.roots = roots; this.sign = sign; this.queue = Promise.resolve(); this.signed = new Set(); this.connections = new Set(); }
	async validate(file) {
		if (!['.exe', '.dll'].includes(path.extname(file).toLowerCase())) throw new Error('Only Windows PE artifacts may be signed');
		const resolved = await fs.realpath(file);
		const roots = await Promise.all(this.roots.map(root => fs.realpath(root)));
		if (!roots.some(root => { const relative = path.relative(root, resolved); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); })) throw new Error('Signing path is outside this build');
		const handle = await fs.open(resolved, 'r');
		try { const magic = Buffer.alloc(2); await handle.read(magic, 0, 2, 0); if (magic.toString() !== 'MZ') throw new Error('Not a Windows PE file'); } finally { await handle.close(); }
		return resolved;
	}
	async start() {
		this.server = net.createServer(socket => {
			this.connections.add(socket); socket.on('close', () => this.connections.delete(socket));
			let input = ''; let handled = false;
			socket.setTimeout(300000, () => socket.destroy());
			socket.on('error', () => {});
			socket.on('data', chunk => {
				if (handled) return;
				input += chunk.toString();
				if (input.length > 16384) { socket.destroy(); return; }
				if (!input.includes('\n')) return;
				handled = true;
				this.queue = this.queue.catch(() => {}).then(async () => {
					try { const request = JSON.parse(input.trim()); const file = await this.validate(request.file); await this.sign(file); this.signed.add(file); socket.end(JSON.stringify({ ok: true }) + '\n'); }
					catch(error) { console.error(`Windows signing bridge failed: ${error.message}`);socket.end(JSON.stringify({ error: 'Signing or verification failed; see the private release terminal' }) + '\n'); }
				});
			});
		});
		await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
		await fs.chmod(this.path, 0o600);
	}
	async close() { await this.queue.catch(() => {}); for (const socket of this.connections) socket.destroy(); if (this.server) await new Promise(resolve => this.server.close(resolve)); }
	static request(socketPath, file, base = process.cwd()) {
		file = path.resolve(base, file);
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(socketPath); let output = '';
			socket.setTimeout(300000, () => socket.destroy(new Error('Signing request timed out')));
			socket.on('connect', () => socket.write(JSON.stringify({ file }) + '\n'));
			socket.on('data', chunk => { output += chunk; if (output.length > 4096) socket.destroy(new Error('Invalid signing response')); });
			socket.on('error', reject);
			socket.on('end', () => { try { const result = JSON.parse(output); if (!result.ok) throw new Error(result.error || 'Signing failed'); resolve(); } catch (error) { reject(error); } });
		});
	}
	static async requestTauri(socketPath, base, file) {
		const absolute=path.resolve(base,file);
		if (path.extname(absolute)) return SigningBridge.request(socketPath,absolute);
		const stat=await fs.lstat(absolute);const resolved=await fs.realpath(absolute);const temporary=await fs.realpath('/tmp');
		if (!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<2||stat.size>64*1024*1024||path.dirname(resolved)!==temporary||!/^makensis[A-Za-z0-9]+$/.test(path.basename(resolved))||(process.getuid&&stat.uid!==process.getuid())) throw new Error('Invalid NSIS uninstaller signing path');
		const staged=path.join(path.dirname(socketPath),`nsis-uninstaller-${process.pid}-${Date.now()}.exe`);
		try {
			await fs.copyFile(resolved,staged);await fs.chmod(staged,0o600);await SigningBridge.request(socketPath,staged);
			const bytes=await fs.readFile(staged);const handle=await fs.open(absolute,'r+');
			try {const current=await handle.stat();if(current.dev!==stat.dev||current.ino!==stat.ino||current.nlink!==1)throw new Error('NSIS uninstaller changed during signing');await handle.truncate(0);await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
		} finally {await fs.rm(staged,{force:true});}
	}
}

export class PanelRelease {
	static root = fileURLToPath(new URL('../', import.meta.url));
	static script = fileURLToPath(import.meta.url);
	static options(args, platform = process.platform, architecture = process.arch) {
		const mode = args.shift(); if (!['windows', 'macos', 'linux'].includes(mode)) throw new Error('Usage: node scripts/release-panel.mjs windows|macos|linux [--dry-run] [--target TARGET] [--report FILE]');
		let target = mode === 'windows' ? 'x86_64-pc-windows-msvc' : mode === 'linux' ? 'x86_64-unknown-linux-gnu' : architecture === 'x64' && platform === 'darwin' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'; let dry = false; let report;
		while (args.length) { const arg = args.shift(); if (arg === '--dry-run') dry = true; else if (arg === '--target') target = args.shift(); else if (arg === '--report') report = args.shift(); else throw new Error('Unsupported option ' + arg + '; publication is handled by the shared release tool'); }
		const supported = mode === 'windows' ? ['x86_64-pc-windows-msvc'] : mode === 'linux' ? ['x86_64-unknown-linux-gnu'] : ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin'];
		if (!supported.includes(target)) throw new Error('Unsupported target');
		const expectedPlatform = mode === 'macos' ? 'darwin' : 'linux';
		if (!dry && platform !== expectedPlatform) throw new Error(mode === 'windows' ? 'Run Windows signing on Omarchy' : mode === 'linux' ? 'Run Linux packaging in the configured Linux release machine' : 'Run macOS signing on the Mac');
		if (report && !path.isAbsolute(report)) throw new Error('--report must be an absolute path');
		return { mode, target, dry, report };
	}
	static buildEnvironment(environment) {
		const result = { ...environment };
		for (const key of Object.keys(result)) if (key === 'WINDOWS_SIGNING_PIN' || key.startsWith('BUNNY_STORAGE_PASSWORD') || key.startsWith('APPLE_')) delete result[key];
		if (result.TAURI_SIGNING_PRIVATE_KEY) delete result.TAURI_SIGNING_PRIVATE_KEY_PATH;
		return result;
	}
	static appleEnvironment(environment) {
		const result = PanelRelease.buildEnvironment(environment);
		for (const key of ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_SIGNING_IDENTITY']) if (environment[key]) result[key] = environment[key];
		result.APPLE_PASSWORD = environment.APPLE_PASSWORD || environment.APPLE_APP_SPECIFIC_PASSWORD;
		// electron-builder names the key path APPLE_API_KEY; Tauri uses APPLE_API_KEY_PATH.
		if (!result.APPLE_API_KEY_PATH && environment.APPLE_API_KEY_ID && environment.APPLE_API_KEY) { result.APPLE_API_KEY_PATH = environment.APPLE_API_KEY; result.APPLE_API_KEY = environment.APPLE_API_KEY_ID; }
		if (!(result.APPLE_ID && result.APPLE_PASSWORD && result.APPLE_TEAM_ID) && !(result.APPLE_API_ISSUER && result.APPLE_API_KEY && result.APPLE_API_KEY_PATH)) throw new Error('Apple notarization credentials are missing');
		return result;
	}
	static async run(command, args, { cwd = PanelRelease.root, environment = process.env, capture = false } = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { cwd, env: environment, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' }); let output = '';
			if (capture) { child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {}); }
			child.on('error', reject); child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(command + ' failed with exit code ' + code)));
		});
	}
	static async requireCommands(names) { for (const name of names) await PanelRelease.run('which', [name], { capture: true }); }
	static async repository() {
		await DesktopVersion.sync(true);
		if (await PanelRelease.run('git', ['status', '--porcelain'], { capture: true })) throw new Error('Release requires a clean checkout');
		if (await PanelRelease.run('git', ['branch', '--show-current'], { capture: true }) !== 'develop') throw new Error('Release requires the develop branch; merge the reviewed feature first');
		await PanelRelease.run('git', ['pull', '--ff-only']);
		return PanelRelease.run('git', ['rev-parse', 'HEAD'], { capture: true });
	}
	static async files(directory, extension) {
		const entries = await fs.readdir(directory, { withFileTypes: true }); const files = [];
		for (const entry of entries) { const file = path.join(directory, entry.name); if (entry.isDirectory()) { if (entry.name.endsWith(extension)) files.push(file); else files.push(...await PanelRelease.files(file, extension)); } else if (entry.name.endsWith(extension)) files.push(file); }
		return files;
	}
	static async main(args = process.argv.slice(2)) {
		if (args[0] === 'sign-file') { if (args.length !== 4) throw new Error('Invalid signing hook request'); return SigningBridge.requestTauri(args[1],args[2],args[3]); }
		const options = PanelRelease.options([...args]);
		const working = path.join(PanelRelease.root, 'apps/desktop');
		let target = path.join(PanelRelease.root, 'target/desktop-releases', options.mode);
		const build = options.mode === 'windows' ? ['tauri', 'bundle', '--target', options.target, '--bundles', 'nsis', '--config', 'src-tauri/tauri.windows.conf.json'] : ['tauri', 'build', '--target', options.target, '--bundles', options.mode === 'linux' ? 'deb,appimage' : 'app,dmg', '--', '--locked'];
		const compile = options.mode === 'windows' ? ['xwin', 'build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--target', options.target, '--locked'] : null;
		if (options.dry) { console.log(JSON.stringify({ source: 'clean develop + git pull --ff-only', platform: options.mode, target: options.target, install: ['pnpm', 'install', '--frozen-lockfile'], nativeTools: ['windows', 'macos'].includes(options.mode) ? NativeTools.plans(options.target).map(plan => [plan.command, ...plan.args]) : null, compile: compile ? ['cargo', ...compile] : null, build: ['pnpm', ...build], signing: options.mode === 'windows' ? 'Shared Helpmonks YubiKey signer via private socket; hidden PIN and touch in local terminal' : options.mode === 'macos' ? 'Local Developer ID, Apple notarization and Tauri updater signature' : 'Tauri updater signature for the verified engine, TUI and panel bundle', output: target, publish: false }, null, 2)); return; }
		if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
		await PanelRelease.requireCommands(['git', 'pnpm', 'cargo', 'rustup', 'tar', 'file', ...(options.mode === 'windows' ? ['cargo-xwin', 'clang', 'lld-link', 'llvm-rc', 'makensis', 'wine'] : options.mode === 'macos' ? ['security', 'codesign', 'spctl', 'xcrun', 'lipo'] : [])]);
		if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required');
		const commit = await PanelRelease.repository();
		const config = await DesktopVersion.config();
		const targets = options.target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [options.target];
		const installed = await PanelRelease.run('rustup', ['target', 'list', '--installed'], { capture: true });
		if (targets.some(value => !installed.split('\n').includes(value))) throw new Error('Install Rust targets first: rustup target add ' + targets.join(' '));
		await fs.mkdir(target, { recursive: true });
		target = await fs.mkdtemp(path.join(target, commit.slice(0, 12) + '-')); // Fresh artifacts; a failed run cannot inherit a previous verification report.
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-release-')); await fs.chmod(temporary, 0o700);
		const baseEnvironment = { ...PanelRelease.buildEnvironment(process.env), CARGO_TARGET_DIR: target, TMPDIR: temporary };
		const environment = options.mode === 'windows' ? NativeTools.environment(baseEnvironment) : baseEnvironment;
		let nativeTools=[]; let signer; let signingEnvironment; let bridge; let ownsSigningEnvironment = false;
		try {
			await PanelRelease.run('pnpm', ['install', '--frozen-lockfile'], { cwd: working, environment });
			if (options.mode === 'windows') { await PanelRelease.run('pnpm', ['build'], { cwd: working, environment }); nativeTools=await NativeTools.stage(options.target, { environment }); }
			if (options.mode === 'macos') nativeTools=await NativeTools.stage(options.target, { environment });
			if (options.mode === 'linux') await PanelRelease.run('cargo', ['build', '--release', '--locked', '--target', options.target, '--bin', 'typerelay', '--bin', 'typerelay-tui'], { environment });
			let overlay;
			if (options.mode === 'windows') {
				const tools = path.resolve(process.env.TYPERELAY_RELEASE_TOOLS || path.join(os.homedir(), 'repos/helpmonks-install-script/scripts/desktop-release'));
				signer = await import(pathToFileURL(path.join(tools, 'lib/windows-signing.mjs')).href);
				const hook = createRequire(import.meta.url)(path.join(tools, 'sign-windows-pkcs11.cjs'));
				if (process.env.WINDOWS_SIGNING_PREPARED === '1') signingEnvironment = process.env;
				else { signingEnvironment = await signer.prepareWindowsSigningEnvironment(process.env); ownsSigningEnvironment = true; await signer.runWindowsSigningProbe(signingEnvironment, path.join(tools, 'sign-windows-pkcs11.cjs')); }
				bridge = new SigningBridge(path.join(temporary, 'sign.sock'), [await fs.realpath(target), await fs.realpath(temporary), await fs.realpath(path.dirname(nativeTools[0]))], async file => {
					await hook.signWithEnvironment({ hash: 'sha256', name: 'TypeRelay', site: 'https://typerelay.com', path: file }, signingEnvironment);
					await PanelRelease.run('osslsigncode', ['verify', '-CAfile', signingEnvironment.WINDOWS_SIGNING_CA_FILE, '-ignore-cdp', '-ignore-crl', '-in', file], { environment, capture: true });
					});
					await bridge.start();
				overlay = { bundle: { createUpdaterArtifacts: true, windows: { signCommand: { cmd: process.execPath, args: [PanelRelease.script, 'sign-file', bridge.path, path.join(working, 'src-tauri'), '%1'] } } } };
			} else if (options.mode === 'macos') {
				Object.assign(environment, PanelRelease.appleEnvironment(process.env), { CARGO_TARGET_DIR: target, TMPDIR: temporary });
				environment.CI = 'true';
				if (environment.APPLE_API_KEY_PATH) await fs.access(environment.APPLE_API_KEY_PATH);
				const identities = await PanelRelease.run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true });
				const available = [...identities.matchAll(/"(Developer ID Application:[^"]+)"/g)].map(match => match[1]).filter(value => !environment.APPLE_TEAM_ID || value.endsWith('(' + environment.APPLE_TEAM_ID + ')'));
				const identity = available.includes(environment.APPLE_SIGNING_IDENTITY) ? environment.APPLE_SIGNING_IDENTITY : available.length === 1 ? available[0] : null;
				if (!identity || !available.includes(identity)) throw new Error('Set APPLE_SIGNING_IDENTITY to one matching Developer ID Application identity');
				environment.APPLE_SIGNING_IDENTITY = identity;
				overlay = { bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: identity, hardenedRuntime: true } } };
			} else {
				overlay = { bundle: { createUpdaterArtifacts: true } };
			}
			const overlayPath = path.join(temporary, 'tauri-signing.json'); await fs.writeFile(overlayPath, JSON.stringify(overlay), { mode: 0o600 });
			if (options.mode === 'windows') { build.push('--config', overlayPath); await PanelRelease.run('cargo', compile, { cwd: working, environment }); } else build.splice(build.indexOf('--'), 0, '--config', overlayPath);
			await PanelRelease.run('pnpm', build, { cwd: working, environment });
			const release = path.join(target, options.target, 'release'); let artifacts; let updater;
			if (options.mode === 'windows') {
				const panel=path.join(release,'typerelay-panel.exe');const installers=await PanelRelease.files(path.join(release,'bundle/nsis'),'.exe');const executables=[panel,...nativeTools,...installers];
				if (executables.length < 4) throw new Error('Missing Windows native tools or installer');
				for(const file of executables)if(!bridge.signed.has(await fs.realpath(file)))throw new Error('Tauri did not sign every release artifact');
				if(![...bridge.signed].some(file=>path.basename(file).startsWith('nsis-uninstaller-')))throw new Error('Tauri did not sign the NSIS uninstaller');
				for(const file of [...nativeTools,...installers])await PanelRelease.run('osslsigncode',['verify','-CAfile',signingEnvironment.WINDOWS_SIGNING_CA_FILE,'-ignore-cdp','-ignore-crl','-in',file],{capture:true,environment});
				const signatures = await PanelRelease.files(path.join(release, 'bundle/nsis'), '.sig');
				if (installers.length !== 1 || signatures.length !== 1) throw new Error('Expected one Windows NSIS installer and updater signature');
				artifacts = [...installers, ...signatures]; updater = { target: 'windows-x86_64', file: installers[0], signature: signatures[0] };
			} else if (options.mode === 'macos') {
				const apps = await PanelRelease.files(path.join(release, 'bundle/macos'), '.app'); if (apps.length !== 1) throw new Error('Expected one macOS app');
				const tui = path.join(apps[0], 'Contents/MacOS/typerelay-tui'); const version = await PanelRelease.run(tui, ['--version'], { capture: true }); if (version !== `typerelay-tui ${config.version}`) throw new Error('Bundled macOS TUI version does not match');
				await PanelRelease.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', apps[0]]);
				await PanelRelease.run('spctl', ['--assess', '--type', 'execute', '--verbose=2', apps[0]]);
				await PanelRelease.run('xcrun', ['stapler', 'validate', apps[0]]);
				await PanelRelease.run('lipo', [path.join(apps[0], 'Contents/MacOS/typerelay-panel'), '-verify_arch', ...targets.map(value => value.startsWith('aarch64') ? 'arm64' : 'x86_64')]);
				await PanelRelease.run('lipo', [tui, '-verify_arch', ...targets.map(value => value.startsWith('aarch64') ? 'arm64' : 'x86_64')]);
				const dmgs = await PanelRelease.files(path.join(release, 'bundle/dmg'), '.dmg'); const archives = await PanelRelease.files(path.join(release, 'bundle/macos'), '.app.tar.gz'); const signatures = await PanelRelease.files(path.join(release, 'bundle/macos'), '.sig');
				if (dmgs.length !== 1 || archives.length !== 1 || signatures.length !== 1) throw new Error('Expected one macOS DMG and signed updater archive');
				const macArchitecture = options.target.startsWith('aarch64') ? 'aarch64' : options.target.startsWith('x86_64') ? 'x64' : 'universal'; const archive = path.join(path.dirname(archives[0]), `TypeRelay_${config.version}_${macArchitecture}.app.tar.gz`); const signature = `${archive}.sig`;
				await fs.rename(archives[0], archive); await fs.rename(signatures[0], signature);
				artifacts = [...dmgs, archive, signature]; updater = { target: options.target.startsWith('aarch64') ? 'darwin-aarch64' : 'darwin-x86_64', file: archive, signature };
			} else {
				const engine = path.join(release, 'typerelay'); const tui = path.join(release, 'typerelay-tui'); const panel = path.join(release, 'typerelay-panel');
				for (const [name, file] of [['typerelay', engine], ['typerelay-tui', tui], ['typerelay-panel', panel]]) { const version = await PanelRelease.run(file, ['--version'], { capture: true }); if (version !== `${name} ${config.version}`) throw new Error(`${name} version does not match ${config.version}`); const type = await PanelRelease.run('file', ['--brief', file], { capture: true }); if (!/ELF 64-bit.*x86-64/i.test(type)) throw new Error(`${name} is not an x86-64 ELF binary`); }
				const bundle = path.join(release, 'bundle/omarchy'); await fs.mkdir(bundle, { recursive: true }); for (const file of [engine, tui, panel]) await fs.copyFile(file, path.join(bundle, path.basename(file)));
				const archive = path.join(release, 'bundle', `TypeRelay-Omarchy-${config.version}-x86_64.tar.gz`); await PanelRelease.run('tar', ['-czf', archive, '-C', bundle, 'typerelay', 'typerelay-tui', 'typerelay-panel']); await PanelRelease.run('pnpm', ['tauri', 'signer', 'sign', archive], { cwd: working, environment });
				const appImages = await PanelRelease.files(path.join(release, 'bundle/appimage'), '.AppImage'); const debs = await PanelRelease.files(path.join(release, 'bundle/deb'), '.deb');
				if (appImages.length !== 1 || debs.length !== 1) throw new Error('Expected one Linux AppImage and DEB');
				const type = await PanelRelease.run('file', ['--brief', appImages[0]], { capture: true }); if (!/ELF 64-bit.*x86-64/i.test(type)) throw new Error('AppImage is not x86-64');
				artifacts = [...appImages, ...debs, archive, `${archive}.sig`]; updater = { target: 'linux-x86_64', file: archive, signature: `${archive}.sig` };
			}
			if (await PanelRelease.run('git', ['status', '--porcelain'], { capture: true })) throw new Error('Build changed tracked source; do not distribute');
			const report = { product: 'TypeRelay', version: config.version, commit, platform: options.mode, target: options.target, verified: true, directory: target, updater: { target: updater.target, file: path.relative(target, updater.file), signature: (await fs.readFile(updater.signature, 'utf8')).trim() }, artifacts: await Promise.all(artifacts.map(async file => ({ file: path.relative(target, file), size: (await fs.stat(file)).size, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') }))) };
			await fs.writeFile(path.join(target, 'release-verification.json'), JSON.stringify(report, null, 2) + '\n');
			if (options.report) { await fs.mkdir(path.dirname(options.report), { recursive: true }); await fs.writeFile(options.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
			console.log('Signed and verified TypeRelay ' + config.version + '. Nothing published. Output: ' + target);
		} finally { if (bridge) await bridge.close(); if (ownsSigningEnvironment) await signer.cleanupWindowsSigningEnvironment(signingEnvironment); await fs.rm(temporary, { recursive: true, force: true }); }
	}
}
if (process.argv[1]) { const entry = await fs.realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1])); if (import.meta.url === pathToFileURL(entry).href) PanelRelease.main().catch(error => { console.error(error.message); process.exitCode = 1; }); }
