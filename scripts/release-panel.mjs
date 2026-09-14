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

export class SigningBridge {
	constructor(socketPath, roots, sign) { this.path = socketPath; this.roots = roots; this.sign = sign; this.queue = Promise.resolve(); this.signed = new Set(); this.connections = new Set(); }
	async validate(file) {
		if (!['.exe', '.dll'].includes(path.extname(file).toLowerCase())) throw new Error('Only Windows PE artifacts may be signed');
		const resolved = await fs.realpath(file);
		if (!this.roots.some(root => { const relative = path.relative(root, resolved); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); })) throw new Error('Signing path is outside this build');
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
					catch { socket.end(JSON.stringify({ error: 'Signing or verification failed; see the private release terminal' }) + '\n'); }
				});
			});
		});
		await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
		await fs.chmod(this.path, 0o600);
	}
	async close() { await this.queue.catch(() => {}); for (const socket of this.connections) socket.destroy(); if (this.server) await new Promise(resolve => this.server.close(resolve)); }
	static request(socketPath, file) {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(socketPath); let output = '';
			socket.setTimeout(300000, () => socket.destroy(new Error('Signing request timed out')));
			socket.on('connect', () => socket.write(JSON.stringify({ file }) + '\n'));
			socket.on('data', chunk => { output += chunk; if (output.length > 4096) socket.destroy(new Error('Invalid signing response')); });
			socket.on('error', reject);
			socket.on('end', () => { try { const result = JSON.parse(output); if (!result.ok) throw new Error(result.error || 'Signing failed'); resolve(); } catch (error) { reject(error); } });
		});
	}
}

