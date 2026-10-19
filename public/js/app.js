import { api } from './api.js';
import { el, icon, debounce, toast } from './dom.js';
import { loadSettings, getSettings, setSettings, openSettings } from './settings.js';
import { initWordView, openWord, currentWordId } from './wordView.js';
import { initAddDialog, openAddDialog } from './addDialog.js';
import { initReview, openReview } from './review.js';
import { initBackup } from './backup.js';
import { initLookupView, openLookup, noteAdded } from './lookupView.js';
import { initCompare, openCompare, noteAddedToCompare } from './compare.js';
import { initFinder, openFinder, noteAddedToFinder } from './finder.js';
import { initSelection, selectionClick, syncSelection, stopSelecting } from './selection.js';
import { initBulkEdit, openBulkEdit } from './bulkEdit.js';
import { attachHistory, rememberSearch } from './history.js';
import { openKeySettings } from './keys.js';
import { closeOverlay, isOverlayOpen } from './overlay.js';
import './desktop.js';

const list = document.getElementById('list');
const count = document.getElementById('count');
const search = document.getElementById('search');
const sortSelect = document.getElementById('sort');
const favFirst = document.getElementById('fav-first');
const tagFilter = document.getElementById('tag-filter');
const kindFilter = document.getElementById('kind-filter');
const overlays = ['lookup', 'compare', 'finder'].map((id) => document.getElementById(id));

const MAX_CARD_TAGS = 3;

let words = [];
let libraryTerms = new Map(); // lowercase term -> id, for chips that link to saved words

async function refreshList() {
  const { sort, favFirst: ff, kind } = getSettings();
  const q = search.value.trim();
  const filtered = Boolean(q || tagFilter.value || kind);
  try {
    const [list, tags, all] = await Promise.all([
      api.listWords({ sort, favFirst: ff, q, tag: tagFilter.value, kind }),
      api.listTags(),
      // "Is this in my library?" needs every entry, not just the filtered ones.
      filtered ? api.listWords({ sort: 'alpha' }) : null,
    ]);
    words = list;
    libraryTerms = new Map((all ?? list).map((w) => [w.term.toLowerCase(), w.id]));
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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "4 words · 1 phrase", or just "4 words" when there are no phrases.
function describeCount(list) {
  const phrases = list.filter((w) => w.kind === 'phrase').length;
  const wordsCount = list.length - phrases;
  return [wordsCount && plural(wordsCount, 'word'), phrases && plural(phrases, 'phrase')].filter(Boolean).join(' · ');
}

function render() {
  const { kind } = getSettings();
  const searching = Boolean(search.value.trim() || tagFilter.value);
  count.textContent = searching
    ? `${plural(words.length, 'match', 'matches')} ${filterDescription()}`
    : describeCount(words);

  if (!words.length) {
    const noun = kind === 'phrase' ? 'phrases' : kind === 'word' ? 'words' : 'words or phrases';
    list.replaceChildren(searching || kind
      ? el('div', { class: 'empty-state' }, el('p', {}, searching ? 'Nothing matches.' : `No ${noun} in your library yet.`))
      : el('div', { class: 'empty-state' },
        el('h2', {}, 'Your library is empty'),
        el('p', {}, 'Add a word or phrase and its definitions will be filled in for you.'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => openAddDialog() }, icon('plus'), 'Add your first word')));
    syncSelection();
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
  syncSelection();
}

function card(word) {
  // While selecting words, a click selects instead of opening.
  const activate = (e) => { if (!selectionClick(word.id, e)) openWord(word.id); };
  const node = el('article', {
    class: `word-card${word.id === currentWordId() ? ' selected' : ''}`,
    tabindex: '0', role: 'button', 'aria-label': `Open ${word.term}`, dataset: { id: word.id },
    onclick: activate,
    onkeydown: (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); activate(e); }
    },
  },
  el('span', { class: 'select-box', 'aria-hidden': 'true' }, icon('check')),
  el('h3', { class: 'term' }, word.term),
  word.primary_pos && el('span', { class: 'badge' }, word.primary_pos),
  // MW's part of speech for phrases already says "phrase" / "noun phrase"; don't repeat it.
  word.kind === 'phrase' && !/phrase/.test(word.primary_pos ?? '') && el('span', { class: 'badge muted' }, 'phrase'),
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
  const { sort, favFirst: ff, kind } = getSettings();
  sortSelect.value = sort;
  kindFilter.value = kind ?? '';
  favFirst.setAttribute('aria-pressed', String(ff));
}

sortSelect.addEventListener('change', () => { setSettings({ sort: sortSelect.value }); refreshList(); });
favFirst.addEventListener('click', () => {
  setSettings({ favFirst: !getSettings().favFirst });
  syncToolbar();
  refreshList();
});
const searchNow = debounce(refreshList, 200);
search.addEventListener('input', searchNow);
// A search is remembered once you press Enter or move on from the field, not on every
// letter typed.
search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.defaultPrevented) return;
  searchNow.flush();
  rememberSearch('searchHistory', search.value);
});
search.addEventListener('blur', () => rememberSearch('searchHistory', search.value));
attachHistory(search, {
  key: 'searchHistory',
  anchor: search.closest('.search'),
  onPick: (term) => { rememberSearch('searchHistory', term); searchNow.flush(); },
});
tagFilter.addEventListener('change', refreshList);
kindFilter.addEventListener('change', () => { setSettings({ kind: kindFilter.value }); refreshList(); });
document.getElementById('open-add').addEventListener('click', () => openAddDialog());
document.getElementById('open-review').addEventListener('click', () => openReview());
document.getElementById('open-lookup').addEventListener('click', () => openLookup());
document.getElementById('open-compare').addEventListener('click', () => openCompare());
document.getElementById('open-finder').addEventListener('click', () => openFinder());

