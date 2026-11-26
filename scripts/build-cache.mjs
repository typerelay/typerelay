import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export class BuildCache {
	static targetDirectory(root, environment = process.env) {
		return path.resolve(root, environment.CARGO_TARGET_DIR || environment.CARGO_BUILD_TARGET_DIR || 'target');
	}

	static profilePaths(targetDirectory, profile, ...targets) {
		// Cross-builds also compile build scripts and proc macros for the host.
		return [path.join(targetDirectory, profile), ...targets.map(target => path.join(targetDirectory, target, profile))];
	}

	static prune(...protectedProfiles) {
		const script = fileURLToPath(new URL('./prune-build-cache.py', import.meta.url));
		const args = [script, ...protectedProfiles];
		const launcher = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
		let result = spawnSync(launcher[0], [...launcher.slice(1), ...args], { stdio: 'inherit' });
		if (process.platform === 'win32' && result.error?.code === 'ENOENT') result = spawnSync('python', args, { stdio: 'inherit' });
		if (result.error || result.status !== 0) console.warn('Compiler cache cleanup skipped: ' + (result.error?.message || 'Python exited with ' + result.status));
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) BuildCache.prune(...process.argv.slice(2));
