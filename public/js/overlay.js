// Full-screen overlays (Dictionary, Compare): open/close, Esc to close, focus returns to
// whatever was focused before, and the page behind doesn't scroll.
const stack = [];
const BASE_Z = 40;

export function openOverlay(node, { focus } = {}) {
  // An overlay opened from another one (Dictionary from Find a word) goes on top of it.
  const i = stack.findIndex((entry) => entry.node === node);
  stack.push(i === -1 ? { node, returnFocus: document.activeElement } : stack.splice(i, 1)[0]);
  stack.forEach((entry, index) => { entry.node.style.zIndex = String(BASE_Z + index); });
  node.hidden = false;
  node.classList.add('open');
  document.body.classList.add('no-scroll');
  focus?.focus();
}

export function closeOverlay(node) {
  const i = stack.findIndex((entry) => entry.node === node);
  if (i === -1) return;
  const [{ returnFocus }] = stack.splice(i, 1);
  // Release focus from the hidden overlay; otherwise keys like D or C would be "typed" into
  // its search field instead of working as shortcuts.
  if (node.contains(document.activeElement)) document.activeElement.blur();
  node.classList.remove('open');
  node.hidden = true;
  if (!stack.length && document.getElementById('review').hidden) document.body.classList.remove('no-scroll');
  returnFocus?.focus?.();
}

export const isOverlayOpen = () => stack.length > 0;

// Close buttons inside overlays.
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-overlay-close]');
  if (button) closeOverlay(button.closest('.overlay'));
});

// Esc closes the top overlay, unless a dialog (e.g. Add to library) is open above it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  closeOverlay(stack[stack.length - 1].node);
});
