if (process.env.SERVER_MODE !== 'scheduler') {
	const { copyFileSync } = await import('node:fs');
	await import('./build-editor.js');
	copyFileSync('/usr/local/share/typerelay/template.wasm', (process.env.CODE_EDITOR_DIR || '/data/editor') + '/template.wasm');
}
await import('../app.js');
