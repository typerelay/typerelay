import { Editor, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { RichTextRuntime } from '../public/rich-text-runtime.js';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';

const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const inlineHtml = nodes => (nodes || []).map(node => { if (node.type === 'hardBreak') return '<br>'; let value = escapeHtml(node.text || ''); for (const mark of node.marks || []) { if (mark.type === 'bold') value = `<strong>${value}</strong>`; else if (mark.type === 'italic') value = `<em>${value}</em>`; else if (mark.type === 'underline') value = `<u>${value}</u>`; else if (mark.type === 'strike') value = `<s>${value}</s>`; else if (mark.type === 'code') value = `<code>${value}</code>`; else if (mark.type === 'link') value = `<a href="${escapeHtml(mark.attrs?.href || '')}" title="${escapeHtml(mark.attrs?.title || '')}">${value}</a>`; } return value; }).join('');
const AlignedParagraph = Paragraph.extend({ renderMarkdown: (node, helpers) => node.attrs?.textAlign && node.attrs.textAlign !== 'left' ? `<p style="text-align:${node.attrs.textAlign}">${inlineHtml(node.content)}</p>` : helpers.renderChildren(node.content || []) });
const AlignedHeading = Heading.extend({ renderMarkdown: (node, helpers) => node.attrs?.textAlign && node.attrs.textAlign !== 'left' ? `<h${node.attrs.level} style="text-align:${node.attrs.textAlign}">${inlineHtml(node.content)}</h${node.attrs.level}>` : `${'#'.repeat(Number(node.attrs?.level) || 1)} ${helpers.renderChildren(node.content || [])}` });
const encodeRaw = value => { let binary = ''; for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte); return window.btoa(binary); };
const decodeRaw = value => new TextDecoder().decode(Uint8Array.from(window.atob(value), character => character.charCodeAt(0)));
const protectRaw = markdown => markdown.replace(/^(<(?!p\b|h[1-6]\b|u\b|s\b|del\b|strong\b|em\b|a\b|code\b|br\b)([a-z][\w:-]*)\b[\s\S]*?<\/\2>|<img\b[^>]*>)(?=\n{2,}|$)/gim, value => `<pre data-raw-html="true" data-content="${encodeRaw(value)}"></pre>`);
const restoreRaw = markdown => markdown.replace(/<pre data-raw-html="true" data-content="([A-Za-z0-9+/=]+)"><\/pre>/g, (match, value) => decodeRaw(value));

const RawHtml = Node.create({
	name: 'rawHtml', group: 'block', atom: true, selectable: true, priority: 1000,
	addAttributes() { return { html: { default: '' } }; },
	parseHTML() { return [{ tag: 'pre[data-raw-html][data-content]', getAttrs: node => ({ html: decodeRaw(node.dataset.content || '') }) }]; },
	renderHTML({ HTMLAttributes }) { return ['pre', mergeAttributes({ 'data-raw-html': 'true', 'data-content': encodeRaw(HTMLAttributes.html || ''), class: 'rich-raw-html' }), HTMLAttributes.html]; },
	renderMarkdown: node => `<pre data-raw-html="true" data-content="${encodeRaw(node.attrs.html || '')}"></pre>`,
});

const AssetImage = Image.extend({
	renderHTML({ HTMLAttributes }) {
		const source = String(HTMLAttributes.src || '');
		const id = source.startsWith('typerelay-asset:') ? source.slice(16) : '';
		const account = document.querySelector('#workspace')?.dataset.account || '';
		return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, id ? { src: `/snippet-assets/${account}/${id}`, 'data-asset': id } : {})];
	},
});

