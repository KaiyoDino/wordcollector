// Selecting several library words to edit their tags or where they were found, all at once.
// "Select" (next to the word count) or Ctrl-click on a card starts it; then a click toggles
// a card, Shift-click selects a range, Ctrl+A selects every word shown, Esc or Done ends it.
const list = document.getElementById('list');
const bar = document.getElementById('select-bar');
const countLabel = document.getElementById('select-count');
const toggle = document.getElementById('select-toggle');
const editButton = document.getElementById('select-edit');

let selecting = false;
let anchor = null;          // the last card clicked, where a Shift-click range starts
const selected = new Set();
let hooks = {};

const cards = () => [...list.querySelectorAll('.word-card')];
const shownIds = () => cards().map((node) => Number(node.dataset.id));
// Another screen, dialog or the word panel is in front of the list.
const covered = () => document.querySelector('dialog[open], .review.open, .drawer.open');

export function initSelection(callbacks) {
  hooks = callbacks;
  toggle.addEventListener('click', () => start());
  document.getElementById('select-all').addEventListener('click', selectAll);
  document.getElementById('select-done').addEventListener('click', stopSelecting);
  editButton.addEventListener('click', () => hooks.onEdit?.([...selected]));
  document.addEventListener('keydown', (e) => {
    if (!selecting || covered()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopSelecting();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a'
      && !e.target.closest('input, textarea, select, [contenteditable]')) {
      e.preventDefault();
      selectAll();
    }
  });
}

export const isSelecting = () => selecting;

function start(id) {
  selecting = true;
  if (id != null) {
    selected.add(id);
    anchor = id;
  }
  sync();
}

export function stopSelecting() {
  selecting = false;
  selected.clear();
  anchor = null;
  sync();
}

function selectAll() {
  for (const id of shownIds()) selected.add(id);
  sync();
}

// A click (or Enter/Space) on a card. Returns true if it was handled as selecting, so the
// card shouldn't open.
export function selectionClick(id, e) {
  if (!selecting) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    start(id);
    return true;
  }
  const ids = shownIds();
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(id);
  if (e.shiftKey && from !== -1 && to !== -1) {
    for (const x of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(x);
  } else {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = id;
  }
  sync();
  return true;
}

// After the list is drawn again (a search, a filter, an edit): words no longer shown are
// let go, so an edit only ever changes words you can see.
export function syncSelection() {
  const shown = new Set(shownIds());
  for (const id of selected) if (!shown.has(id)) selected.delete(id);
  if (anchor != null && !shown.has(anchor)) anchor = null;
  sync();
}

function sync() {
  list.classList.toggle('selecting', selecting);
  for (const node of cards()) {
    const on = selected.has(Number(node.dataset.id));
    const term = node.querySelector('.term')?.textContent ?? '';
    node.classList.toggle('picked', on);
    if (selecting) node.setAttribute('aria-pressed', String(on));
    else node.removeAttribute('aria-pressed');
    node.setAttribute('aria-label', selecting ? `Select ${term}` : `Open ${term}`);
  }
  bar.hidden = !selecting;
  document.body.classList.toggle('has-select-bar', selecting);
  toggle.hidden = selecting || !cards().length;
  const n = selected.size;
  countLabel.textContent = n ? `${n} selected` : 'Click words to select them';
  editButton.disabled = n === 0;
}
