import { copyFileSync } from 'node:fs';
import './build-editor.js';
copyFileSync('/usr/local/share/typerelay/template.wasm', (process.env.CODE_EDITOR_DIR || '/data/editor') + '/template.wasm');
await import('../app.js');
