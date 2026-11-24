import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import pug from 'pug';

test('updater progress uses a readable status and no interactive controls', () => {
  for (const message of ['Checking for updates…', 'Installing update…']) {
    const dom = new JSDOM(pug.renderFile('ui/update-progress.pug', {message}));
    const { document } = dom.window;
    const status = document.querySelector('[role="status"]');
    assert.equal(status.textContent, message);
    assert.equal(status.querySelector('.spinner').getAttribute('aria-hidden'), 'true');
    assert.ok(document.querySelector('link[href="update-progress.css"]'));
    assert.equal(document.querySelector('script, button, input, a'), null);
    dom.window.close();
  }
});
