import { readFile } from 'node:fs/promises';
// Evaluate the browser modules in the same JSDOM realm, without replacing their behavior.
export class BrowserSource {
	static async script() {
		const files = ['template-runtime.js', 'rich-text-runtime.js', 'template-editor.js', 'abbreviation.js', 'product-updates.js', 'trial-countdown.js', 'password-field.js', 'ai.js', 'statistics.js', 'app.js'];
		// JSDOM has no layout engine or ResizeObserver.
		return 'window.ResizeObserver ??= class { observe() {} disconnect() {} };\n' + (await Promise.all(files.map(file => readFile('./public/' + file, 'utf8')))).map(source => source.replace(/^import .*;$/gm, '').replaceAll('export class ', 'class ')).join('\n');
	}
}
