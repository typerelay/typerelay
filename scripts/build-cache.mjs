import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export class BuildCache {
	static prune() {
		const script = fileURLToPath(new URL('./prune-build-cache.py', import.meta.url));
		const launcher = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
		let result = spawnSync(launcher[0], [...launcher.slice(1), script], { stdio: 'inherit' });
		if (process.platform === 'win32' && result.error?.code === 'ENOENT') result = spawnSync('python', [script], { stdio: 'inherit' });
		if (result.error || result.status !== 0) console.warn('Compiler cache cleanup skipped: ' + (result.error?.message || 'Python exited with ' + result.status));
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) BuildCache.prune();
