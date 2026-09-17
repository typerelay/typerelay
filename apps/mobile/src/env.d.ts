declare module '*.pug' { const template: (locals?: Record<string, any>) => string; export default template; }
declare module '@server/browser/rich-editor.js' { export const RichEditor: any; }
declare module '@server/public/template-editor.js' { export const TemplateEditor: any; }
