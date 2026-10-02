import pug from 'pug';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await Promise.all(['ai.js','ai.css'].map(file=>rm('dist/'+file,{force:true})));
await writeFile('dist/index.html', pug.renderFile('ui/index.pug'));
for (const file of ['panel.js','suggestions.js','panel.css','icon.svg']) await copyFile('ui/'+file,'dist/'+file);
await copyFile('../server/public/typerelay-logo.svg','dist/typerelay-logo.svg');
await copyFile('node_modules/sweetalert2/dist/sweetalert2.all.min.js','dist/sweetalert2.all.min.js');
await copyFile('node_modules/sweetalert2/dist/sweetalert2.min.css','dist/sweetalert2.min.css');
