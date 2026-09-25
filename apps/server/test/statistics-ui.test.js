import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

test('statistics updates individual rows, ignores duplicate markup, and removes stale rows without a section reload', async () => {
	const dom = new JSDOM('<div id="statistics"><table><tbody data-statistics-rows="snippets"></tbody></table></div>', { runScripts: 'outside-only' });
	try {
		dom.window.eval((await readFile('./public/statistics.js', 'utf8')).replace('export class Statistics', 'window.Statistics = class Statistics'));
		const statistics = Object.create(dom.window.Statistics.prototype); const document = dom.window.document;
		const parent = document.querySelector('tbody'); const modal = document.querySelector('#statistics');
		const row = { id: 'one', name: 'First', library: 'Library', uses: 1, copies: 1, insertions: 0, characters: 250, minutes: 1, money: 0.5 };
		const second = { ...row, id: 'two', name: 'Second' };
		const report = rows => ({ snippets: rows, rows: { snippets: rows.map(row => ({ id: row.id, html: pug.renderFile('./views/ajax/statistics-row.pug', { row, kind: 'snippets', settings: { currency: 'USD' } }) })) } });
		Object.assign(statistics, { modal, sorts: {}, report: report([row, second]), client: { fragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; }, request() { throw new Error('No section or page reload'); } } });
		statistics.rows('snippets'); const firstNode = parent.children[0]; const secondNode = parent.children[1];
		statistics.rows('snippets'); assert.equal(parent.children[0], firstNode); assert.equal(parent.children[1], secondNode);
		statistics.report = report([{ ...row, uses: 2 }, second]); statistics.rows('snippets'); assert.notEqual(parent.children[0], firstNode); assert.equal(parent.children[1], secondNode); assert.equal(document.querySelector('tbody'), parent);
		statistics.report = report([]); statistics.rows('snippets'); assert.equal(parent.children.length, 0); assert.equal(document.querySelector('#statistics'), modal);
	} finally { dom.window.close(); }
});