export class PanelRelease {
	static root = fileURLToPath(new URL('../', import.meta.url));
	static script = fileURLToPath(import.meta.url);
	static options(args, platform = process.platform, architecture = process.arch) {
		const mode = args.shift(); if (!['windows', 'macos'].includes(mode)) throw new Error('Usage: node scripts/release-panel.mjs windows|macos [--dry-run] [--target TARGET]');
		let target = mode === 'windows' ? 'x86_64-pc-windows-msvc' : architecture === 'x64' && platform === 'darwin' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'; let dry = false;
		while (args.length) { const arg = args.shift(); if (arg === '--dry-run') dry = true; else if (arg === '--target') target = args.shift(); else throw new Error('Unsupported option ' + arg + '; publication is separate'); }
		const supported = mode === 'windows' ? ['x86_64-pc-windows-msvc'] : ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin'];
		if (!supported.includes(target)) throw new Error('Unsupported target');
		if (!dry && platform !== (mode === 'windows' ? 'linux' : 'darwin')) throw new Error(mode === 'windows' ? 'Run Windows signing on Omarchy' : 'Run macOS signing on the Mac');
		return { mode, target, dry };
	}
	static buildEnvironment(environment) {
		const result = { ...environment };
		for (const key of Object.keys(result)) if (key === 'WINDOWS_SIGNING_PIN' || key.startsWith('BUNNY_STORAGE_PASSWORD') || key.startsWith('APPLE_')) delete result[key];
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
		if (args[0] === 'sign-file') { if (args.length !== 3) throw new Error('Invalid signing hook request'); return SigningBridge.request(args[1], args[2]); }
		const options = PanelRelease.options([...args]);
		const working = path.join(PanelRelease.root, 'apps/desktop');
		let target = path.join(PanelRelease.root, 'target/desktop-releases', options.mode);
		const build = ['tauri', 'build', '--target', options.target, '--bundles', options.mode === 'windows' ? 'nsis' : 'app,dmg', '--', '--locked'];
		if (options.mode === 'windows') build.splice(2, 0, '--runner', 'cargo-xwin');
		if (options.dry) { console.log(JSON.stringify({ source: 'clean develop + git pull --ff-only', platform: options.mode, target: options.target, install: ['pnpm', 'install', '--frozen-lockfile'], build: ['pnpm', ...build], signing: options.mode === 'windows' ? 'Shared Helpmonks YubiKey signer via private socket; hidden PIN and touch in local terminal' : 'Local Developer ID + Apple notarization; verify signature, Gatekeeper and stapled app ticket', output: target, publish: false }, null, 2)); return; }
		if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
		await PanelRelease.requireCommands(['git', 'pnpm', 'cargo', 'rustup', ...(options.mode === 'windows' ? ['cargo-xwin', 'clang', 'lld-link', 'llvm-rc', 'makensis', 'wine'] : ['security', 'codesign', 'spctl', 'xcrun', 'lipo'])]);
		const commit = await PanelRelease.repository();
		const config = JSON.parse(await fs.readFile(path.join(working, 'src-tauri/tauri.conf.json'), 'utf8'));
		const targets = options.target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [options.target];
		const installed = await PanelRelease.run('rustup', ['target', 'list', '--installed'], { capture: true });
		if (targets.some(value => !installed.split('\n').includes(value))) throw new Error('Install Rust targets first: rustup target add ' + targets.join(' '));
		await fs.mkdir(target, { recursive: true });
		target = await fs.mkdtemp(path.join(target, commit.slice(0, 12) + '-')); // Fresh artifacts; a failed run cannot inherit a previous verification report.
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-release-')); await fs.chmod(temporary, 0o700);
		const environment = { ...PanelRelease.buildEnvironment(process.env), CARGO_TARGET_DIR: target, TMPDIR: temporary };
		let signer; let signingEnvironment; let bridge;
		try {
			await PanelRelease.run('pnpm', ['install', '--frozen-lockfile'], { cwd: working, environment });
			let overlay;
			if (options.mode === 'windows') {
				const tools = path.resolve(process.env.TYPERELAY_RELEASE_TOOLS || path.join(os.homedir(), 'repos/helpmonks-install-script/scripts/desktop-release'));
				signer = await import(pathToFileURL(path.join(tools, 'lib/windows-signing.mjs')).href);
				const hook = createRequire(import.meta.url)(path.join(tools, 'sign-windows-pkcs11.cjs'));
				signingEnvironment = await signer.prepareWindowsSigningEnvironment(process.env);
				await signer.runWindowsSigningProbe(signingEnvironment, path.join(tools, 'sign-windows-pkcs11.cjs'));
				bridge = new SigningBridge(path.join(temporary, 'sign.sock'), [await fs.realpath(target), await fs.realpath(temporary)], async file => {
					await hook.signWithEnvironment({ hash: 'sha256', name: 'TypeRelay', site: 'https://typerelay.com', path: file }, signingEnvironment);
					await PanelRelease.run('osslsigncode', ['verify', '-CAfile', signingEnvironment.WINDOWS_SIGNING_CA_FILE, '-ignore-cdp', '-ignore-crl', '-in', file], { environment, capture: true });
				});
				await bridge.start();
				overlay = { bundle: { windows: { signCommand: { cmd: process.execPath, args: [PanelRelease.script, 'sign-file', bridge.path, '%1'] } } } };
			} else {
				Object.assign(environment, PanelRelease.appleEnvironment(process.env), { CARGO_TARGET_DIR: target, TMPDIR: temporary });
				if (environment.APPLE_API_KEY_PATH) await fs.access(environment.APPLE_API_KEY_PATH);
				const identities = await PanelRelease.run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true });
				const available = [...identities.matchAll(/"(Developer ID Application:[^"]+)"/g)].map(match => match[1]).filter(value => !environment.APPLE_TEAM_ID || value.endsWith('(' + environment.APPLE_TEAM_ID + ')'));
				const identity = environment.APPLE_SIGNING_IDENTITY || (available.length === 1 ? available[0] : null);
				if (!identity || !available.includes(identity)) throw new Error('Set APPLE_SIGNING_IDENTITY to one matching Developer ID Application identity');
				environment.APPLE_SIGNING_IDENTITY = identity;
				overlay = { bundle: { macOS: { signingIdentity: identity, hardenedRuntime: true } } };
			}
			const overlayPath = path.join(temporary, 'tauri-signing.json'); await fs.writeFile(overlayPath, JSON.stringify(overlay), { mode: 0o600 });
			build.splice(build.indexOf('--'), 0, '--config', overlayPath);
			await PanelRelease.run('pnpm', build, { cwd: working, environment });
			const release = path.join(target, options.target, 'release'); let artifacts;
			if (options.mode === 'windows') {
				artifacts = [path.join(release, 'typerelay-panel.exe'), ...await PanelRelease.files(path.join(release, 'bundle/nsis'), '.exe')];
				if (artifacts.length < 2) throw new Error('Missing Windows installer');
				for (const file of artifacts) { if (!bridge.signed.has(await fs.realpath(file))) throw new Error('Tauri did not sign every release artifact'); await PanelRelease.run('osslsigncode', ['verify', '-CAfile', signingEnvironment.WINDOWS_SIGNING_CA_FILE, '-ignore-cdp', '-ignore-crl', '-in', file], { capture: true, environment }); }
			} else {
				const apps = await PanelRelease.files(path.join(release, 'bundle/macos'), '.app'); if (apps.length !== 1) throw new Error('Expected one macOS app');
				await PanelRelease.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', apps[0]]);
				await PanelRelease.run('spctl', ['--assess', '--type', 'execute', '--verbose=2', apps[0]]);
				await PanelRelease.run('xcrun', ['stapler', 'validate', apps[0]]);
				await PanelRelease.run('lipo', ['-verify_arch', ...targets.map(value => value.startsWith('aarch64') ? 'arm64' : 'x86_64'), path.join(apps[0], 'Contents/MacOS/typerelay-panel')]);
				artifacts = await PanelRelease.files(path.join(release, 'bundle/dmg'), '.dmg'); if (!artifacts.length) throw new Error('Missing DMG');
			}
			if (await PanelRelease.run('git', ['status', '--porcelain'], { capture: true })) throw new Error('Build changed tracked source; do not distribute');
			const report = { product: 'TypeRelay', version: config.version, commit, platform: options.mode, target: options.target, verified: true, artifacts: await Promise.all(artifacts.map(async file => ({ file: path.relative(target, file), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') }))) };
			await fs.writeFile(path.join(target, 'release-verification.json'), JSON.stringify(report, null, 2) + '\n');
			console.log('Signed and verified TypeRelay ' + config.version + '. Nothing published. Output: ' + target);
		} finally { if (bridge) await bridge.close(); if (signingEnvironment) await signer.cleanupWindowsSigningEnvironment(signingEnvironment); await fs.rm(temporary, { recursive: true, force: true }); }
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) PanelRelease.main().catch(error => { console.error(error.message); process.exitCode = 1; });
