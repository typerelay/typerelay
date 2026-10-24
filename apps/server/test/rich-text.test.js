import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RichText } from '../services/rich_text.js';
import { Assets } from '../services/assets.js';

test('shared rich-text WASM derives canonical fields and sanitizes raw HTML', () => {
	const content = RichText.content({ version: 2, type: 'rich_text', markdown: '# Heading\n\n<u onclick="bad()">safe</u>\n\n| A | B |\n|---|---|\n| C | D |\n\n<script>bad()</script>', variables: {} });
	assert.equal(content.version, 2);
	assert.equal(content.type, 'rich_text');
	assert.match(content.text, /Heading/);
	assert.deepEqual(content.assets, []);
	const rendered = RichText.render(content);
	assert.match(rendered.html, /<table>/);
	assert.match(rendered.html, /<u>safe<\/u>/);
	assert.doesNotMatch(rendered.html, /onclick|<script/);
	assert.match(rendered.rtf, /^\{\\rtf1/);
});

test('rich-text derivation rejects active links and inline key actions', () => {
	assert.throws(() => RichText.content({ version: 2, type: 'rich_text', markdown: '[bad](javascript:alert(1))' }), /Links must use/);
	assert.throws(() => RichText.content({ version: 2, type: 'rich_text', markdown: 'before {{key:enter}} after' }), /own line/);
});

test('image normalization strips metadata, constrains formats and hashes stored bytes', async () => {
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
	const asset = await Assets.normalize(png);
	assert.equal(asset.mime_type, 'image/png');
	assert.equal(asset.width, 1);
	assert.equal(asset.height, 1);
	assert.equal(asset.id, Assets.id(asset.data));
	assert.ok(asset.size <= Assets.maximumStored);
	await assert.rejects(Assets.normalize(Buffer.from('<svg onload="bad()"></svg>')), /Upload a PNG/);
});

test('remote image host filtering blocks private and special addresses', async () => {
	for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '192.0.0.8', '::1', 'fd00::1', 'fe80::1', 'fec0::1', 'feff::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '::127.0.0.1', '::7f00:1', '::10.0.0.1', '198.18.0.1', '198.19.255.255', '192.88.99.1', '2001:0:4136:e378::1', '100::1']) assert.equal(Assets.privateIp(address), true, address);
	for (const address of ['8.8.8.8', '1.1.1.1', '192.0.2.1', '198.17.0.1', '198.20.0.1', '192.88.98.1', '2001:db8::1', '2606:4700:4700::1111']) assert.equal(Assets.privateIp(address), false, address);
	// URL hostnames keep the IPv6 brackets; they must still be recognised as addresses.
	for (const url of ['http://[::1]/a.png', 'http://[64:ff9b::7f00:1]/a.png', 'http://[2002:7f00:1::]/a.png', 'http://[fec0::1]/a.png', 'http://192.0.0.8/a.png']) await assert.rejects(Assets.publicHost(new URL(url)), error => error.status === 400 && /not public/.test(error.message), url);
});

test('RTF imports formatting, paragraphs, Unicode and embedded pictures as rich HTML', () => {
	const source = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\b Bold\b0  \i italic\i0  \ul under\ulnone\par Unicode \u955?\par {\pict\pngblip 89504e470d0a1a0a}}`;
	const html = RichText.rtf(source);
	assert.match(html, /<strong>Bold<\/strong>/);
	assert.match(html, /<em>italic<\/em>/);
	assert.match(html, /<u>under<\/u>/);
	assert.match(html, /λ/);
	assert.match(html, /data:image\/png;base64/);
});

test('rich editor is Pug-backed and contains the complete document controls', () => {
	const form = readFileSync(new URL('../views/ajax/form.pug', import.meta.url), 'utf8');
	const toolbar = readFileSync(new URL('../views/ajax/rich-editor.pug', import.meta.url), 'utf8');
	const app = readFileSync(new URL('../views/app.pug', import.meta.url), 'utf8');
	assert.match(form, /option\(value="rich_text"/);
	assert.match(form, /include rich-editor/);
	assert.match(app, /#form-modal[\s\S]*?\.modal-dialog\.modal-xl\.modal-dialog-scrollable/);
	for (const command of ['bold', 'italic', 'underline', 'strike', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule', 'link', 'image', 'refreshImage', 'table', 'html', 'source']) assert.match(toolbar, new RegExp(`data-rich-command="${command}"`));
});


test('parsed Markdown and HTML images become private assets without changing unrelated source', async t => {
 const id = 'a'.repeat(64); const urls = [];
 t.mock.method(Assets, 'remote', async (ctx, url, session) => { assert.equal(session, null); urls.push(url); return { id }; });
 const forms = ['![pixel](<https://example.test/pixel?x=1&y=2>)', '![pixel][p]\n\n[p]: https://example.test/pixel?x=1&y=2', '<img alt="pixel" width="20" src=https://example.test/pixel>', '<div>before<img alt="pixel" src="https://example.test/pixel?x=1&amp;y=2">after</div>'];
 for (const form of forms) {
  const markdown = '😀 **before**\n\n' + form + '\n\n[ordinary](https://example.test/pixel?x=1&y=2)'; const prepared = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown }); const rendered = RichText.render(prepared);
  assert.deepEqual(rendered.assets, [id]); assert.match(rendered.html, /alt="pixel"/); assert.match(rendered.html, /<strong>before<\/strong>/); assert.doesNotMatch(rendered.html, /src="https:/); assert.match(prepared.markdown, /\[ordinary\]\(https:\/\/example.test\/pixel\?x=1&y=2\)/); assert.equal(urls.at(-1), form.includes('src=https:') ? 'https://example.test/pixel' : 'https://example.test/pixel?x=1&y=2');
 }
 assert.equal(urls.length, forms.length);
});
test('image discovery ignores code, deduplicates sources and handles embedded HTML images', async t => {
 const id = 'b'.repeat(64); t.mock.method(Assets, 'remote', async () => ({ id })); t.mock.method(Assets, 'put', async (ctx, bytes) => { assert.equal(bytes.toString(), 'image'); return { id }; });
 const literal = '`![x](https://example.test/code)`\n\n```html\n<img src=https://example.test/code>\n```';
 assert.equal((await RichText.prepare({}, { version: 2, type: 'rich_text', markdown: literal }, {})).markdown, literal);
 const prepared = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown: '![one](https://example.test/one) ![two](<https://example.test/one>) <img src="data:image/png;base64,aW1hZ2U=">' });
 assert.deepEqual(RichText.content(prepared).assets, [id]); assert.equal(Assets.remote.mock.callCount(), 1); assert.equal(Assets.put.mock.callCount(), 1);
});
test('every parsed remote image form obeys preflight and image-count limits', async t => {
 t.mock.method(Assets, 'remote', async () => assert.fail('must not fetch'));
 for (const markdown of ['![x](<https://example.test/x>)', '![x][ref]\n\n[ref]: https://example.test/x', '<img src=https://example.test/x>']) await assert.rejects(RichText.prepare({}, { version: 2, type: 'rich_text', markdown }, {}), /before starting/);
 const markdown = Array.from({ length: 17 }, (_, i) => `![x](<https://example.test/${i}>)`).join('\n'); await assert.rejects(RichText.prepare({}, { version: 2, type: 'rich_text', markdown }), /at most 16/);
});

