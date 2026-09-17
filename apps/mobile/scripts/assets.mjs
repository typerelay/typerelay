import { createRequire } from 'node:module';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Use the existing TypeRelay mark and existing image dependency; no separate mobile artwork.
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const sharp = require('sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = fileURLToPath(new URL('../../server/public/typerelay-icon.svg', import.meta.url));
const icon = size => sharp(source, { density: 1200 }).resize(size, size).flatten({ background: '#fff6df' }).png();
await icon(1024).toFile(join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
 const destination = join(root, 'android/app/src/main/res', `mipmap-${density}`); mkdirSync(destination, { recursive: true });
 for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) await icon(size).toFile(join(destination, name));
 await sharp(source, { density: 1200 }).resize(size, size).extend({ top: Math.round(size * .625), bottom: Math.round(size * .625), left: Math.round(size * .625), right: Math.round(size * .625), background: { r: 255, g: 246, b: 223, alpha: 0 } }).png().toFile(join(destination, 'ic_launcher_foreground.png'));
}
const splash = await icon(256).toBuffer();
const iosSplash = join(root, 'ios/App/App/Assets.xcassets/Splash.imageset');
for (const name of readdirSync(iosSplash).filter(name => name.endsWith('.png'))) await sharp({ create: { width: 2732, height: 2732, channels: 3, background: '#fff6df' } }).composite([{ input: splash, gravity: 'center' }]).png().toFile(join(iosSplash, name));
const android = join(root, 'android/app/src/main/res');
for (const folder of readdirSync(android).filter(name => name.startsWith('drawable'))) {
 for (const name of readdirSync(join(android, folder)).filter(name => name === 'splash.png')) {
  const destination = join(android, folder, name); const { width, height } = await sharp(destination).metadata();
  await sharp({ create: { width, height, channels: 3, background: '#fff6df' } }).composite([{ input: await icon(Math.min(width, height, 192)).toBuffer(), gravity: 'center' }]).png().toFile(destination);
 }
}