// The word panel sits beneath the Dictionary, Compare and Find a word screens, so close
// them first.
function openFromOverlay(id) {
  overlays.forEach(closeOverlay);
  openWord(id);
}

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
  noteAdded(word);
  noteAddedToCompare(word);
  noteAddedToFinder(word);
  await refreshList();
  flashCard(word.id);
  const unavailable = word.unavailable?.length
    ? ` ${word.unavailable.join(' and ')} didn’t respond; use Refresh definitions later.` : '';
  toast(`Added “${word.term}”.${unavailable}`, { action: { label: 'Open', onClick: () => openWord(word.id) } });
}

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  const busy = document.querySelector('dialog[open]') || !document.getElementById('review').hidden || isOverlayOpen();
  if (typing || e.ctrlKey || e.metaKey || e.altKey || busy) return;
  const actions = {
    '/': () => search.focus(),
    n: () => openAddDialog(),
    r: () => openReview(),
    d: () => openLookup(),
    c: () => openCompare(),
    f: () => openFinder(),
    s: () => openSettings(),
  };
  if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
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
  onCompare: (term) => openCompare(term, ''),
});

const overlayHooks = {
  onOpen: openFromOverlay,
  onAdd: (term) => openAddDialog(term),
  onCompare: (term) => openCompare(term, ''),
  onLookup: (term) => openLookup(term),
  onFind: (term) => openFinder(term),
  onOpenKeys: (name) => openKeySettings(name),
  libraryTerms: () => libraryTerms,
};
initLookupView(overlayHooks);
initCompare(overlayHooks);
initFinder(overlayHooks);

initSelection({
  onEdit: (ids) => {
    const chosen = new Set(ids);
    openBulkEdit(words.filter((w) => chosen.has(w.id)));
  },
});
initBulkEdit({
  onApplied: async (ids) => {
    stopSelecting();
    await refreshList();
    if (ids.includes(currentWordId())) openWord(currentWordId());
  },
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
