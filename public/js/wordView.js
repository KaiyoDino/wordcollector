// The word detail drawer: one ordered list of definitions (dictionary text read-only),
// origin, thesaurus, where you found it, tags and notes.
import { api } from './api.js';
import { el, icon, debounce, toast } from './dom.js';

const MW_URL = (t) => `https://www.merriam-webster.com/dictionary/${encodeURIComponent(t)}`;
const COMMON_POS = ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'phrase'];
const CHIP_LIMIT = 20;
const SHOWN_EXAMPLES = 2;

const drawer = document.getElementById('drawer');
const content = document.getElementById('drawer-content');
const scrim = document.getElementById('scrim');

let word = null;
let hooks = {};
let lastFocus = null;
let allTags = [];
const drafts = new Map();     // field -> unsaved text, kept across re-renders
const flushers = new Set();   // pending autosaves to run before re-rendering or closing
const expanded = new Set();   // thesaurus lists showing every chip

export function initWordView(callbacks) {
  hooks = callbacks;
  scrim.addEventListener('click', closeWord);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open') && !document.querySelector('dialog[open], .review.open')) closeWord();
  });
}

export const currentWordId = () => word?.id ?? null;

function resetFieldState() {
  flushers.forEach((flush) => flush());
  flushers.clear();
  drafts.clear();
  expanded.clear();
}

export async function openWord(id) {
  try {
    const [data, tags] = await Promise.all([api.getWord(id), api.listTags().catch(() => [])]);
    resetFieldState();
    lastFocus ??= document.activeElement;
    word = data;
    allTags = tags;
    render();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false;
    hooks.onSelect?.(id);
    content.querySelector('h2')?.focus();
  } catch (err) {
    toast(err.message);
  }
}

export function closeWord() {
  if (!word) return;
  resetFieldState();
  word = null;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  scrim.hidden = true;
  hooks.onSelect?.(null);
  lastFocus?.focus?.();
  lastFocus = null;
}

async function patchWord(changes) {
  const { id } = word;
  try {
    const updated = await api.updateWord(id, changes);
    // The drawer may have closed or moved to another word while this was in flight.
    if (word?.id === id) word = { ...word, ...updated };
    hooks.onChanged?.();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function render() {
  flushers.forEach((flush) => flush());
  flushers.clear();
  content.replaceChildren(...[
    renderHead(),
    renderSub(),
    renderDefinitions(),
    renderOrigin(),
    renderRelations(),
    renderFoundIn(),
    renderTags(),
    renderNotes(),
    renderFoot(),
  ].filter(Boolean));
}

// Re-renders, then puts focus back on the matching control so keyboard users keep their place.
function renderKeepingFocus(selector) {
  render();
  let target = selector && content.querySelector(selector);
  // A row moved to an end has that arrow disabled; fall back to another control in the row.
  if (target?.disabled) target = target.closest('.def-row')?.querySelector('button:not([disabled])');
  target?.focus();
}

// Wires an input to save itself (debounced) to `field`. Typing survives re-renders.
function autosave(field, input, status) {
  const id = word.id;
  input.value = drafts.has(field) ? drafts.get(field) : (word[field] ?? '');
  const save = debounce(async () => {
    const value = input.value;
    if (id !== word?.id || value.trim() === String(word[field] ?? '').trim()) return;
    if (status) status.textContent = 'Saving…';
    const ok = await patchWord({ [field]: value });
    if (ok && drafts.get(field) === value) drafts.delete(field);
    if (status) status.textContent = ok ? 'Saved' : 'Not saved';
  }, 700);
  input.addEventListener('input', () => {
    drafts.set(field, input.value);
    if (status) status.textContent = '';
    save();
  });
  input.addEventListener('blur', () => save.flush());
  flushers.add(() => save.flush());
  return input;
}

const section = (title, extra, ...body) =>
  el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h3', {}, title), extra),
    ...body);

function renderHead() {
  const fav = el('button', {
    class: 'btn ghost icon-only fav', type: 'button',
    'aria-pressed': String(word.favorite), 'aria-label': 'Favorite', title: word.favorite ? 'Unfavorite' : 'Favorite',
    onclick: async () => {
      if (await patchWord({ favorite: !word.favorite })) renderKeepingFocus('.word-head .fav');
    },
  }, icon('star'));
  return el('div', { class: 'word-head' },
    el('h2', { id: 'drawer-title', tabindex: '-1' }, word.term),
    fav,
    el('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Close', onclick: closeWord }, icon('x')),
  );
}

export function playAudio(url) {
  new Audio(url).play().catch(() => toast('Couldn’t play the pronunciation'));
}