export class RichEditor {
	constructor(field, host, toolbar, options = {}) {
		this.field = field; this.host = host; this.toolbar = toolbar; this.options = options; this.source = false;
		this.editor = new Editor({
			element: host,
			extensions: [StarterKit.configure({ underline: false, paragraph: false, heading: false, codeBlock: {}, link: { openOnClick: false } }), AlignedParagraph, AlignedHeading, Markdown, Underline, TextAlign.configure({ types: ['heading', 'paragraph'] }), AssetImage.configure({ inline: true, allowBase64: false, resize: { enabled: true, minWidth: 32, minHeight: 32, alwaysPreserveAspectRatio: true } }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: true } }), RawHtml],
			content: protectRaw(field.value),
			contentType: 'markdown',
			editable: !options.readonly,
			onUpdate: ({ editor }) => { field.value = restoreRaw(editor.getMarkdown()); field.dispatchEvent(new Event('input', { bubbles: true })); this.refresh(); },
			onSelectionUpdate: () => this.refresh(),
		});
		field.hidden = true; host.hidden = false; toolbar.hidden = false;
		toolbar.addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
		toolbar.addEventListener('click', event => this.command(event).catch(error => options.onError?.(error)));
		toolbar.querySelector('[data-rich-heading]').addEventListener('change', event => { const level = Number(event.target.value); if (level) this.editor.chain().focus().toggleHeading({ level }).run(); else this.editor.chain().focus().setParagraph().run(); });
		host.addEventListener('paste', event => { if ([...(event.clipboardData?.files || [])].some(file => file.type.startsWith('image/'))) { event.preventDefault(); this.files(event.clipboardData.files).catch(error => options.onError?.(error)); } });
		host.addEventListener('drop', event => { if ([...(event.dataTransfer?.files || [])].some(file => file.type.startsWith('image/'))) { event.preventDefault(); this.files(event.dataTransfer.files).catch(error => options.onError?.(error)); } });
		this.refresh();
	}
	async files(files) { for (const file of files || []) if (file.type.startsWith('image/')) { const asset = await this.options.upload(file); this.editor.chain().focus().setImage({ src: `typerelay-asset:${asset.id}`, alt: file.name }).run(); } }
	async command(event) {
		const button = event.target.closest('[data-rich-command]'); if (!button || this.options.readonly) return;
		const chain = this.editor.chain().focus(); const command = button.dataset.richCommand;
		if (command === 'bold') chain.toggleBold().run();
		else if (command === 'italic') chain.toggleItalic().run();
		else if (command === 'underline') chain.toggleUnderline().run();
		else if (command === 'strike') chain.toggleStrike().run();
		else if (command === 'code') chain.toggleCode().run();
		else if (command === 'bulletList') chain.toggleBulletList().run();
		else if (command === 'orderedList') chain.toggleOrderedList().run();
		else if (command === 'taskList') chain.toggleTaskList().run();
		else if (command === 'blockquote') chain.toggleBlockquote().run();
		else if (command === 'codeBlock') chain.toggleCodeBlock().run();
		else if (command === 'horizontalRule') chain.setHorizontalRule().run();
		else if (command.startsWith('align-')) chain.setTextAlign(command.slice(6)).run();
		else if (command === 'undo') chain.undo().run();
		else if (command === 'redo') chain.redo().run();
		else if (command === 'clear') chain.unsetAllMarks().clearNodes().run();
		else if (command === 'table') chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
		else if (command === 'row') chain.addRowAfter().run();
		else if (command === 'column') chain.addColumnAfter().run();
		else if (command === 'deleteTable') chain.deleteTable().run();
		else if (command === 'source') this.toggleSource();
		else if (command === 'link') await this.link();
		else if (command === 'image') await this.image();
		else if (command === 'refreshImage') await this.refreshImage();
		else if (command === 'html') await this.html();
		this.refresh();
	}
	async link() { const previous = this.editor.getAttributes('link').href || ''; const result = await Swal.fire({ title: previous ? 'Edit link' : 'Add link', input: 'url', inputLabel: 'URL', inputValue: previous, showCancelButton: true, target: document.querySelector('#form-modal') }); if (!result.isConfirmed) return; const href = String(result.value || '').trim(); if (href) this.editor.chain().focus().extendMarkRange('link').setLink({ href }).run(); else this.editor.chain().focus().extendMarkRange('link').unsetLink().run(); }
	async image() { const modalElement = document.querySelector('#rich-image-modal'); const form = document.querySelector('#rich-image-form'); form.reset(); document.querySelector('#rich-image-width').value = '640'; const editorModal = document.querySelector('#form-modal'); const restore = editorModal.classList.contains('show'); if (restore) await new Promise(resolve => { editorModal.addEventListener('hidden.bs.modal', resolve, { once: true }); bootstrap.Modal.getInstance(editorModal).hide(); }); const modal = bootstrap.Modal.getOrCreateInstance(modalElement); const result = await new Promise(resolve => { const finish = value => { form.removeEventListener('submit', submit); modalElement.removeEventListener('hidden.bs.modal', cancel); resolve(value); }; const cancel = () => finish(null); const submit = async event => { event.preventDefault(); const button = event.submitter; if (button) button.disabled = true; try { const file = document.querySelector('#rich-image-file').files[0]; const url = document.querySelector('#rich-image-url').value.trim(); if (!file && !url) throw new Error('Choose a file or enter a remote URL'); const asset = file ? await this.options.upload(file) : await this.options.remote(url); finish({ asset, alt: document.querySelector('#rich-image-alt').value, title: document.querySelector('#rich-image-title').value, placement: document.querySelector('#rich-image-placement').value, width: Number(document.querySelector('#rich-image-width').value) }); modal.hide(); } catch (error) { this.options.onError?.(error); } finally { if (button) button.disabled = false; } }; form.addEventListener('submit', submit); modalElement.addEventListener('hidden.bs.modal', cancel, { once: true }); modal.show(); }); if (restore) bootstrap.Modal.getOrCreateInstance(editorModal).show(); if (!result) return; const source = `typerelay-asset:${result.asset.id}`; if (result.placement === 'inline' && result.width === 640) this.editor.chain().focus().setImage({ src: source, alt: result.alt, title: result.title }).run(); else { const image = document.querySelector('#rich-image-html-template').content.firstElementChild.cloneNode(); image.src = source; image.alt = result.alt; image.title = result.title; image.width = result.width; image.dataset.placement = result.placement; this.editor.chain().focus().insertContent({ type: 'rawHtml', attrs: { html: image.outerHTML } }).run(); } }
	async refreshImage() { const source = String(this.editor.getAttributes('image').src || ''); if (!source.startsWith('typerelay-asset:')) throw new Error('Select a cached remote image first'); const asset = await this.options.refresh(source.slice(16)); this.editor.chain().focus().updateAttributes('image', { src: `typerelay-asset:${asset.id}` }).run(); }
	async html() { const previous = this.editor.isActive('rawHtml') ? this.editor.getAttributes('rawHtml').html : ''; const result = await Swal.fire({ title: previous ? 'Edit raw HTML' : 'Insert raw HTML', input: 'textarea', inputLabel: 'HTML is preserved and sanitized when rendered', inputValue: previous, showCancelButton: true, confirmButtonText: 'Apply', target: document.querySelector('#form-modal'), preConfirm: async value => { try { await RichTextRuntime.render({ markdown: String(value || '') }, {}, true); return String(value || ''); } catch (error) { Swal.showValidationMessage(error.message); return false; } } }); if (!result.isConfirmed) return; if (previous) this.editor.chain().focus().updateAttributes('rawHtml', { html: String(result.value || '') }).run(); else this.editor.chain().focus().insertContent({ type: 'rawHtml', attrs: { html: String(result.value || '') } }).run(); }
	toggleSource() { if (this.source) { this.editor.commands.setContent(protectRaw(this.field.value), { contentType: 'markdown' }); this.field.hidden = true; this.host.hidden = false; } else { this.field.value = restoreRaw(this.editor.getMarkdown()); this.host.hidden = true; this.field.hidden = false; this.field.focus(); } this.source = !this.source; }
	insertText(value) { this.editor.chain().focus().insertContent(value, { contentType: 'markdown' }).run(); }
	content() { if (!this.source) this.field.value = restoreRaw(this.editor.getMarkdown()); return this.field.value; }
	setReadonly(readonly) { this.options.readonly = readonly; this.editor.setEditable(!readonly); }
	refresh() { for (const button of this.toolbar.querySelectorAll('[data-rich-command]')) { const command = button.dataset.richCommand; const active = ['bold', 'italic', 'underline', 'strike', 'code', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'].includes(command) && this.editor.isActive(command); button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); } }
	destroy() { this.editor.destroy(); this.field.hidden = false; this.host.replaceChildren(); this.toolbar.hidden = true; }
}
