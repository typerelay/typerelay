export type SwipeAction = 'copy' | 'edit' | 'delete' | 'none';
export type SwipePreferences = { right: SwipeAction; left: SwipeAction; rightFar: SwipeAction };

const KEY = 'typerelay_mobile_swipes_v2';
const DEFAULTS: SwipePreferences = { right: 'edit', left: 'copy', rightFar: 'delete' };
const ACTIONS: Record<SwipeAction, { icon: string; label: string }> = {
 copy: { icon: 'content_copy', label: 'Copy' },
 edit: { icon: 'edit', label: 'Edit' },
 delete: { icon: 'delete', label: 'Delete' },
 none: { icon: 'block', label: 'None' },
};
const REVEAL = 92;
const REVEAL_THRESHOLD = 44;
const DIRECTION_LOCK = 8;

export class SwipeRows {
 static attached = new WeakSet<HTMLElement>();
 static preferences = SwipeRows.load();
 static callback: (action: SwipeAction, row: HTMLElement) => void;
 static drag: { dragging: boolean; offset: number; pointer: number; row: HTMLElement; startX: number; startY: number } | null = null;
 static suppress = new WeakSet<HTMLElement>();
 static load(): SwipePreferences {
  try {
   const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
   const value = (name: keyof SwipePreferences) => Object.hasOwn(ACTIONS, saved[name]) ? saved[name] as SwipeAction : DEFAULTS[name];
   return { right: value('right'), left: value('left'), rightFar: value('rightFar') };
  } catch { return { ...DEFAULTS }; }
 }
 static save(preferences: SwipePreferences) { SwipeRows.preferences = preferences; localStorage.setItem(KEY, JSON.stringify(preferences)); }
 static meta(action: SwipeAction) { return ACTIONS[action]; }
 static allowed(action: SwipeAction, row: HTMLElement) { return action === 'none' || action === 'copy' || row.dataset.editable === 'true' ? action : 'none'; }
 static bind(list: HTMLElement, callback: (action: SwipeAction, row: HTMLElement) => void) {
  SwipeRows.callback = callback;
  SwipeRows.refresh(list);
  if (SwipeRows.attached.has(list)) return;
  SwipeRows.attached.add(list);
  list.addEventListener('pointerdown', SwipeRows.start);
  list.addEventListener('pointermove', SwipeRows.move, { passive: false });
  list.addEventListener('pointerup', SwipeRows.finish);
  list.addEventListener('pointercancel', SwipeRows.cancel);
  list.addEventListener('click', event => {
   const row = (event.target as HTMLElement).closest<HTMLElement>('.snippet-swipe-shell');
   if (!row) return;
   if (SwipeRows.suppress.has(row)) { event.preventDefault(); event.stopPropagation(); SwipeRows.suppress.delete(row); return; }
   const side = (event.target as HTMLElement).closest<HTMLElement>('[data-swipe-side]')?.dataset.swipeSide;
   if (!side) { if (Number(row.dataset.swipeOffset || 0)) { event.preventDefault(); event.stopPropagation(); SwipeRows.reset(row); } return; }
   event.preventDefault(); event.stopPropagation();
   const action = side === 'right' ? SwipeRows.allowed(SwipeRows.preferences.right, row) : SwipeRows.allowed(SwipeRows.preferences.left, row);
   SwipeRows.reset(row); if (action !== 'none') callback(action, row);
  }, true);
 }
 static refresh(list: HTMLElement) {
  for (const row of list.querySelectorAll<HTMLElement>('.snippet-swipe-shell')) {
   SwipeRows.paint(row, 'right', SwipeRows.allowed(SwipeRows.preferences.right, row));
   SwipeRows.paint(row, 'left', SwipeRows.allowed(SwipeRows.preferences.left, row));
  }
 }
 static paint(row: HTMLElement, side: 'left' | 'right', action: SwipeAction) {
  const button = row.querySelector<HTMLElement>(`[data-swipe-side="${side}"]`); if (!button) return;
  button.hidden = action === 'none'; button.classList.toggle('danger', action === 'delete');
  button.querySelector<HTMLElement>('[data-swipe-icon]')!.textContent = SwipeRows.meta(action).icon;
  button.querySelector<HTMLElement>('[data-swipe-label]')!.textContent = SwipeRows.meta(action).label;
 }
 static start = (event: PointerEvent) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.snippet-swipe-shell');
  if (!row || (event.target as HTMLElement).closest('[data-swipe-side]') || (event.pointerType === 'mouse' && event.button !== 0)) return;
  for (const other of row.parentElement?.querySelectorAll<HTMLElement>('.snippet-swipe-shell') || []) if (other !== row) SwipeRows.reset(other);
  SwipeRows.drag = { dragging: false, offset: Number(row.dataset.swipeOffset || 0), pointer: event.pointerId, row, startX: event.clientX, startY: event.clientY };
 };
 static move = (event: PointerEvent) => {
  const drag = SwipeRows.drag; if (!drag || drag.pointer !== event.pointerId) return;
  const x = event.clientX - drag.startX; const y = event.clientY - drag.startY;
  if (!drag.dragging) {
   if (Math.abs(x) < DIRECTION_LOCK) return;
   if (Math.abs(y) > Math.abs(x)) { SwipeRows.drag = null; return; }
   drag.dragging = true; drag.row.classList.add('is-dragging'); drag.row.setPointerCapture?.(event.pointerId);
  }
  event.preventDefault();
  const next = Math.max(-drag.row.clientWidth * 0.94, Math.min(drag.row.clientWidth * 0.94, drag.offset + x));
  const right = SwipeRows.allowed(SwipeRows.preferences.right, drag.row);
  const left = SwipeRows.allowed(SwipeRows.preferences.left, drag.row);
  const rightFar = SwipeRows.allowed(SwipeRows.preferences.rightFar, drag.row);
  const allowed = next > 0 ? right !== 'none' || rightFar !== 'none' : next < 0 ? left !== 'none' : true;
  const offset = allowed ? next : 0; SwipeRows.offset(drag.row, offset);
  const far = offset > SwipeRows.commitThreshold(drag.row) && rightFar !== 'none';
  drag.row.classList.toggle('is-delete-commit', far && rightFar === 'delete');
  if (far) SwipeRows.paint(drag.row, 'right', rightFar); else SwipeRows.paint(drag.row, 'right', right);
 };
 static finish = (event: PointerEvent) => {
  const drag = SwipeRows.drag; if (!drag || drag.pointer !== event.pointerId) return;
  SwipeRows.drag = null; drag.row.classList.remove('is-dragging'); drag.row.releasePointerCapture?.(event.pointerId);
  if (!drag.dragging) return;
  event.preventDefault(); SwipeRows.suppress.add(drag.row); window.setTimeout(() => SwipeRows.suppress.delete(drag.row), 0);
  const offset = Number(drag.row.dataset.swipeOffset || 0);
  const threshold = SwipeRows.commitThreshold(drag.row);
  let action: SwipeAction = 'none';
  if (offset >= threshold) action = SwipeRows.allowed(SwipeRows.preferences.rightFar, drag.row);
  else if (offset <= -threshold) action = SwipeRows.allowed(SwipeRows.preferences.left, drag.row);
  if (action !== 'none') { SwipeRows.reset(drag.row); SwipeRows.callback(action, drag.row); return; }
  if (offset <= -REVEAL_THRESHOLD && SwipeRows.allowed(SwipeRows.preferences.left, drag.row) !== 'none') SwipeRows.offset(drag.row, -REVEAL);
  else if (offset >= REVEAL_THRESHOLD && SwipeRows.allowed(SwipeRows.preferences.right, drag.row) !== 'none') SwipeRows.offset(drag.row, REVEAL);
  else SwipeRows.reset(drag.row);
 };
 static cancel = (event: PointerEvent) => { const drag = SwipeRows.drag; if (!drag || drag.pointer !== event.pointerId) return; SwipeRows.drag = null; drag.row.classList.remove('is-dragging'); SwipeRows.reset(drag.row); };
 static commitThreshold(row: HTMLElement) { return Math.min(Math.max(150, row.clientWidth * 0.55), row.clientWidth - 48); }
 static offset(row: HTMLElement, offset: number) {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const value = `${offset / rem}rem`; row.dataset.swipeOffset = String(offset); row.style.setProperty('--swipe-offset', value);
  row.style.setProperty('--swipe-left-action-width', `${Math.max(REVEAL, offset > 0 ? offset : 0) / rem}rem`);
  row.style.setProperty('--swipe-right-action-width', `${Math.max(REVEAL, offset < 0 ? -offset : 0) / rem}rem`);
 }
 static reset(row: HTMLElement) { row.classList.remove('is-delete-commit'); SwipeRows.offset(row, 0); SwipeRows.paint(row, 'left', SwipeRows.allowed(SwipeRows.preferences.left, row)); SwipeRows.paint(row, 'right', SwipeRows.allowed(SwipeRows.preferences.right, row)); }
}
