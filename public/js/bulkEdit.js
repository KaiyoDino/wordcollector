// Editing several selected words at once: add tags, remove tags, and set where they were
// found. Only what you change is applied; everything else stays as each word has it.
import { api } from './api.js';
import { el, fill, icon, toast } from './dom.js';

const dialog = document.getElementById('bulk-dialog');
const title = document.getElementById('bulk-title');
const body = document.getElementById('bulk-body');
const applyButton = document.getElementById('bulk-apply');

const FIELDS = [
  { name: 'found_title', label: 'Title', placeholder: 'Book, article, show…', maxlength: 300 },
  { name: 'found_author', label: 'Author', placeholder: 'Author', maxlength: 200 },
  { name: 'found_page', label: 'Page', placeholder: 'p.', maxlength: 40 },
];
const NAMED_WORDS = 3;

// { words, add: [names], remove: Set(lowercase), fields: { name: new value }, allTags }
let state = null;
let hooks = {};
let tagsBox = null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lower = (s) => s.toLowerCase();

export function initBulkEdit(callbacks) {
  hooks = callbacks;
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  applyButton.addEventListener('click', apply);
  dialog.addEventListener('close', () => { state = null; });
}

// words: the selected words as the library lists them (with tags and found_* fields).
export async function openBulkEdit(words) {
  if (!words.length) return;
  const allTags = await api.listTags().catch(() => []);
  state = { words, add: [], remove: new Set(), fields: {}, allTags };
  const noun = words.every((w) => w.kind === 'phrase') ? ['phrase', 'phrases']
    : words.some((w) => w.kind === 'phrase') ? ['entry', 'entries'] : ['word', 'words'];
  title.textContent = `Edit ${plural(words.length, ...noun)}`;
  tagsBox = el('div', { class: 'bulk-tags' });
  fill(body,
    el('p', { class: 'hint bulk-which' }, describeWords(words)),
    el('section', { class: 'bulk-section' }, el('h3', {}, 'Tags'), tagsBox),
    el('section', { class: 'bulk-section' },
      el('h3', {}, 'Where I found it'),
      el('div', { class: 'found-grid' }, FIELDS.map(foundField)),
      el('p', { class: 'hint' }, 'Fields you leave alone keep each word’s own value.')));
  renderTags();
  updateApply();
  dialog.showModal();
  tagsBox.querySelector('input')?.focus();
}

function describeWords(words) {
  const names = words.slice(0, NAMED_WORDS).map((w) => `“${w.term}”`);
  const rest = words.length - names.length;
  if (!rest) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `${names.join(', ')} and ${plural(rest, 'other')}`;
}

// ----- Tags -----

function renderTags() {
  const input = el('input', {
    type: 'text', maxlength: 40, list: 'bulk-tag-options', 'aria-label': 'Tag to add',
    placeholder: state.add.length ? 'Add another' : 'Add a tag to all of them',
  });
  const addFromInput = () => {
    const names = input.value.split(',').map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
    input.value = '';
    for (const name of names) {
      if (!state.add.some((t) => lower(t) === lower(name))) state.add.push(name);
      state.remove.delete(lower(name));
    }
    if (names.length) changedTags();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); }
    else if (e.key === 'Backspace' && !input.value && state.add.length) { state.add.pop(); changedTags(); }
  });
  // Picking from the suggestions, or leaving the field with something typed.
  input.addEventListener('change', () => { if (input.value.trim()) addFromInput(); });
  input.addEventListener('input', updateApply);

  // Tags on any of the selected words, with how many of them have it.
  const counts = new Map();
  for (const word of state.words) {
    for (const tag of word.tags) {
      const entry = counts.get(lower(tag)) ?? { name: tag, count: 0 };
      entry.count++;
      counts.set(lower(tag), entry);
    }
  }
  const existing = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  const total = state.words.length;

  fill(tagsBox,
    el('div', { class: 'tag-input', onclick: (e) => { if (e.target === e.currentTarget) input.focus(); } },
      state.add.map((tag) => el('span', { class: 'tag' }, tag,
        el('button', {
          type: 'button', 'aria-label': `Don’t add ${tag}`, title: 'Don’t add',
          onclick: () => { state.add = state.add.filter((t) => t !== tag); changedTags(); },
        }, icon('x')))),
      input,
      el('datalist', { id: 'bulk-tag-options' },
        state.allTags.filter((t) => !state.add.some((a) => lower(a) === lower(t.name)))
          .map((t) => el('option', { value: t.name })))),
    existing.length
      ? [el('p', { class: 'chips-label' }, 'Remove from all of them:'),
        el('div', { class: 'chips' }, existing.map(({ name, count }) => {
          const removing = state.remove.has(lower(name));
          return el('button', {
            class: `chip bulk-remove${removing ? ' removing' : ''}`, type: 'button', 'aria-pressed': String(removing),
            dataset: { tag: lower(name) },
            title: removing ? 'Keep this tag' : `Remove “${name}” from the selected words`,
            onclick: () => {
              if (removing) state.remove.delete(lower(name));
              else {
                state.remove.add(lower(name));
                state.add = state.add.filter((t) => lower(t) !== lower(name));
              }
              changedTags(lower(name));
            },
          }, removing && icon('x'), name,
          total > 1 && el('span', { class: 'chip-count' }, count === total ? 'all' : `${count} of ${total}`));
        }))]
      : el('p', { class: 'hint' }, 'None of these have tags yet.'));
}

