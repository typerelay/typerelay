import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pug from 'pug';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = fileURLToPath(new URL('./dist/', import.meta.url));
const development = process.argv.includes('--development');
mkdirSync(dist, { recursive: true });
execFileSync('cargo', ['build', '--release', '-p', 'typerelay-template-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' });
for (const name of ['worker.js', 'content.js', 'runtime.js', 'popup.js', 'popup.css', 'prompt.css']) copyFileSync(new URL(name, import.meta.url), new URL(name, `file://${dist}/`));
copyFileSync(new URL('../../target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm', import.meta.url), new URL('template.wasm', `file://${dist}/`));
copyFileSync(new URL('../desktop/src-tauri/icons/icon.png', import.meta.url), new URL('icon.png', `file://${dist}/`));
for (const name of ['popup', 'prompt']) writeFileSync(new URL(`${name}.html`, `file://${dist}/`), pug.renderFile(fileURLToPath(new URL(`${name}.pug`, import.meta.url)), { pretty: true }));
const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'));
if (development) manifest.host_permissions = ['http://localhost:3040/*'];
writeFileSync(new URL('manifest.json', `file://${dist}/`), JSON.stringify(manifest, null, 2));
const worker = readFileSync(new URL('worker.js', import.meta.url), 'utf8').replace('https://app.typerelay.com', development ? 'http://localhost:3040' : 'https://app.typerelay.com');
writeFileSync(new URL('worker.js', `file://${dist}/`), worker);
