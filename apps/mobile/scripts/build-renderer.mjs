import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
execFileSync('cargo', ['build', '--release', '-p', 'typerelay-template-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' });
const destination = new URL('../public/assets/generated/', import.meta.url);
mkdirSync(destination, { recursive: true });
copyFileSync(new URL('../../../target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm', import.meta.url), new URL('template.wasm', destination));
