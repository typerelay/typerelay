import type { Library } from './types';

/** Applies an authoritative local snapshot without replacing the surrounding list. */
export class Items {
 static update(list: HTMLElement, libraries: Library[], render: (values: { library: Library; snippet: Library['records'][number] }) => string) {
  const valid = new Set<string>();
  for (const library of libraries) for (const snippet of library.records) {
   const key = `${library._id}:${snippet.id}`; valid.add(key);
   const signature = JSON.stringify([snippet, library.name, library.permissions.edit]);
   const existing = [...list.children].find(element => (element as HTMLElement).dataset.key === key) as HTMLElement | undefined;
   if (existing?.dataset.signature === signature) continue;
   const parser = new list.ownerDocument.defaultView!.DOMParser();
   const element = parser.parseFromString(render({ library, snippet }), 'text/html').body.firstElementChild as HTMLElement;
   element.dataset.key = key; element.dataset.signature = signature;
   element.dataset.search = `${snippet.title || ''} ${snippet.effective_trigger ?? snippet.trigger ?? ''} ${snippet.content.text || snippet.content.markdown || ''} ${library.name}`.toLocaleLowerCase();
   if (existing) {
    const active = list.ownerDocument.activeElement as HTMLElement | null;
    const focus = active && existing.contains(active) ? active.hasAttribute('data-edit') ? '[data-edit]' : '[data-use]' : null;
    existing.replaceWith(element);
    if (focus) element.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
   } else list.append(element);
  }
  for (const element of [...list.children]) if (!valid.has((element as HTMLElement).dataset.key!)) element.remove();
 }
}
