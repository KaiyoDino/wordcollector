import { api } from './api.js';
import { el, icon, debounce, toast } from './dom.js';
import { loadSettings, getSettings, setSettings } from './settings.js';
import { initWordView, openWord, currentWordId } from './wordView.js';
import { initAddDialog, openAddDialog } from './addDialog.js';
import { initReview, openReview } from './review.js';
import { initBackup } from './backup.js';

const list = document.getElementById('list');
const count = document.getElementById('count');
const search = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const favFirst = document.getElementById('fav-first');
const tagFilter = document.getElementById('tag-filter');

const MAX_CARD_TAGS = 3;

let words = [];
let libraryTerms = new Map(); // lowercase term -> id, for chips that link to saved words

async function refreshList() {
  const { sort, favFirst: ff } = getSettings();
  const q = search.value.trim();
  try {
    const [list, tags] = await Promise.all([
      api.listWords({ sort, favFirst: ff, q, tag: tagFilter.value }),
      api.listTags(),
    ]);
    words = list;
    if (!q && !tagFilter.value) libraryTerms = new Map(words.map((w) => [w.term.toLowerCase(), w.id]));
    if (syncTagFilter(tags)) return refreshList();
    render();
  } catch (err) {
    toast(err.message);
  }
}

// Rebuilds the tag dropdown. Returns true if the selected tag no longer exists (and was cleared).
function syncTagFilter(tags) {
  const selected = tagFilter.value;
  tagFilter.hidden = tags.length === 0;
  tagFilter.replaceChildren(
    el('option', { value: '' }, 'All tags'),
    ...tags.map((t) => el('option', { value: t.name }, `${t.name} (${t.count})`)));
  const stillThere = !selected || tags.some((t) => t.name === selected);
  tagFilter.value = stillThere ? selected : '';
  return !stillThere;
}

function filterDescription() {
  const q = search.value.trim();
  const parts = [q && `for “${q}”`, tagFilter.value && `tagged “${tagFilter.value}”`].filter(Boolean);
  return parts.join(' ');
}

function render() {
  const filtered = Boolean(search.value.trim() || tagFilter.value);
  count.textContent = filtered
    ? `${words.length} match${words.length === 1 ? '' : 'es'} ${filterDescription()}`
    : words.length ? `${words.length} word${words.length === 1 ? '' : 's'}` : '';

  if (!words.length) {
    list.replaceChildren(filtered
      ? el('div', { class: 'empty-state' }, el('p', {}, 'No words match.'))
      : el('div', { class: 'empty-state' },
        el('h2', {}, 'Your library is empty'),
        el('p', {}, 'Add a word and its definitions will be filled in for you.'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => openAddDialog() }, icon('plus'), 'Add your first word')));
    return;
  }

  const { sort } = getSettings();
  const nodes = [];
  let lastGroup;
  for (const word of words) {
    if (sort === 'pos') {
      const group = word.primary_pos || 'Other';
      if (group !== lastGroup) nodes.push(el('h2', { class: 'group-label' }, group));
      lastGroup = group;
    }
    nodes.push(card(word));
  }
  list.replaceChildren(...nodes);
}

function card(word) {
  const node = el('article', {
    class: `word-card${word.id === currentWordId() ? ' selected' : ''}`,
    tabindex: '0', role: 'button', 'aria-label': `Open ${word.term}`, dataset: { id: word.id },
    onclick: () => openWord(word.id),
    onkeydown: (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); openWord(word.id); }
    },
  },
  el('h3', { class: 'term' }, word.term),
  word.primary_pos && el('span', { class: 'badge' }, word.primary_pos),
  el('p', { class: `def${word.first_definition ? '' : ' empty'}` }, word.first_definition || 'No definition yet'),
  (word.found_title || word.tags.length > 0) && el('div', { class: 'card-foot' },
    word.found_title && el('span', { class: 'found' }, 'from ', el('em', {}, word.found_title)),
    word.tags.slice(0, MAX_CARD_TAGS).map((t) => el('span', { class: 'tag small' }, t)),
    word.tags.length > MAX_CARD_TAGS && el('span', { class: 'tag small more' }, `+${word.tags.length - MAX_CARD_TAGS}`)),
  el('button', {
    class: 'btn ghost small icon-only fav', type: 'button',
    'aria-pressed': String(word.favorite), 'aria-label': `Favorite ${word.term}`,
    title: word.favorite ? 'Unfavorite' : 'Favorite',
    onclick: async (e) => {
      e.stopPropagation();
      try {
        await api.updateWord(word.id, { favorite: !word.favorite });
        await refreshList();
        if (currentWordId() === word.id) openWord(word.id);
      } catch (err) {
        toast(err.message);
      }
    },
  }, icon('star')));
  return node;
}

function syncToolbar() {
  const { sort, favFirst: ff } = getSettings();
  sortSelect.value = sort;
  favFirst.setAttribute('aria-pressed', String(ff));
}

sortSelect.addEventListener('change', () => { setSettings({ sort: sortSelect.value }); refreshList(); });
favFirst.addEventListener('click', () => {
  setSettings({ favFirst: !getSettings().favFirst });
  syncToolbar();
  refreshList();
});
search.addEventListener('input', debounce(refreshList, 200));
tagFilter.addEventListener('change', refreshList);
document.getElementById('open-add').addEventListener('click', () => openAddDialog());
document.getElementById('open-review').addEventListener('click', () => openReview());

// Scrolls a card into view and briefly highlights it.
function flashCard(id) {
  const node = list.querySelector(`.word-card[data-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  node.classList.remove('flash');
  void node.offsetWidth; // restart the animation if it's already running
  node.classList.add('flash');
  node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
}

async function onWordAdded(word) {
  await refreshList();
  flashCard(word.id);
  const unavailable = word.unavailable?.length
    ? ` ${word.unavailable.join(' and ')} didn’t respond; use Refresh definitions later.` : '';
  toast(`Added “${word.term}”.${unavailable}`, { action: { label: 'Open', onClick: () => openWord(word.id) } });
}

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  const busy = document.querySelector('dialog[open]') || !document.getElementById('review').hidden;
  if (typing || e.ctrlKey || e.metaKey || e.altKey || busy) return;
  if (e.key === '/') { e.preventDefault(); search.focus(); }
  if (e.key === 'n') { e.preventDefault(); openAddDialog(); }
  if (e.key === 'r') { e.preventDefault(); openReview(); }
});

initWordView({
  onChanged: refreshList,
  onAddTerm: (term) => openAddDialog(term),
  onSelect: (id) => {
    for (const node of list.querySelectorAll('.word-card')) {
      node.classList.toggle('selected', Number(node.dataset.id) === id);
    }
  },
  libraryTerms: () => libraryTerms,
});

initAddDialog({
  onAdded: onWordAdded,
  onOpen: (id) => openWord(id),
});

initReview({ onClosed: refreshList });
initBackup({ onImported: refreshList });

await loadSettings();
syncToolbar();
await refreshList();
