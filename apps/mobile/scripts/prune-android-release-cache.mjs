import { fileURLToPath } from 'node:url';
import { BuildCache } from '../../../scripts/build-cache.mjs';
import { androidTargets, rendererTarget } from './build-targets.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const targetDirectory = BuildCache.targetDirectory(root);
BuildCache.prune(...BuildCache.profilePaths(targetDirectory, 'release', ...androidTargets.map(([target]) => target), rendererTarget));
