/**
 * Shared resize-gesture chrome for the panel dividers (sidebar / inspector /
 * files tree). One place owns the body cursor + text-selection lock and the
 * handle's `data-resizing` flag, so every divider lights up the same way and
 * cleanup can happen on pointerup, pointercancel, lost pointer capture and
 * blur alike.
 *
 * The host and handle are typed structurally (not as `HTMLElement`) so the
 * cleanup logic is unit-testable in the node vitest environment.
 */
export type ResizeCursorHost = { style: { cursor: string; userSelect: string } };
export type ResizeHandle = { dataset: DOMStringMap };

/** Enter a drag: lock the pointer affordances and flag the handle as active. */
export function beginResizeGesture(cursorHost: ResizeCursorHost, handle: ResizeHandle): void {
  cursorHost.style.cursor = "col-resize";
  cursorHost.style.userSelect = "none";
  handle.dataset.resizing = "";
}

/**
 * Leave a drag: restore the pointer affordances and clear the handle flag.
 * Tolerates a null handle so a panel unmounting mid-drag never strands the
 * body cursor or selection lock.
 */
export function endResizeGesture(cursorHost: ResizeCursorHost, handle: ResizeHandle | null): void {
  cursorHost.style.cursor = "";
  cursorHost.style.userSelect = "";
  if (handle) {
    delete handle.dataset.resizing;
  }
}
