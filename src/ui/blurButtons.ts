/**
 * After a pointer activation, drop focus from buttons so Space/Enter
 * cannot re-fire them. Tab focus is blocked (see installTabFocusBlock); we only
 * clear sticky focus from mouse / touch / pen.
 */
export function installButtonFocusRelease(): void {
  const release = (target: EventTarget | null) => {
    const el =
      target instanceof Element
        ? target.closest('button, [role="button"]')
        : null;
    if (!(el instanceof HTMLElement)) return;
    // After the click/activate has completed
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.blur();
    });
  };

  document.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') {
        release(e.target);
      }
    },
    true,
  );

  // Fallback for environments that only synthesize click
  document.addEventListener(
    'click',
    (e) => {
      release(e.target);
    },
    true,
  );
}

/**
 * Tab is the auto-land key, so it never walks focus through the page's
 * buttons. Held repeats included: the browser would otherwise move focus on
 * each repeat. Arrow keys still drive the menus that need them.
 */
export function installTabFocusBlock(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab') e.preventDefault();
    },
    true,
  );
}