function renderSub() {
  const found = [...new Set(word.definitions.map((d) => d.part_of_speech).filter(Boolean))];
  const options = [...new Set([...found, ...COMMON_POS])];
  if (word.primary_pos && !options.includes(word.primary_pos)) options.unshift(word.primary_pos);
  const select = el('select', {
    'aria-label': 'Part of speech used for sorting', title: 'Part of speech (used when sorting)',
    onchange: () => patchWord({ primary_pos: select.value }),
  },
  el('option', { value: '' }, 'No part of speech'),
  options.map((pos) => el('option', { value: pos, selected: pos === word.primary_pos }, pos)));
  return el('div', { class: 'word-sub' },
    word.pronunciation && el('span', { class: 'pron' }, word.pronunciation),
    word.audio_url && el('button', {
      class: 'btn ghost small icon-only audio', type: 'button', title: 'Play pronunciation',
      'aria-label': 'Play pronunciation', onclick: () => playAudio(word.audio_url),
    }, icon('play')),
    select,
    el('span', { class: 'meta', style: 'font-size:0.78rem' }, `Added ${new Date(word.created_at).toLocaleDateString()}`),
  );
}

// ----- Definitions -----

async function saveOrder(ids, focusSelector) {
  const byId = new Map(word.definitions.map((d) => [d.id, d]));
  const previous = word.definitions;
  word.definitions = ids.map((id) => byId.get(id));
  renderKeepingFocus(focusSelector);
  try {
    const updated = await api.reorderDefinitions(word.id, ids);
    if (word?.id === updated.id) {
      word = updated;
      // The part of speech may follow the new main definition.
      const select = content.querySelector('.word-sub select');
      if (select) select.value = updated.primary_pos ?? '';
    }
    hooks.onChanged?.();
  } catch (err) {
    toast(err.message);
    if (word) { word.definitions = previous; render(); }
  }
}

function move(defId, toIndex, focusSelector) {
  const ids = word.definitions.map((d) => d.id).filter((id) => id !== defId);
  ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, defId);
  saveOrder(ids, focusSelector);
}

let dragId = null;

function defRow(def, index, total) {
  const isUser = def.source === 'user';
  const actionButton = (action, label, iconName, onclick, disabled = false) => el('button', {
    class: 'btn ghost small icon-only', type: 'button', title: label, 'aria-label': label,
    dataset: { action }, disabled, onclick,
  }, icon(iconName));
  const focusOf = (action) => `[data-id="${def.id}"] [data-action="${action}"]`;

  const row = el('li', {
    class: 'def-row', draggable: 'true', dataset: { id: def.id },
    ondragstart: (e) => {
      if (e.target.closest('button, textarea, input')) return e.preventDefault();
      dragId = def.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(def.id));
      row.classList.add('dragging');
    },
    ondragend: () => {
      dragId = null;
      content.querySelectorAll('.def-row').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
    },
    ondragover: (e) => {
      if (dragId == null || dragId === def.id) return;
      e.preventDefault();
      const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    },
    ondragleave: () => row.classList.remove('drop-before', 'drop-after'),
    ondrop: (e) => {
      e.preventDefault();
      if (dragId == null || dragId === def.id) return;
      const after = row.classList.contains('drop-after');
      const ids = word.definitions.map((d) => d.id).filter((id) => id !== dragId);
      ids.splice(ids.indexOf(def.id) + (after ? 1 : 0), 0, dragId);
      saveOrder(ids);
    },
  },
  el('span', { class: 'drag-handle', title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('grip')),
  el('span', { class: 'def-num', 'aria-hidden': 'true' }, `${index + 1}.`),
  el('div', { class: 'def-body' },
    el('div', { class: 'def-meta' },
      index === 0 && el('span', { class: 'badge' }, 'Main'),
      isUser
        ? el('span', { class: 'source-tag user' }, 'Yours')
        : el('span', { class: 'source-tag', title: 'Merriam-Webster text is read-only' }, icon('lock'), 'MW'),
      def.part_of_speech && el('span', { class: 'def-pos' }, def.part_of_speech)),
    el('p', { class: 'def-text' }, def.text),
    def.examples.slice(0, SHOWN_EXAMPLES).map((ex) => el('span', { class: 'example' }, ex))),
  el('div', { class: 'def-actions' },
    index > 0 && el('button', {
      class: 'btn ghost small', type: 'button', dataset: { action: 'main' },
      title: 'Show this definition on the card', onclick: () => move(def.id, 0, focusOf('down')),
    }, 'Set as main'),
    actionButton('up', 'Move up', 'up', () => move(def.id, index - 1, focusOf('up')), index === 0),
    actionButton('down', 'Move down', 'down', () => move(def.id, index + 1, focusOf('down')), index === total - 1),
    isUser && actionButton('edit', 'Edit definition', 'pencil', () => row.replaceWith(definitionForm({
      def, submitLabel: 'Save', onCancel: render,
      onSubmit: async (changes) => {
        try { await api.updateDefinition(word.id, def.id, changes); await reloadWord(); } catch (err) { toast(err.message); }
      },
    }))),
    isUser && el('button', {
      class: 'btn ghost small icon-only danger', type: 'button', 'aria-label': 'Delete definition', title: 'Delete',
      onclick: async () => {
        if (!confirm('Delete this definition?')) return;
        try { await api.deleteDefinition(word.id, def.id); await reloadWord(); } catch (err) { toast(err.message); }
      },
    }, icon('trash'))),
  );
  return row;
}

