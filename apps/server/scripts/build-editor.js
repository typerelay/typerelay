import { build } from 'esbuild';
await build({ entryPoints: ['browser/code-editor.js'], outdir: process.env.CODE_EDITOR_DIR || '/data/editor', bundle: true, splitting: true, format: 'esm', minify: true, target: 'es2022' });
