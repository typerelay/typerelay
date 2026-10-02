import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
	static row(id, uses = 1) { return { id, name: id, library: 'Library', uses, copies: uses, insertions: 0, characters: 250, minutes: 1, money: 0.5 }; }
	static report(snippets = [], days = []) {
		const report = { scope: 'personal', settings: { wpm: 50, hourly_rate: 30, currency: 'USD' }, options: { range: 'custom', start: '2026-09-28', end: '2026-10-01', timezone: 'America/New_York' }, totals: { uses: (days.length ? days : snippets).reduce((sum, row) => sum + row.uses, 0), characters: 500, minutes: 2, money: 1 }, days, snippets, libraries: [], members: [] };
		report.rows = Object.fromEntries(['days', 'snippets', 'libraries', 'members'].map(kind => [kind, report[kind].map(row => ({ id: row.id, html: pug.renderFile('./views/ajax/statistics-row.pug', { row, kind, settings: report.settings }) }))])); return report;
	}
	static async open() {
		const dom = new JSDOM(pug.renderFile('./views/ajax/statistics.pug', { ctx: { role: 'owner', entitlements: { plan: 'team' } } }), { runScripts: 'outside-only', pretendToBeVisual: true });
		dom.window.eval((await readFile('./public/statistics.js', 'utf8')).replace('export class Statistics', 'window.Statistics = class Statistics'));
		const document = dom.window.document; const modal = document.querySelector('#statistics-modal'); const trend = document.querySelector('#statistics-trend'); const size = { width: 688 };
		Object.defineProperties(trend, { clientWidth: { get: () => size.width }, clientHeight: { value: 224 } });
		const statistics = Object.assign(Object.create(dom.window.Statistics.prototype), { modal, trend, filters: document.querySelector('#statistics-filters'), preferences: document.querySelector('#statistics-preferences'), sorts: {}, version: 0, dirty: false, client: { fragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; }, request() { throw new Error('No section or page loader'); }, loadTrash() { assert.fail('No section reload'); }, navigate() { assert.fail('No page navigation'); } } });
		statistics.filters.elements.range.value = 'custom'; statistics.filters.elements.start.value = '2026-09-28'; statistics.filters.elements.end.value = '2026-10-01'; return { dom, document, statistics, size };
	}
}

test('statistics shows four summaries and five columns for every group', async () => {
	const { dom, document } = await Fixture.open();
	try {
		assert.deepEqual([...document.querySelectorAll('[data-statistics-total]')].map(node => node.dataset.statisticsTotal), ['uses', 'characters', 'minutes', 'money']);
		for (const section of document.querySelectorAll('[data-statistics-section]')) assert.deepEqual([...section.querySelectorAll('[data-statistics-sort]')].map(node => node.dataset.statisticsSort), ['name', 'uses', 'characters', 'minutes', 'money']);
	} finally { dom.window.close(); }
});

test('statistics updates individual rows and rescales unchanged bars without a section reload', async () => {
	const { dom, document, statistics } = await Fixture.open();
	try {
		const parent = document.querySelector('[data-statistics-rows="snippets"]'); const row = Fixture.row('one'); const second = Fixture.row('two'); const modal = statistics.modal;
		statistics.report = Fixture.report([row, second]); statistics.rows('snippets'); const firstNode = parent.children[0]; const secondNode = parent.children[1]; assert.equal(firstNode.cells.length, 5);
		statistics.rows('snippets'); assert.equal(parent.children[0], firstNode); assert.equal(parent.children[1], secondNode);
		statistics.report = Fixture.report([{ ...row, uses: 2 }, second]); statistics.rows('snippets'); assert.notEqual(parent.children[0], firstNode); assert.equal(parent.children[1], secondNode); assert.equal(secondNode.querySelector('[data-statistics-uses]').style.width, '50%'); assert.equal(parent.children[0].querySelector('[data-statistics-uses]').style.width, '100%');
		statistics.sorts.snippets = { key: 'uses', direction: 1 }; statistics.rows('snippets'); assert.equal(parent.children[0], secondNode);
		statistics.report = Fixture.report([]); statistics.rows('snippets'); assert.equal(parent.children.length, 0); assert.equal(document.querySelector('[data-statistics-rows="snippets"]'), parent); assert.equal(document.querySelector('#statistics-modal'), modal);
	} finally { dom.window.close(); }
});

