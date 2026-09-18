import { defineConfig } from 'vite';
import pug from 'pug';
import { PreviewServer } from './scripts/preview-server.mjs';
const preview = process.env.NODE_ENV === 'development' && process.env.TYPERELAY_MOBILE_PREVIEW === 'true';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 base: preview ? new URL(process.env.MOBILE_PREVIEW_ORIGIN || 'http://localhost:5174').pathname.replace(/\/?$/, '/') : '/',
 define: { 'import.meta.env.VITE_MOBILE_PREVIEW': JSON.stringify(String(preview)), 'import.meta.env.VITE_PREVIEW_API_ORIGIN': JSON.stringify(process.env.MOBILE_API_ORIGIN || '') },
 server: { watch: { awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 } }, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
 plugins: [...(preview ? [PreviewServer.plugin()] : []),{ name: 'typerelay-pug', transform(source, id) { if (id.endsWith('.pug')) return { code: `${pug.compileClient(source, { filename: id, inlineRuntimeFunctions: true, name: 'template' })}\nexport default template;`, map: null }; } }],
 resolve: { alias: { '@server': fileURLToPath(new URL('../server', import.meta.url)) } },
 build: { target: 'es2022' },
});