async function reloadWord() {
  word = await api.getWord(word.id);
  hooks.onChanged?.();
  render();
}

function definitionForm({ def = {}, submitLabel, onSubmit, onCancel }) {
  const text = el('textarea', { class: 'field', placeholder: 'Your definition', required: true, maxlength: 5000, value: def.text ?? '' });
  const pos = el('input', { class: 'field', type: 'text', placeholder: 'Part of speech (optional)', list: 'pos-options', value: def.part_of_speech ?? '' });
  const example = el('input', { class: 'field', type: 'text', placeholder: 'Example sentence (optional)', value: def.examples?.[0] ?? '' });
  const form = el('form', {
    class: 'def-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!text.value.trim()) return text.focus();
      await onSubmit({ text: text.value, part_of_speech: pos.value, example: example.value });
    },
  },
  text,
  el('div', { class: 'row' }, pos, example),
  el('div', { class: 'buttons' },
    el('button', { class: 'btn ghost small', type: 'button', onclick: onCancel }, 'Cancel'),
    el('button', { class: 'btn primary small', type: 'submit' }, submitLabel)),
  el('datalist', { id: 'pos-options' }, COMMON_POS.map((p) => el('option', { value: p }))));
  queueMicrotask(() => text.focus());
  return form;
}

function renderDefinitions() {
  const defs = word.definitions;
  const addButton = el('button', {
    class: 'btn small', type: 'button',
    onclick: () => addButton.replaceWith(definitionForm({
      submitLabel: 'Add definition',
      onCancel: render,
      onSubmit: async (def) => {
        try { await api.addDefinition(word.id, def); await reloadWord(); } catch (err) { toast(err.message); }
      },
    })),
  }, icon('plus'), 'Add your own definition');

  return section('Definitions',
    el('a', { class: 'meta', href: MW_URL(word.term), target: '_blank', rel: 'noopener noreferrer' }, 'Merriam-Webster', icon('external')),
    el('div', { class: 'source-block' },
      defs.length
        ? [el('p', { class: 'hint' }, 'Drag or use the arrows to reorder. The top definition shows on the card.'),
          el('ol', { class: 'def-list' }, defs.map((d, i) => defRow(d, i, defs.length)))]
        : el('p', { class: 'status-note' }, 'No dictionary definitions were found. Add your own, or try Refresh definitions later.'),
      addButton),
  );
}

// ----- Origin, thesaurus -----

function renderOrigin() {
  if (!word.etymology && !word.first_use) return null;
  return section('Origin', null,
    el('div', { class: 'source-block' },
      word.etymology && el('p', { class: 'origin' }, word.etymology),
      word.first_use && el('p', { class: 'chips-label', style: 'margin-bottom:0' }, `First known use: ${word.first_use}`)),
  );
}

function renderRelations() {
  if (!word.synonyms.length && !word.antonyms.length) return null;
  const library = hooks.libraryTerms?.() ?? new Map();
  const chips = (kind, items) => {
    const showAll = expanded.has(kind) || items.length <= CHIP_LIMIT + 5;
    const shown = showAll ? items : items.slice(0, CHIP_LIMIT);
    return el('div', { class: 'chips' },
      shown.map(({ value }) => {
        const existingId = library.get(value.toLowerCase());
        return el('button', {
          class: `chip${existingId ? ' in-library' : ''}`, type: 'button',
          title: existingId ? 'Open in your library' : 'Add to your library',
          onclick: () => (existingId ? openWord(existingId) : hooks.onAddTerm?.(value)),
        }, value);
      }),
      !showAll && el('button', {
        class: 'chip more', type: 'button', dataset: { more: kind },
        onclick: () => { expanded.add(kind); renderKeepingFocus(`.chips [data-more]`); },
      }, `Show all ${items.length}`));
  };
  return section('Thesaurus', null,
    el('div', { class: 'source-block' },
      word.synonyms.length && [el('p', { class: 'chips-label' }, 'Synonyms'), chips('synonyms', word.synonyms)],
      word.antonyms.length && [el('p', { class: 'chips-label' }, 'Antonyms'), chips('antonyms', word.antonyms)],
    ),
  );
}

