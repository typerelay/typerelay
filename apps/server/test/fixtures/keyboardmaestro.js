import { readFileSync } from 'node:fs';

export class KeyboardMaestroFixture {
	static png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
	static native = Buffer.from(readFileSync(new URL('./keyboardmaestro-apple-rtfd.base64', import.meta.url), 'utf8').trim(), 'base64');
	static xml(value) {
		const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
		const encode = value => Buffer.isBuffer(value) ? '<data>' + value.toString('base64') + '</data>' : Array.isArray(value) ? '<array>' + value.map(encode).join('') + '</array>' : typeof value === 'boolean' ? '<' + value + '/>' : typeof value === 'object' && value ? '<dict>' + Object.entries(value).map(([key, item]) => '<key>' + escape(key) + '</key>' + encode(item)).join('') + '</dict>' : '<string>' + escape(value) + '</string>';
		return '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">' + encode(value) + '</plist>';
	}
	static macro(id = 'macro', text = 'Hello', extra = {}) { return { UID: id, Name: id, Actions: [{ MacroActionType: 'InsertText', Action: 'ByTyping', Text: text }], Triggers: [{ MacroTriggerType: 'TypedString', TypedString: ';' + id, SimulateDeletes: true }], ...extra }; }
	static group(macros, extra = {}) { return { UID: 'group', Name: 'Imported group', Activate: 'Normal', Macros: macros, ...extra }; }
	static rtfd(files) {
		const integer = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
		const entries = Object.entries(files).map(([name, data]) => [Buffer.from(name), Buffer.isBuffer(data) ? data : Buffer.from(data)]);
		return Buffer.concat([Buffer.from('rtfd'), integer(0), integer(3), integer(entries.length), ...entries.flatMap(([name]) => [integer(name.length), name]), ...entries.map(([, data]) => integer(data.length + 8)), ...entries.flatMap(([, data]) => [integer(1), integer(data.length), data])]);
	}
}
