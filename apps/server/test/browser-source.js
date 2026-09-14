import { readFile } from 'node:fs/promises';
// Evaluate the browser modules in the same JSDOM realm, without replacing their behavior.
export class BrowserSource {
	static async script() {
		const files = ['template-runtime.js', 'template-editor.js', 'abbreviation.js', 'app.js'];
		return (await Promise.all(files.map(file => readFile('./public/' + file, 'utf8')))).map(source => source.replace(/^import .*;$/gm, '').replaceAll('export class ', 'class ')).join('\n');
	}
}
