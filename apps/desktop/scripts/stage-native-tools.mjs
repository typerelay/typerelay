#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class NativeTools {
	static root = fileURLToPath(new URL('../../../', import.meta.url));
	static names = ['typerelay', 'typerelay-tui'];
	static rustflags = 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS';
	static environment(environment = process.env) { return { ...environment, [NativeTools.rustflags]: [environment[NativeTools.rustflags], '-C target-feature=+crt-static'].filter(Boolean).join(' ') }; }
	static plan(target, { platform = process.platform, environment = process.env, root = NativeTools.root } = {}) {
		if (target !== 'x86_64-pc-windows-msvc') throw new Error('Unsupported native-tools target');
		const targetRoot = environment.CARGO_TARGET_DIR ? path.resolve(root, environment.CARGO_TARGET_DIR) : path.join(root, 'target');
		const release = path.join(targetRoot, target, 'release');
		const destination = path.join(root, 'apps/desktop/src-tauri/binaries');
		return {
			command: platform === 'win32' ? 'cargo' : 'cargo-xwin',
			args: ['build', '--release', '--locked', '--target', target, ...NativeTools.names.flatMap(name => ['--bin', name])],
			files: NativeTools.names.map(name => ({ source: path.join(release, name + '.exe'), destination: path.join(destination, name + '-' + target + '.exe') })),
		};
	}
	static async stage(target, options = {}) {
		const plan = NativeTools.plan(target, options);
		await new Promise((resolve, reject) => {
			const child = spawn(plan.command, plan.args, { cwd: options.root || NativeTools.root, env: NativeTools.environment(options.environment || process.env), stdio: 'inherit' });
			child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(plan.command + ' failed with exit code ' + code)));
		});
		await fs.mkdir(path.dirname(plan.files[0].destination), { recursive: true });
		for (const file of plan.files) await fs.copyFile(file.source, file.destination);
		return plan.files.map(file => file.destination);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) NativeTools.stage(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
