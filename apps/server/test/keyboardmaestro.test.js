import test from 'node:test';
import assert from 'node:assert/strict';
import { Libraries } from '../services/libraries.js';
import { RichText } from '../services/rich_text.js';
import { KeyboardMaestroFixture as KM } from './fixtures/keyboardmaestro.js';

test('Keyboard Maestro merges group IDs and retains names, order, text and stable keys', async () => {
	const source = KM.xml([KM.group([KM.macro('first', '\tHéllo\r\n世界  ')]), KM.group([KM.macro('other')], { UID: 'second-group', Name: 'Other/group' }), KM.group([KM.macro('last', 'Copy', { Triggers: [] })])]);
	const { entries } = await Libraries.previewImport('keyboardmaestro', { source });
	assert.deepEqual(entries.map(entry => entry.key), ['group:first', 'group:last', 'second-group:other']);
	assert.deepEqual(entries.map(entry => entry.folder), ['group', 'group', 'second-group']);
	assert.equal(entries[0].title, 'first'); assert.equal(entries[0].trigger, 'first'); assert.equal(entries[0].original_trigger, ';first');
	assert.equal(entries[0].content.text, '\tHéllo\n世界  '); assert.equal(entries[1].trigger, null); assert.equal(entries[2].name, 'Other∕group');
	assert.ok(entries.every(entry => !entry.error && !entry.review));
});

test('Keyboard Maestro skips automation, complex and display-only actions with reasons', async () => {
	const macros = [KM.macro('complex', '', { Actions: [KM.macro().Actions[0], { MacroActionType: 'Pause' }] }), KM.macro('script', '', { Actions: [{ MacroActionType: 'ExecuteShellScript', Text: 'do not run' }] }), KM.macro('display', '', { Actions: [{ MacroActionType: 'InsertText', Action: 'DisplayWindow', Text: 'display' }] })];
	const preview = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group(macros)]) });
	assert.deepEqual(preview.entries, []); assert.equal(preview.warnings.length, 3);
	for (const [index, macro] of macros.entries()) assert.ok(preview.warnings[index].includes(macro.Name));
});

test('Keyboard Maestro handles unsupported triggers and review-only restrictions', async () => {
	const ordinary = KM.macro().Triggers[0];
	const macros = [KM.macro('regex', 'Text', { Triggers: [{ ...ordinary, TypedString: '[a-z]+', RegularExpression: true }] }), KM.macro('multiple', 'Text', { Triggers: [ordinary, ordinary] }), KM.macro('hotkey', 'Text', { Triggers: [{ MacroTriggerType: 'HotKey' }] }), KM.macro('no-delete', 'Text', { Triggers: [{ ...ordinary, SimulateDeletes: false }] }), KM.macro('disabled', 'Text', { IsActive: false }), KM.macro('target', 'Text', { Actions: [{ ...KM.macro().Actions[0], TargetingType: 'Specific' }] }), KM.macro('disabled-action', 'Text', { Actions: [{ ...KM.macro().Actions[0], IsActive: false }] })];
	const { entries } = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group(macros), KM.group([KM.macro('restricted')], { UID: 'restricted', Targeting: { Targeting: 'Included' } }), KM.group([KM.macro('inactive-group')], { UID: 'inactive', IsActive: false }), KM.group([KM.macro('palette')], { UID: 'palette', Activate: 'OnceWithPalette' })]) });
	assert.ok(entries.every(entry => entry.trigger === null && entry.warnings.length > 0));
	assert.ok(entries.slice(0, 4).every(entry => !entry.review));
	assert.ok(entries.slice(4).every(entry => entry.review && entry.title.endsWith('(Needs review)')));
	const repeated = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group([KM.macro('one')]), KM.group([KM.macro('two')], { IsActive: false })]) });
	assert.ok(repeated.entries.every(entry => entry.review));
});

test('Keyboard Maestro rich text imports Apple RTFD formatting, Unicode and image references', async () => {
	const macro = KM.macro('rich', '', { Actions: [{ MacroActionType: 'InsertText', Action: 'ByPasting', Text: 'Bold λ', StyledText: KM.native }] });
	const { entries: [entry] } = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group([macro])]) });
	assert.equal(entry.error, undefined); assert.equal(entry.content.type, 'rich_text');
	assert.match(entry.content.text, /Bold λ/); assert.doesNotMatch(entry.content.text, /pixel.png|;;|¬/);
	assert.match(entry.content.markdown, /<strong>Bold λ/); assert.match(entry.content.markdown, /data:image\/png;base64/);
	assert.equal(entry.trigger, 'rich');
	const typing = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group([KM.macro('typing', '{\\rtf1 literal}', { Actions: [{ ...macro.Actions[0], Action: 'ByTyping', Text: '{\\rtf1 literal}' }] })])]) });
	assert.equal(typing.entries[0].content.type, 'plain_text'); assert.equal(typing.entries[0].content.text, '{\\rtf1 literal}');
});

