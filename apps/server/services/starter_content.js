import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Assets } from './assets.js';
import { Billing } from './billing.js';
import { Libraries } from './libraries.js';

export class StarterContent {
	static async create(account, user, session) {
		const ctx = { account: String(account._id), user: String(user._id), role: 'owner', groups: [], plan: account.plan || 'free', entitlements: Billing.entitlements(account) };
		const source = await readFile(fileURLToPath(new URL('../public/typerelay-icon.svg', import.meta.url)));
		const icon = await Assets.put(ctx, await sharp(source).resize(96, 96).png().toBuffer(), '', session);
		return Libraries.create(ctx, { name: 'My snippets', snippets: StarterContent.snippets(icon.id) }, session);
	}

	static snippets(icon) {
		return [
			{ title: 'Personalized welcome', trigger: 'welcome', content: { version: 1, type: 'template', text: 'Welcome {{name}}! It’s great to see you here.', variables: { name: { label: 'Name', required: true } } } },
			{ title: 'JavaScript example', trigger: 'jslog', content: { version: 1, type: 'code', language: 'javascript', text: "const greeting = name => `Welcome, ${name}!`;\nconsole.log(greeting('TypeRelay'));" } },
			{ title: 'Rich text example', trigger: 'rich', content: { version: 2, type: 'rich_text', markdown: `![TypeRelay icon](typerelay-asset:${icon})\n\n# Welcome to TypeRelay\n\nCreate **rich text** snippets with *formatting*, links, and lists.\n\n- Keep reusable content consistent\n- Add images and tables\n- Paste into apps with rich formatting\n\n[Explore TypeRelay](https://typerelay.com/)`, variables: {} } },
			{ title: 'Email signature', trigger: 'sig', content: { version: 1, type: 'template', text: 'Best,\n{{name}}\n{{role}}', variables: { name: { label: 'Name', required: true }, role: { label: 'Role', required: false } } } },
			{ title: 'Status update', trigger: 'status', content: { version: 1, type: 'template', text: 'Status update — {{date}}\n\nCompleted:\n{{completed}}\n\nNext:\n{{next}}\n\nBlockers:\n{{blockers}}', variables: { date: { format: 'YYYY-MM-DD', timezone: 'local' }, completed: { label: 'Completed', required: true, multiline: true }, next: { label: 'Next', required: true, multiline: true }, blockers: { label: 'Blockers', required: false, multiline: true } } } },
			{ title: 'TypeRelay support response', trigger: 'support', content: { version: 2, type: 'rich_text', markdown: '<p>Hi {{name}},</p>\n\n<p>Thanks for contacting <strong>TypeRelay Support</strong>. These resources should help you get the most from TypeRelay:</p>\n\n<ul>\n<li>Visit <a href="https://typerelay.com/">TypeRelay</a> for an overview.</li>\n<li>Browse the <a href="https://docs.typerelay.com/">TypeRelay documentation</a> for setup and everyday use.</li>\n<li>Explore <a href="https://docs.typerelay.com/mcp/">MCP and advanced use</a> for integrations and agent workflows.</li>\n</ul>\n\n<p>If you still need help, <a href="https://app.typerelay.com/">sign in to TypeRelay</a> and open the in-app chat. We’re happy to help.</p>\n\n<p>Best,<br><strong>TypeRelay Support</strong></p>', variables: { name: { label: 'Customer name', required: true } } } },
		];
	}
}
