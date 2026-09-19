import pug from 'pug';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await writeFile('dist/index.html', pug.renderFile('ui/index.pug'));
for (const file of ['panel.js','panel.css','icon.svg']) await copyFile('ui/'+file,'dist/'+file);
await copyFile('node_modules/sweetalert2/dist/sweetalert2.all.min.js','dist/sweetalert2.all.min.js');
await copyFile('node_modules/sweetalert2/dist/sweetalert2.min.css','dist/sweetalert2.min.css');
