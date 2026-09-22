import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import spec from '../.vitepress/data/openapi.json' with { type: 'json' };
const ids = new Set();
for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods)) {
 if (ids.has(operation.operationId)) throw new Error('Duplicate operationId'); ids.add(operation.operationId);
 const path = '.vitepress/dist/api/operations/' + operation.operationId + '.html';
 if (!existsSync(path)) throw new Error('Missing operation page: ' + path);
}

const distRoot = resolve('.vitepress/dist');
const htmlFiles = readdirSync(distRoot, { recursive: true }).filter(path => path.endsWith('.html') && path !== '404.html');
const titles = new Map();
const descriptions = new Map();
const metadataErrors = [];
for (const path of htmlFiles) {
 const html = readFileSync(resolve(distRoot, path), 'utf8');
 const titleMatches = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
 const descriptionMatches = [...html.matchAll(/<meta name="description" content="([^"]*)"/g)];
 if (titleMatches.length !== 1 || !titleMatches[0]?.[1].trim()) metadataErrors.push(`${path}: expected one non-empty title`);
 else { const title = titleMatches[0][1].trim(); titles.set(title, [...(titles.get(title) || []), path]); }
 if (descriptionMatches.length !== 1 || !descriptionMatches[0]?.[1].trim()) metadataErrors.push(`${path}: expected one non-empty meta description`);
 else { const description = descriptionMatches[0][1].trim(); descriptions.set(description, [...(descriptions.get(description) || []), path]); if (description === 'TypeRelay snippets, desktop clients, API and MCP') metadataErrors.push(`${path}: inherited the generic site description`); }
}
for (const [title, paths] of titles) if (paths.length > 1) metadataErrors.push(`duplicate title "${title}": ${paths.join(', ')}`);
for (const [description, paths] of descriptions) if (paths.length > 1) metadataErrors.push(`duplicate description "${description}": ${paths.join(', ')}`);
if (metadataErrors.length) throw new Error('Documentation metadata validation failed:\n' + metadataErrors.join('\n'));

const docsRoot = resolve('.');
const repoRoot = resolve('..');
const markdown = [resolve(repoRoot, 'README.md')];
const pending = [docsRoot];
while (pending.length) {
 const directory = pending.pop();
 for (const name of readdirSync(directory)) {
  if (['node_modules', '.vitepress'].includes(name)) continue;
  const path = resolve(directory, name);
  if (statSync(path).isDirectory()) pending.push(path);
  else if (name.endsWith('.md')) markdown.push(path);
 }
}
const broken = [];
for (const source of markdown) {
 const text = readFileSync(source, 'utf8');
 for (const match of text.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
  const raw = match[1].trim().replace(/^<|>$/g, '');
  if (!raw || /^(?:[a-z]+:|#|\/)/i.test(raw)) continue;
  const clean = decodeURIComponent(raw.split('#')[0].split('?')[0]);
  const target = resolve(dirname(source), clean);
  const publicTarget = target.startsWith(docsRoot) ? resolve(docsRoot, 'public', relative(docsRoot, target)) : '';
  if (![target, target + '.md', resolve(target, 'index.md'), publicTarget].some(candidate => candidate && existsSync(candidate))) broken.push(`${relative(repoRoot, source)} -> ${raw}`);
 }
}
if (broken.length) throw new Error('Broken local documentation links:\n' + broken.join('\n'));
console.log('Verified ' + ids.size + ' generated API pages, unique metadata for ' + htmlFiles.length + ' pages, and links across ' + markdown.length + ' Markdown files');
