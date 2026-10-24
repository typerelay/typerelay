import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

test('store package excludes stale files and always uses the production origin', () => {
	const cwd = fileURLToPath(new URL('../', import.meta.url));
	mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
	writeFileSync(new URL('../dist/stale-secret.txt', import.meta.url), 'must not ship');
	writeFileSync(new URL('../dist/worker.js', import.meta.url), 'https://dev.example.test');
	assert.throws(() => execFileSync(process.execPath, ['build.mjs', '--package', '--origin=https://dev.example.test'], { cwd, stdio: 'pipe' }), /Store packages must use/);
	execFileSync(process.execPath, ['build.mjs', '--package'], { cwd, stdio: 'pipe' });
	const source = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
	const { version_extension: version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
	const files = unzipSync(readFileSync(new URL(`../releases/typerelay-extension-${version}.zip`, import.meta.url)));
	assert.deepEqual(Object.keys(files).sort(), ['ai.css', 'ai.js', 'content.js', 'icon.png', 'manifest.json', 'merge.js', 'messages.js', 'notice.css', 'options.css', 'options.html', 'options.js', 'popup.css', 'popup.html', 'popup.js', 'prompt.css', 'prompt.js', 'prompt.html', 'runtime.js', 'sweetalert2.all.min.js', 'sweetalert2.min.css', 'template.wasm', 'usage.js', 'worker.js'].sort());
	const manifest = JSON.parse(strFromU8(files['manifest.json']));
	assert.equal(manifest.version, version);
	assert.deepEqual(manifest.content_security_policy, { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" });
	assert.equal(Object.hasOwn(manifest, 'key'), false);
	assert.ok(manifest.permissions.includes('clipboardWrite'));
	assert.ok(!manifest.permissions.includes('clipboardRead'));
	assert.ok(manifest.web_accessible_resources.some(entry => entry.resources.includes('prompt.js')));
	assert.deepEqual(manifest.host_permissions, ['https://app.typerelay.com/*']);
	assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
	assert.match(strFromU8(files['worker.js']), /https:\/\/app.typerelay.com/);
	assert.doesNotMatch(strFromU8(files['worker.js']), /dev.example.test/);
	assert.equal(WebAssembly.validate(files['template.wasm']), true);
	execFileSync(process.execPath, ['build.mjs'], { cwd, stdio: 'pipe' });
	const unpacked = JSON.parse(readFileSync(new URL('../dist/manifest.json', import.meta.url)));
	assert.ok(source.key);
	assert.equal(unpacked.key, source.key);
	assert.deepEqual(unpacked.content_security_policy, manifest.content_security_policy);
});

test('root-only extension changes reach fresh output and invalid versions fail before building', { skip: process.platform === 'win32' }, () => {
	const root = mkdtempSync(path.join(tmpdir(), 'typerelay-extension-version-'));
	const original = fileURLToPath(new URL('../../../', import.meta.url));
	try {
		const extension = path.join(root, 'apps/extension');
		cpSync(path.join(original, 'apps/extension'), extension, { recursive: true, filter: file => !['node_modules', 'dist', 'releases'].includes(path.basename(file)) });
		symlinkSync(path.join(original, 'apps/extension/node_modules'), path.join(extension, 'node_modules'), 'dir');
		for (const name of ['apps/server/views', 'apps/server/public', 'apps/server/node_modules', 'apps/desktop/src-tauri/icons']) {
			mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
			symlinkSync(path.join(original, name), path.join(root, name), 'dir');
		}
		const wasm = path.join(root, 'target/wasm32-unknown-unknown/release');
		mkdirSync(wasm, { recursive: true });
		writeFileSync(path.join(wasm, 'typerelay_template_wasm.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
		const bin = path.join(root, 'bin');
		mkdirSync(bin);
		// The real WASM build is covered above; this fixture isolates version input and packaging.
		writeFileSync(path.join(bin, 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		const build = () => execFileSync(process.execPath, ['build.mjs', '--package'], { cwd: extension, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' });
		for (const version of ['9.8.7', '9.8.8']) {
			writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version_extension: version }));
			build();
			const files = unzipSync(readFileSync(path.join(extension, `releases/typerelay-extension-${version}.zip`)));
			assert.equal(JSON.parse(strFromU8(files['manifest.json'])).version, version);
			assert.equal(JSON.parse(readFileSync(path.join(extension, 'dist/manifest.json'))).version, version);
		}
		for (const version of [null, 123, '', '1.2', '01.2.3', '1.2.3-beta', '65536.2.3', '0.0.0', '1.2.3\n']) {
			writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version_extension: version }));
			assert.throws(build, /version_extension/);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
