import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BuildCache } from '../../../scripts/build-cache.mjs';

test('packaging selects the fresh artifact when Cargo configuration moves the target directory', async t => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'typerelay-cargo-')));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const env = { ...process.env, CARGO_HOME: path.join(root, '.cargo-home') };
	delete env.CARGO_TARGET_DIR;
	delete env.CARGO_BUILD_TARGET_DIR;
	const options = { cwd: root, env, encoding: 'utf8' };
	const manifest = path.join(root, 'Cargo.toml');
	await fs.mkdir(path.join(root, 'src'));
	await fs.mkdir(path.join(root, '.cargo'));
	await fs.writeFile(manifest, '[package]\nname="probe"\nversion="0.1.0"\nedition="2021"\n');
	const executable = process.platform === 'win32' ? 'probe.exe' : 'probe';
	for (const version of ['old', 'fresh']) {
		if (version === 'fresh') await fs.writeFile(path.join(root, '.cargo/config.toml'), '[build]\ntarget-dir="custom output"\n');
		await fs.writeFile(path.join(root, 'src/main.rs'), `fn main() { println!("${version}"); }`);
		execFileSync('cargo', ['build', '--offline', '--quiet', '--release'], options);
	}
	const selected = BuildCache.targetDirectory(root, env);
	const scripts = fileURLToPath(new URL('../../../scripts', import.meta.url));
	const alias = path.join(root, 'linked scripts');
	await fs.symlink(scripts, alias, process.platform === 'win32' ? 'junction' : 'dir');
	const cli = path.join(alias, 'build-cache.mjs');
	assert.equal(execFileSync(process.execPath, [cli, '--target-directory', manifest], options).trimEnd(), selected);
	assert.equal(execFileSync(path.join(root, 'target/release', executable), [], options).trimEnd(), 'old');
	assert.equal(execFileSync(path.join(selected, 'release', executable), [], options).trimEnd(), 'fresh');
});
