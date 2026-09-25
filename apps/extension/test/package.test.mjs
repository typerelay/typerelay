import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
	const files = unzipSync(readFileSync(new URL(`../releases/typerelay-extension-${source.version}.zip`, import.meta.url)));
	assert.deepEqual(Object.keys(files).sort(), ['content.js', 'icon.png', 'manifest.json', 'messages.js', 'notice.css', 'notice.html', 'options.css', 'options.html', 'options.js', 'popup.css', 'popup.html', 'popup.js', 'prompt.css', 'prompt.html', 'runtime.js', 'template.wasm', 'worker.js'].sort());
	const manifest = JSON.parse(strFromU8(files['manifest.json']));
	assert.equal(manifest.version, source.version);
	assert.deepEqual(manifest.host_permissions, ['https://app.typerelay.com/*']);
	assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
	assert.match(strFromU8(files['worker.js']), /https:\/\/app.typerelay.com/);
	assert.doesNotMatch(strFromU8(files['worker.js']), /dev.example.test/);
	assert.equal(WebAssembly.validate(files['template.wasm']), true);
});
