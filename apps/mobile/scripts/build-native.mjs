import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = join(root, 'apps/mobile');
const release = !process.argv.includes('--debug');
const profile = release ? 'release' : 'debug';
const build = (target, env = {}) => execFileSync('cargo', ['build', '-p', 'typerelay-mobile', '--target', target, ...(release ? ['--release'] : [])], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
if (process.argv[2] === 'ios') {
 const targets = ['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios'];
 execFileSync('rustup', ['target', 'add', ...targets], { stdio: 'inherit' });
 for (const target of targets) build(target, { IPHONEOS_DEPLOYMENT_TARGET: '15.0' });
 for (const platform of ['iphoneos', 'iphonesimulator']) mkdirSync(join(mobile, 'native/ios', platform), { recursive: true });
 copyFileSync(join(root, `target/aarch64-apple-ios/${profile}/libtyperelay_mobile.a`), join(mobile, 'native/ios/iphoneos/libtyperelay_mobile.a'));
 execFileSync('xcrun', ['lipo', '-create', ...targets.slice(1).map(target => join(root, `target/${target}/${profile}/libtyperelay_mobile.a`)), '-output', join(mobile, 'native/ios/iphonesimulator/libtyperelay_mobile.a')], { stdio: 'inherit' });
} else if (process.argv[2] === 'android') {
 const sdk = process.env.ANDROID_HOME || join(homedir(), 'Library/Android/sdk');
 const ndk = process.env.ANDROID_NDK_HOME || join(sdk, 'ndk/28.2.13676358');
 const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
 const bin = join(ndk, 'toolchains/llvm/prebuilt', host, 'bin');
 if (!existsSync(bin)) throw new Error('Install Android NDK 28.2.13676358 or set ANDROID_NDK_HOME.');
 for (const [target, abi] of [['aarch64-linux-android', 'arm64-v8a'], ['x86_64-linux-android', 'x86_64']]) {
  execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' });
  const key = target.replaceAll('-', '_');
  build(target, { [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: join(bin, `${target}24-clang`), [`CC_${key}`]: join(bin, `${target}24-clang`), [`AR_${key}`]: join(bin, 'llvm-ar'), RUSTFLAGS: `${process.env.RUSTFLAGS || ''} -C link-arg=-Wl,-z,max-page-size=16384` });
  const output = join(mobile, 'android/app/src/main/jniLibs', abi); mkdirSync(output, { recursive: true });
  copyFileSync(join(root, `target/${target}/${profile}/libtyperelay_mobile.so`), join(output, 'libtyperelay_mobile.so'));
 }
} else { throw new Error('Use build-native.mjs ios|android [--release]'); }
