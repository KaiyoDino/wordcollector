// Full-screen overlays (Dictionary, Compare): open/close, Esc to close, focus returns to
// whatever was focused before, and the page behind doesn't scroll.
const stack = [];

export function openOverlay(node, { focus } = {}) {
  if (!stack.some((entry) => entry.node === node)) {
    stack.push({ node, returnFocus: document.activeElement });
  }
  node.hidden = false;
  node.classList.add('open');
  document.body.classList.add('no-scroll');
  focus?.focus();
}

export function closeOverlay(node) {
  const i = stack.findIndex((entry) => entry.node === node);
  if (i === -1) return;
  const [{ returnFocus }] = stack.splice(i, 1);
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
