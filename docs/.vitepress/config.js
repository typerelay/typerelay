// Navigation and OpenAPI integration adapted from Mailtwine (AGPL-3.0).
import { defineConfig } from 'vitepress';
import { useSidebar } from 'vitepress-openapi';
import { tabsMarkdownPlugin } from 'vitepress-plugin-tabs';
import spec from './data/openapi.json' with { type: 'json' };
const openapi = useSidebar({ spec, linkPrefix: '/api/operations/' });
const base = process.env.TYPERELAY_DOCS_BASE || '/docs/';
const sections = {"guide": ["Guide", [["index", "Introduction"], ["getting-started", "Getting started"], ["accounts", "Accounts and sign-in"], ["libraries", "Libraries and sharing"], ["teams", "Teams and roles"], ["snippets", "Text and code snippets"], ["templates", "Template variables"], ["sync", "Sync and offline use"], ["imports", "Import and export"], ["trash", "Trash"], ["settings", "Settings"], ["statistics", "Statistics"]]], "desktop": ["Desktop", [["index", "Overview"], ["installation", "Installation"], ["omarchy", "Omarchy install/uninstall"], ["panel", "Search panel"], ["platforms", "Operating system notes"], ["sync", "Desktop sync"], ["troubleshooting", "Troubleshooting"]]], "cli": ["CLI/TUI", [["index", "Command line"], ["tui", "Terminal editor"]]], "cloud": ["Cloud", [["index", "Hosted deployment status"], ["billing", "Billing and white-label"]]], "selfhosted": ["Self-Hosted", [["index", "Development and deployment"], ["configuration", "Configuration"], ["admin", "Backend administration"]]], "mcp": ["MCP", [["index", "Overview"], ["setup", "Setup"], ["tools", "Tools"], ["agents", "Agent configuration"]]], "api": ["API", [["index", "Overview"], ["authentication", "Authentication"], ["workflows", "Workflows"], ["errors", "Errors and limits"]]]};
export default defineConfig({ title: 'TypeRelay Docs', description: 'TypeRelay snippets, desktop clients, API and MCP', base, cleanUrls: true,
 srcExclude: ['README.md', 'VERIFICATION.md', 'AGENTS.md', 'development/**', 'web/**', 'mobile/**', 'desktop/delivery.md', 'desktop/code-snippets.md'],
 head: [['link', { rel: 'icon', href: base + 'favicon.ico' }]],
 transformPageData(page) { if (page.params?.pageTitle) { page.title = page.params.pageTitle; page.titleTemplate = false; page.description = page.params.pageDescription; } },
 markdown: { config(md) { md.use(tabsMarkdownPlugin); } },
 themeConfig: { nav: Object.entries(sections).map(([key, section]) => ({ text: section[0], link: '/' + key + '/' })),
 sidebar: Object.fromEntries(Object.entries(sections).map(([key, section]) => ['/' + key + '/', [{ text: section[0], items: section[1].map(([slug, text]) => ({ text, link: '/' + key + '/' + (slug === 'index' ? '' : slug) })) }, ...(key === 'api' ? [{ text: 'OpenAPI', items: openapi.generateSidebarGroups().slice().sort((a,b) => a.text.localeCompare(b.text)).map(group => ({ ...group, collapsed: true })) }] : [])]])),
 search: { provider: 'local' }, logo: '/favicon.ico' }
});
