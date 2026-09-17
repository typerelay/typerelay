import { defineConfig } from 'vite';
import pug from 'pug';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 plugins: [{ name: 'typerelay-pug', transform(source, id) { if (id.endsWith('.pug')) return { code: `${pug.compileClient(source, { filename: id, inlineRuntimeFunctions: true, name: 'template' })}\nexport default template;`, map: null }; } }],
 resolve: { alias: { '@server': fileURLToPath(new URL('../server', import.meta.url)) } },
 build: { target: 'es2022' },
});