// Re-draws the tags after a change and puts focus back: on the "remove" chip that was
// toggled (lowercase name), otherwise in the field for adding tags.
function changedTags(chipTag) {
  renderTags();
  updateApply();
  const chip = chipTag && [...tagsBox.querySelectorAll('.bulk-remove')].find((b) => b.dataset.tag === chipTag);
  (chip || tagsBox.querySelector('input')).focus();
}

// ----- Where I found it -----

// Shows the value when every selected word has the same one. When they differ, the field
// starts empty and leaving it empty keeps each word's own value; "Clear" empties them all.
function foundField({ name, label, placeholder, maxlength }) {
  const values = new Set(state.words.map((w) => w[name] ?? ''));
  const shared = values.size === 1 ? [...values][0] : null;
  const input = el('input', {
    class: 'field', type: 'text', maxlength, value: shared ?? '',
    placeholder: shared === null ? 'Various · leave empty to keep' : placeholder,
  });
  const clear = shared === null && el('button', { class: 'link-button', type: 'button' }, 'Clear on all');
  const update = () => {
    const value = input.value.trim();
    if (shared === null ? value === '' : value === shared.trim()) delete state.fields[name];
    else state.fields[name] = value;
    updateApply();
  };
  input.addEventListener('input', update);
  if (clear) {
    clear.addEventListener('click', () => {
      const clearing = state.fields[name] !== '';
      if (clearing) state.fields[name] = '';
      else delete state.fields[name];
      input.value = '';
      input.disabled = clearing;
      input.placeholder = clearing ? 'Will be cleared on all' : 'Various · leave empty to keep';
      clear.textContent = clearing ? 'Undo' : 'Clear on all';
      updateApply();
    });
  }
  return el('label', { class: `found-field ${name}` },
    el('span', {}, label, clear && ' · ', clear),
    input);
}

// ----- Applying -----

const typedTag = () => tagsBox?.querySelector('input')?.value.trim() ?? '';

function hasChanges() {
  return Boolean(state) && (state.add.length > 0 || state.remove.size > 0
    || Object.keys(state.fields).length > 0 || typedTag() !== '');
}

function updateApply() {
  applyButton.disabled = !hasChanges();
  applyButton.textContent = state.words.length === 1 ? 'Apply' : `Apply to all ${state.words.length}`;
}

async function apply() {
  // A tag still being typed is added too.
  if (typedTag()) tagsBox.querySelector('input').dispatchEvent(new Event('change'));
  if (!hasChanges()) return;
  const { words, add, remove, fields } = state;
  const removeNames = [...new Set(words.flatMap((w) => w.tags))].filter((t) => remove.has(lower(t)));
  applyButton.disabled = true;
  applyButton.textContent = 'Saving…';
  try {
    const ids = words.map((w) => w.id);
    await api.bulkEditWords({ ids, add_tags: add, remove_tags: removeNames, ...fields });
    dialog.close();
    toast(`Updated ${plural(ids.length, words.every((w) => w.kind === 'phrase') ? 'phrase' : 'word')}`);
    hooks.onApplied?.(ids);
  } catch (err) {
    toast(err.message);
    updateApply();
  }
}