test('Keyboard Maestro dynamic tokens in either plain or styled source stay literal Code', async () => {
	const tokens = ['%CurrentClipboard%', '%ICUDateTime%yyyy-MM-dd%', '%Variable%Name%', '%TriggerValue%'];
	const macros = tokens.map((text, index) => KM.macro('token-' + index, text));
	macros.push(KM.macro('styled-token', 'Plain source', { Actions: [{ MacroActionType: 'InsertText', Action: 'ByPasting', Text: 'Plain source', StyledText: Buffer.from('{\\rtf1 \\b %Variable%Name%}') }] }));
	macros.push(KM.macro('plain-token', '', { Actions: [{ MacroActionType: 'InsertText', Action: 'ByPasting', Text: '%CurrentClipboard%', StyledText: Buffer.from('{\\rtf1 Static}') }] }));
	const { entries } = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group(macros)]) });
	assert.ok(entries.every(entry => entry.review && entry.trigger === null && entry.content.type === 'code' && !entry.error));
	for (const [index, token] of tokens.entries()) assert.equal(entries[index].content.text, token);
	assert.match(entries[4].content.text, /%Variable%Name%/); assert.match(entries[5].content.text, /%CurrentClipboard%/);
});

test('styled imports warn for omitted attachments and reject malformed containers per row', async () => {
	const data = KM.rtfd({ 'TXT.rtf': '{\\rtf1 Keep {\\NeXTGraphic doc.pdf \\width20}{\\NeXTGraphic missing.png \\height20}}', 'doc.pdf': '%PDF-unsupported', 'unused.txt': 'unused' });
	const result = await RichText.styled({ base64: data.toString('base64') });
	assert.match(result.html, /Keep/); assert.ok(result.warnings.some(warning => warning.includes('doc.pdf'))); assert.ok(result.warnings.some(warning => warning.includes('missing.png'))); assert.ok(result.warnings.some(warning => warning.includes('unused.txt')));
	for (const bad of [Buffer.from('unknown'), KM.native.subarray(0, 30), Buffer.concat([KM.native, Buffer.from('extra')]), KM.rtfd({ '../bad': 'x', 'TXT.rtf': '{\\rtf1 X}' }), KM.rtfd({ 'other.rtf': '{\\rtf1 X}' }), Buffer.from('{\\rtf1 Unclosed')]) {
		const macro = KM.macro('bad', '', { Actions: [{ MacroActionType: 'InsertText', Action: 'ByPasting', Text: 'Do not silently fall back', StyledText: bad }] });
		const { entries: [entry] } = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group([macro])]) });
		assert.match(entry.error, /Styled text could not be imported/);
	}
	await assert.rejects(RichText.styled({ base64: 'not base64!' }), /base64/);
});

test('RTF supports Unicode fallback lengths, embedded pictures and ignored destinations', async () => {
	const value = '{\\rtf1{\\*\\unknown hidden}\\uc0\\u955 X\\uc1\\u233?Y\\par{\\pict\\pngblip ' + KM.png.toString('hex') + '}}';
	const { html } = await RichText.styled({ base64: Buffer.from(value).toString('base64') });
	assert.match(html, /λXéY/); assert.doesNotMatch(html, /hidden/); assert.match(html, /data:image\/png;base64/);
});

test('Keyboard Maestro rejects invalid structure, duplicates, XML attacks and excessive imports', async () => {
	for (const source of ['bplist00', '<plist><array>', '<!DOCTYPE plist [<!ENTITY x SYSTEM "file:///etc/passwd">]><plist><array/></plist>', KM.xml({}), KM.xml([{}]), KM.xml([KM.group([KM.macro(), KM.macro()])]), KM.xml([KM.group(Array.from({ length: 1001 }, (_, index) => KM.macro('m' + index)))]), KM.xml(Array.from({ length: 257 }, (_, index) => KM.group([], { UID: 'g' + index })))]) await assert.rejects(Libraries.previewImport('keyboardmaestro', { source }));
	await assert.rejects(Libraries.previewImport('keyboardmaestro', { source: 'x'.repeat(8 * 1048576) }), /8 MiB/);
	await assert.rejects(Libraries.previewImport('keyboardmaestro', { source: '<plist>' + '<array>'.repeat(32) + '</array>'.repeat(32) + '</plist>' }), /nesting/);
	const { entries: [entry] } = await Libraries.previewImport('keyboardmaestro', { source: KM.xml([KM.group([KM.macro('invalid', 'Text', { Triggers: [{ MacroTriggerType: 'TypedString', TypedString: ';UPPER', SimulateDeletes: true }] })])]) });
	assert.ok(entry.trigger_error);
});