// ----- Where I found it, tags, notes -----

function renderFoundIn() {
  const status = el('span', { class: 'notes-status' });
  const field = (name, label, attrs) => el('label', { class: `found-field ${name}` },
    el('span', {}, label),
    autosave(name, el('input', { class: 'field', type: 'text', ...attrs }), status));
  return section('Where I found it', status,
    el('div', { class: 'found-grid' },
      field('found_title', 'Title', { placeholder: 'Book, article, show…', maxlength: 300 }),
      field('found_author', 'Author', { placeholder: 'Author', maxlength: 200 }),
      field('found_page', 'Page', { placeholder: 'p.', maxlength: 40, inputmode: 'text' })),
  );
}

function renderTags() {
  const input = el('input', {
    type: 'text', placeholder: word.tags.length ? 'Add tag' : 'Add a tag, e.g. GRE', list: 'tag-options',
    'aria-label': 'Add tag', maxlength: 40,
  });
  const saveTags = async (tags) => {
    if (await patchWord({ tags })) {
      allTags = await api.listTags().catch(() => allTags);
      renderKeepingFocus('.tag-input input');
    }
  };
  const addFromInput = () => {
    const names = input.value.split(',').map((t) => t.trim()).filter(Boolean);
    input.value = '';
    const next = [...word.tags];
    for (const name of names) if (!next.some((t) => t.toLowerCase() === name.toLowerCase())) next.push(name);
    if (next.length !== word.tags.length) saveTags(next);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); }
    else if (e.key === 'Backspace' && !input.value && word.tags.length) saveTags(word.tags.slice(0, -1));
  });
  input.addEventListener('change', () => { if (input.value.trim()) addFromInput(); });

  return section('Tags', null,
    el('div', { class: 'tag-input', onclick: (e) => { if (e.target === e.currentTarget) input.focus(); } },
      word.tags.map((tag) => el('span', { class: 'tag' }, tag,
        el('button', {
          type: 'button', 'aria-label': `Remove tag ${tag}`, title: 'Remove',
          onclick: () => saveTags(word.tags.filter((t) => t !== tag)),
        }, icon('x')))),
      input,
      el('datalist', { id: 'tag-options' },
        allTags.filter((t) => !word.tags.some((w) => w.toLowerCase() === t.name.toLowerCase()))
          .map((t) => el('option', { value: t.name })))),
  );
}

function renderNotes() {
  const status = el('span', { class: 'notes-status' });
  const area = el('textarea', {
    class: 'field', rows: 4, placeholder: 'How you’d use it, what it reminds you of, anything…', 'aria-label': 'Notes',
  });
  return section('Notes', status, autosave('notes', area, status));
}

function renderFoot() {
  const refresh = el('button', {
    class: 'btn', type: 'button', title: 'Fetch dictionary definitions again (your order and definitions are kept)',
    onclick: async () => {
      refresh.disabled = true;
      refresh.lastChild.textContent = 'Refreshing…';
      try {
        word = await api.refreshWord(word.id);
        hooks.onChanged?.();
        render();
        toast(word.unavailable?.length
          ? `${word.unavailable.join(' and ')} didn’t respond. Try again later.`
          : 'Definitions refreshed');
      } catch (err) {
        toast(err.message);
        refresh.disabled = false;
        refresh.lastChild.textContent = 'Refresh definitions';
      }
    },
  }, icon('refresh'), el('span', {}, 'Refresh definitions'));

  const remove = el('button', {
    class: 'btn ghost danger', type: 'button',
    onclick: async () => {
      if (!confirm(`Delete “${word.term}” from your library? This can’t be undone.`)) return;
      try {
        const { term } = word;
        await api.deleteWord(word.id);
        drafts.clear();
        flushers.clear();
        closeWord();
        hooks.onChanged?.();
        toast(`Deleted “${term}”`);
      } catch (err) {
        toast(err.message);
      }
    },
  }, icon('trash'), 'Delete word');

  return el('div', { class: 'drawer-foot' }, refresh, remove);
}
