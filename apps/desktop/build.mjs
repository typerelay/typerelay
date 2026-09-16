import pug from 'pug';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await writeFile('dist/index.html', pug.renderFile('ui/index.pug'));
for (const file of ['panel.js','panel.css','icon.svg']) await copyFile('ui/'+file,'dist/'+file);
for (const file of ['sweetalert2.min.js','sweetalert2.min.css']) await copyFile('node_modules/sweetalert2/dist/'+file,'dist/'+file);
