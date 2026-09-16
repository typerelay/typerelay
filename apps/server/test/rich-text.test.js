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

test('remote image host filtering blocks private and special addresses', () => {
	for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(Assets.privateIp(address), true, address);
	for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(Assets.privateIp(address), false, address);
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