test('chart handles calendar gaps, all-time, single days, empty data and narrow widths in place', async () => {
	const { dom, document, statistics, size } = await Fixture.open();
	try {
		const trend = statistics.trend; const line = trend.querySelector('.statistics-trend-line'); const area = trend.querySelector('.statistics-trend-area'); const point = trend.querySelector('.statistics-trend-point'); const days = [Fixture.row('2026-09-28', 50), Fixture.row('2026-09-30', 147), Fixture.row('2026-10-01', 44)];
		statistics.report = Fixture.report([], days); statistics.chart(); assert.match(line.getAttribute('d'), /L256\.00 192\.00/); assert.doesNotMatch(line.getAttribute('d'), /NaN|Infinity/); assert.notEqual(area.getAttribute('d'), '');
		statistics.report.options = { ...statistics.report.options, range: 'all', start: '1970-01-01' }; statistics.chart(); assert.match(document.querySelector('#statistics-trend-description').textContent, /from 2026-09-28/);
		statistics.report.days = [Fixture.row('1970-01-01', 1), Fixture.row('2026-10-01', 2)]; statistics.chart(); assert(line.getAttribute('d').length < 1000); assert.doesNotMatch(line.getAttribute('d'), /NaN|Infinity/);
		statistics.report = Fixture.report([], [days[0]]); statistics.report.options.end = '2026-09-28'; statistics.chart(); assert.equal(line.getAttribute('d'), ''); assert.equal(point.getAttribute('visibility'), 'visible'); assert.equal(point.getAttribute('cx'), '360');
		statistics.report = Fixture.report([], days); size.width = 280; statistics.chart(); assert.equal(trend.getAttribute('viewBox'), '0 0 280 224'); assert.equal([...trend.querySelectorAll('[data-statistics-x]')].filter(node => node.style.display !== 'none').length, 3); assert.equal(point.getAttribute('visibility'), 'hidden');
		statistics.report.days = []; statistics.chart(); assert.equal(document.querySelector('#statistics-trend-section').hidden, true); assert.equal(line.getAttribute('d'), ''); assert.equal(area.getAttribute('d'), ''); assert.equal(document.querySelector('#statistics-trend'), trend);
	} finally { dom.window.close(); }
});

test('accepted refreshes preserve state and stale or failed responses cannot replace the report', async () => {
	const { dom, document, statistics } = await Fixture.open();
	try {
		const row = Fixture.row('one'); const second = Fixture.row('two'); const day = Fixture.row('2026-09-28', 2); const parent = document.querySelector('[data-statistics-rows="snippets"]'); const body = document.querySelector('.modal-body');
		statistics.report = Fixture.report([row, second], [day]); statistics.rows('snippets'); statistics.chart(); const secondNode = parent.children[1]; const path = statistics.trend.querySelector('.statistics-trend-line');
		statistics.sorts.snippets = { key: 'uses', direction: -1 }; statistics.dirty = true; statistics.preferences.elements.wpm.value = '77'; statistics.preferences.elements.wpm.focus(); body.scrollTop = 123;
		const responses = []; statistics.client.request = route => { assert.match(route, /^statistics\?/); return new Promise(resolve => responses.push(resolve)); };
		const older = statistics.load(); const newer = statistics.load(); responses[1](Fixture.report([{ ...row, uses: 2 }, second], [{ ...day, uses: 3 }])); await newer;
		assert.equal(parent.children[0].cells[1].querySelector('span').textContent, '2'); assert.equal(parent.children[1], secondNode); assert.equal(document.querySelector('[data-statistics-total="uses"]').textContent, '3'); const acceptedPath = path.getAttribute('d');
		responses[0](Fixture.report([{ ...row, uses: 99 }], [{ ...day, uses: 99 }])); await older; assert.equal(parent.children[1], secondNode); assert.equal(path.getAttribute('d'), acceptedPath); assert.equal(document.querySelector('[data-statistics-total="uses"]').textContent, '3');
		statistics.client.request = async () => { throw new Error('Offline'); }; await assert.rejects(statistics.load(), /Offline/); assert.equal(parent.children[1], secondNode); assert.equal(path.getAttribute('d'), acceptedPath);
		assert.equal(statistics.preferences.elements.wpm.value, '77'); assert.equal(document.activeElement, statistics.preferences.elements.wpm); assert.equal(body.scrollTop, 123); assert.equal(statistics.sorts.snippets.direction, -1); assert.equal(document.querySelector('[data-statistics-rows="snippets"]'), parent);
	} finally { dom.window.close(); }
});
