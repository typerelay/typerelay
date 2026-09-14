import { chromium } from '/usr/local/lib/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
	for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
		const page = await browser.newPage({ viewport });
		const errors = []; page.on('pageerror', error => errors.push(error.message));
		await page.goto('http://server:3040/docs/api/', { waitUntil: 'networkidle' });
		assert.equal(await page.title(), 'Overview | TypeRelay Docs');
		if (viewport.width < 500) { await page.getByRole('button', { name: 'mobile navigation', exact: true }).click(); await page.getByRole('link', { name: 'MCP', exact: true }).last().waitFor({ state: 'visible' }); await page.getByRole('button', { name: 'mobile navigation', exact: true }).click(); }
		else await page.getByRole('link', { name: 'MCP', exact: true }).waitFor({ state: 'visible' });
		await page.getByRole('button', { name: 'Search', exact: true }).click();
		await page.getByRole('searchbox').fill('Create snippet');
		await page.getByRole('option').first().waitFor({ state: 'visible' });
		await page.keyboard.press('Escape');
		await page.goto('http://server:3040/docs/api/operations/create_snippet', { waitUntil: 'networkidle' });
		await page.getByRole('heading', { name: 'Create snippet Permalink to Create snippet' }).waitFor({ state: 'visible' });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal page overflow');
		await page.screenshot({ path: '/artifacts/docs-' + viewport.width + '.png', fullPage: false });
		assert.deepEqual(errors, []);
		await page.close();
	}
	console.log('Desktop/mobile docs navigation, search and operation pages passed');
} finally { await browser.close(); }
