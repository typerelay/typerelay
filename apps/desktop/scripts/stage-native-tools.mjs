#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class NativeTools {
	static root = fileURLToPath(new URL('../../../', import.meta.url));
	static rustflags = 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS';
	static environment(environment = process.env) { const flags = environment[NativeTools.rustflags] || ''; return { ...environment, LLAMA_STATIC_CRT: '1', [NativeTools.rustflags]: flags.includes('-C target-feature=+crt-static') ? flags : [flags, '-C target-feature=+crt-static'].filter(Boolean).join(' ') }; }
	static plan(target, { platform = process.platform, environment = process.env, root = NativeTools.root } = {}) {
		const windows = target === 'x86_64-pc-windows-msvc'; const linux = target === 'x86_64-unknown-linux-gnu'; const macos = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target);
		if (!windows && !macos && !linux) throw new Error('Unsupported native-tools target');
		const names = windows || linux ? ['typerelay', 'typerelay-tui', 'typerelay-ai'] : ['typerelay-tui', 'typerelay-ai'];
		const targetRoot = environment.CARGO_TARGET_DIR ? path.resolve(root, environment.CARGO_TARGET_DIR) : path.join(root, 'target');
		const release = path.join(targetRoot, target, 'release');
		const destination = path.join(root, 'apps/desktop/src-tauri/binaries');
		return {
			command: windows && platform !== 'win32' ? 'cargo-xwin' : 'cargo',
			args: ['build', '--release', '--locked', '--target', target, '--no-default-features', '--features', 'desktop,ai-runtime', ...names.flatMap(name => ['--bin', name])],
			files: names.map(name => ({ source: path.join(release, name + (windows ? '.exe' : '')), destination: path.join(destination, name + '-' + target + (windows ? '.exe' : '')) })),
		};
	}
	static plans(target, options = {}) { return target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(value => NativeTools.plan(value, options)) : [NativeTools.plan(target, options)]; }
	static async stage(target, options = {}) {
		const plans = NativeTools.plans(target, options); const environment = target.includes('windows') ? NativeTools.environment(options.environment || process.env) : options.environment || process.env;
		for (const plan of plans) await new Promise((resolve, reject) => {
			const child = spawn(plan.command, plan.args, { cwd: options.root || NativeTools.root, env: environment, stdio: 'inherit' });
			child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(plan.command + ' failed with exit code ' + code)));
		});
		await fs.mkdir(path.dirname(plans[0].files[0].destination), { recursive: true });
		if (target === 'universal-apple-darwin') {
			const destinations = [];
			for (const [index, file] of plans[0].files.entries()) {
				const destination = file.destination.replace('aarch64-apple-darwin', 'universal-apple-darwin');
				await new Promise((resolve, reject) => { const child = spawn('lipo', ['-create', ...plans.map(plan => plan.files[index].source), '-output', destination], { env: environment, stdio: 'inherit' }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('lipo failed with exit code ' + code))); });
				destinations.push(destination);
			}
			return destinations;
		}
		for (const file of plans.flatMap(plan => plan.files)) await fs.copyFile(file.source, file.destination);
		return plans.flatMap(plan => plan.files.map(file => file.destination));
	}
	static hostTarget(platform = process.platform, architecture = process.arch) { if (platform === 'darwin') return architecture === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'; if (platform === 'win32') return 'x86_64-pc-windows-msvc'; if (platform === 'linux' && architecture === 'x64') return 'x86_64-unknown-linux-gnu'; throw new Error('Pass a supported native-tools target'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) NativeTools.stage(process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE || NativeTools.hostTarget()).catch(error => { console.error(error.message); process.exitCode = 1; });
