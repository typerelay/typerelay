import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BuildCache } from '../../../scripts/build-cache.mjs';
import { rendererTarget } from './build-targets.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const targetDirectory = BuildCache.targetDirectory(root);
execFileSync('rustup', ['target', 'add', rendererTarget], { stdio: 'inherit' });
execFileSync('cargo', ['build', '--release', '-p', 'typerelay-template-wasm', '--target', rendererTarget], { cwd: root, stdio: 'inherit' });
const destination = new URL('../public/assets/generated/', import.meta.url);
mkdirSync(destination, { recursive: true });
copyFileSync(join(targetDirectory, rendererTarget, 'release/typerelay_template_wasm.wasm'), new URL('template.wasm', destination));
if (process.env.TYPERELAY_DEFER_MOBILE_CACHE_PRUNE !== '1') BuildCache.prune(...BuildCache.profilePaths(targetDirectory, 'release', rendererTarget));
