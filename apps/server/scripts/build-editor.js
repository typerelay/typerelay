import { build } from 'esbuild';
await build({ entryPoints: ['browser/code-editor.js'], outdir: '/data/editor', bundle: true, splitting: true, format: 'esm', minify: true, target: 'es2022' });
