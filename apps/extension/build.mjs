import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pug from 'pug';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = fileURLToPath(new URL('./dist/', import.meta.url));
const origin = process.argv.find(value => value.startsWith('--origin='))?.slice(9) || 'https://app.typerelay.com';
const packaging = process.argv.includes('--package');
if (packaging && origin !== 'https://app.typerelay.com') throw new Error('Store packages must use https://app.typerelay.com');
const parsed = new URL(origin);
if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'))) throw new Error('Use an HTTPS origin or local development server');
if (packaging) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
execFileSync('cargo', ['build', '--release', '-p', 'typerelay-template-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' });
for (const name of ['usage.js', 'worker.js', 'content.js', 'runtime.js', 'messages.js', 'popup.js', 'popup.css', 'options.js', 'options.css', 'prompt.css', 'prompt.js', 'notice.css']) copyFileSync(new URL(name, import.meta.url), new URL(name, `file://${dist}/`));
copyFileSync(new URL('../../target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm', import.meta.url), new URL('template.wasm', `file://${dist}/`));
copyFileSync(new URL('../desktop/src-tauri/icons/icon.png', import.meta.url), new URL('icon.png', `file://${dist}/`));
for (const name of ['popup', 'options', 'prompt', 'notice']) writeFileSync(new URL(`${name}.html`, `file://${dist}/`), pug.renderFile(fileURLToPath(new URL(`${name}.pug`, import.meta.url)), { pretty: true }));
const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'));
if (packaging) delete manifest.key;
manifest.host_permissions = [`${origin}/*`];
writeFileSync(new URL('manifest.json', `file://${dist}/`), JSON.stringify(manifest, null, 2));
const worker = readFileSync(new URL('worker.js', import.meta.url), 'utf8').replace('https://app.typerelay.com', origin);
writeFileSync(new URL('worker.js', `file://${dist}/`), worker);

if (packaging) {
	const releases = new URL('./releases/', import.meta.url);
	mkdirSync(releases, { recursive: true });
	const files = Object.fromEntries(readdirSync(dist).sort().map(name => [name, readFileSync(new URL(name, `file://${dist}/`))]));
	const archive = new URL(`typerelay-extension-${manifest.version}.zip`, releases);
	writeFileSync(archive, zipSync(files, { level: 9 }));
	console.log(`Chrome Store ZIP: ${fileURLToPath(archive)}`);
}
