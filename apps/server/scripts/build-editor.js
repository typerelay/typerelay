import { build } from 'esbuild';
await build({ entryPoints: ['browser/code-editor.js', 'browser/rich-editor.js'], outdir: process.env.EDITOR_OUTDIR || '/data/editor', bundle: true, splitting: true, format: 'esm', minify: true, target: 'es2022' });