test('image normalization preserves escaped template openers in labels and titles', async t => {
 t.mock.method(Assets, 'remote', async () => ({ id: 'c'.repeat(64) }));
 for (const markdown of [String.raw`![\{{name}}](https://example.test/image "\{{title}}")`, String.raw`![\{{name}}][ref]` + '\n\n' + String.raw`[ref]: https://example.test/image "\{{title}}"`]) { const prepared = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown }); const rendered = RichText.render({ ...prepared, preview: false }); assert.deepEqual(rendered.fields, []); assert.match(rendered.html, /alt="\{\{name\}\}"/); assert.match(rendered.html, /title="\{\{title\}\}"/); }
});

test('multiline raw HTML images are cached and obey the transaction guard', async t => {
 const id = 'd'.repeat(64); const markdown = '<div>\n<img\nsrc="https://example.test/pixel">\n</div>'; t.mock.method(Assets, 'remote', async () => ({ id }));
 await assert.rejects(RichText.prepare({}, { version: 2, type: 'rich_text', markdown }, {}), /before starting/);
 const content = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown }); assert.deepEqual(RichText.content(content).assets, [id]); assert.doesNotMatch(RichText.render(content).html, /src="https:/);
});
test('image titles retain literal entities and encoded blank lines', async t => {
 t.mock.method(Assets, 'remote', async () => ({ id: 'e'.repeat(64) }));
 for (const title of ['&amp;copy;', 'a&#10;&#10;b']) { const markdown = `![x](https://example.test/image "${title}")`; const before = RichText.render({ markdown }); const content = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown }); const rendered = RichText.render(content); assert.equal(rendered.html.replaceAll('typerelay-asset:' + 'e'.repeat(64), 'https://example.test/image'), before.html); }
});

test('URL-normalized and protocol-relative HTML images cannot bypass private caching', async t => {
 const urls = []; const id = 'f'.repeat(64); t.mock.method(Assets, 'remote', async (ctx, url) => { urls.push(url); return { id }; });
 for (const source of [' https://example.test/pixel ', 'https:&#10;//example.test/pixel', '//example.test/pixel']) { const markdown = `<img src="${source}">`; await assert.rejects(RichText.prepare({}, { version: 2, type: 'rich_text', markdown }, {}), /before starting/); const content = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown }); assert.deepEqual(RichText.content(content).assets, [id]); assert.equal(urls.at(-1), 'https://example.test/pixel'); }
});

test('multiline image tags keep their surrounding Markdown containers', async t => {
 const id = 'a'.repeat(64); t.mock.method(Assets, 'remote', async () => ({ id }));
 for (const markdown of ['> text <img\n> src="https://example.test/a">', '> <div>\r\n> <img\r\n> src="https://example.test/a">\r\n> </div>', '<div>😀before<img\nsrc="https://example.test/a">after</div>', '> <div>\n> <img\n> src="https://example.test/a">\n> </div>\n> tail', '- item\n\n  <div>\n  <img\n  src="https://example.test/a">\n  </div>\n\n  tail', '> > <div>\n> > <img\n> > src="https://example.test/a">\n> > </div>']) {
  await assert.rejects(RichText.prepare({}, { version: 2, type: 'rich_text', markdown }, {}), /before starting/); const before = RichText.render({ markdown }); const prepared = await RichText.prepare({}, { version: 2, type: 'rich_text', markdown }); const rendered = RichText.render(prepared); assert.deepEqual(rendered.assets, [id]); assert.equal(rendered.html.replaceAll('typerelay-asset:' + id, 'https://example.test/a'), before.html); }
});
