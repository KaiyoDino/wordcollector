// "Add to library" dialog: preview what the dictionary returns, choose which parts of
// speech to keep, optionally add notes / where you found it / tags, then save.
import { api, ApiError } from './api.js';
import { el, toast } from './dom.js';
import { openKeySettings } from './keys.js';

const dialog = document.getElementById('add-dialog');
const form = document.getElementById('add-form');
const input = document.getElementById('add-term');
const preview = document.getElementById('add-preview');
const saveButton = document.getElementById('add-save');
const posFieldset = document.getElementById('add-pos');
const posOptions = document.getElementById('add-pos-options');
const extras = document.getElementById('add-extras');
const extraFields = {
  notes: document.getElementById('add-notes'),
  found_title: document.getElementById('add-found-title'),
  found_author: document.getElementById('add-found-author'),
  found_page: document.getElementById('add-found-page'),
};
const tagsInput = document.getElementById('add-tags');
const tagOptions = document.getElementById('add-tag-options');

let hooks = {};
let result = null;     // last lookup result, valid only while result.term matches the input
let requestId = 0;
let chosenPos = null;  // Set of parts of speech to save, or null when there's no choice to make

export function initAddDialog(callbacks) {
  hooks = callbacks;

  // Close buttons are type="button" so Enter in the input never triggers them.
  form.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  // The Look up button always looks up. Enter in the field saves once a preview is showing.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookup();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (result && sameTerm(result.term)) save();
    else lookup();
  });
  // Coming back from Settings after adding keys: look the word up again.
  document.getElementById('settings-dialog').addEventListener('close', () => {
    if (dialog.open && result?.sources.some(keyProblem)) lookup();
  });
  input.addEventListener('input', () => {
    if (result && !sameTerm(result.term)) {
      result = null;
      chosenPos = null;
      posFieldset.hidden = true;
      preview.replaceChildren();
    }
    updateSaveButton();
  });
  saveButton.addEventListener('click', save);
  dialog.addEventListener('close', () => { requestId++; });
}

const keyProblem = (s) => s.status === 'disabled' || s.invalidKey;
const sameTerm = (term) => term.toLowerCase() === input.value.trim().toLowerCase();

export function openAddDialog(term = '') {
  result = null;
  chosenPos = null;
  preview.replaceChildren();
  posFieldset.hidden = true;
  for (const field of Object.values(extraFields)) field.value = '';
  tagsInput.value = '';
  extras.open = false;
  api.listTags().then((tags) => {
    tagOptions.replaceChildren(...tags.map((t) => el('option', { value: t.name })));
  }).catch(() => {});
  input.value = term;
  updateSaveButton();
  if (!dialog.open) dialog.showModal();
  input.focus();
  if (term) lookup();
}

function updateSaveButton(busy = false) {
  const term = input.value.trim();
  saveButton.disabled = busy || !term;
  saveButton.textContent =
    result?.existingId ? 'Open in library'
    : result && !result.found ? 'Save without definition'
    : 'Add to library';
}

async function lookup() {
  const term = input.value.trim();
  if (!term) return;
  const id = ++requestId;
  preview.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }), 'Checking dictionaries…'));
  try {
    const data = await api.lookup(term);
    if (id !== requestId) return;
    result = data;
    renderPosChoice();
    renderPreview();
  } catch (err) {
    if (id !== requestId) return;
    preview.replaceChildren(el('p', { class: 'notice' }, err.message));
  }
  updateSaveButton();
}

const STATE_TEXT = {
  not_found: 'Not found',
  disabled: 'Off: no API key',
  invalid: 'Invalid API key',
};

const MAX_SAVED_DEFINITIONS = 20; // matches server/words.js

// Whether a definition or synonym belongs to the parts of speech being saved.
const kept = (pos) => !chosenPos || !pos || chosenPos.has(pos);
const keptDefinitions = (source) => source.definitions.filter((d) => kept(d.part_of_speech));

function sourceState(source) {
  if (source.status === 'found') {
    if (source.id === 'merriam-webster-thesaurus') {
      const n = (kind) => new Set(result[kind]
        .filter((r) => r.source === source.id && kept(r.part_of_speech))
        .map((r) => r.value.toLowerCase())).size;
      return { text: `${n('synonyms')} synonyms · ${n('antonyms')} antonyms`, ok: true };
    }
    const count = keptDefinitions(source).length;
    // The server keeps at most 20, shared between the chosen parts of speech.
    const saved = count > MAX_SAVED_DEFINITIONS ? ` · ${MAX_SAVED_DEFINITIONS} will be saved` : '';
    return { text: `${count} definition${count === 1 ? '' : 's'}${saved}`, ok: true };
  }
  if (source.invalidKey) return { text: STATE_TEXT.invalid };
  if (source.status === 'error') return { text: `Unavailable (${source.message})` };
  return { text: STATE_TEXT[source.status] ?? source.status };
}

function renderPreview() {
  const nodes = [];
  const dictionaryKeyProblem = keyProblem(result.sources[0]);
  if (result.sources.some(keyProblem)) {
    nodes.push(el('div', { class: 'notice' },
      'Add your free Merriam-Webster keys in Settings to fill in definitions and synonyms automatically.',
      el('div', { class: 'chips' },
        el('button', { class: 'chip', type: 'button', onclick: () => openKeySettings() }, 'Open Settings'))));
  }
  if (result.existingId) {
    nodes.push(el('p', { class: 'notice' }, `“${result.term}” is already in your library.`));
  } else if (dictionaryKeyProblem) {
    // The key notice above already explains why nothing was found.
  } else if (!result.found && result.unavailable.length) {
    nodes.push(el('div', { class: 'notice' },
      `Couldn’t reach ${result.unavailable.join(' or ')}. Try again, or save now and use Refresh definitions later.`,
      el('div', { class: 'chips' },
        el('button', { class: 'chip', type: 'button', onclick: lookup }, 'Try again'))));
  } else if (!result.found) {
    nodes.push(el('div', { class: 'notice' },
      'No dictionary has this word. You can still save it and add your own definition.',
      result.suggestions?.length && [
        el('p', { class: 'chips-label' }, 'Did you mean…'),
        el('div', { class: 'chips' }, result.suggestions.map((s) =>
          el('button', { class: 'chip', type: 'button', onclick: () => { input.value = s; lookup(); } }, s))),
      ]));
  }

  for (const source of result.sources) {
    const state = sourceState(source);
    nodes.push(el('div', { class: 'preview-source' },
      el('div', { class: 'name' }, source.name, el('span', { class: `state${state.ok ? ' ok' : ''}` }, state.text)),
      keptDefinitions(source).length > 0 && el('ol', {}, keptDefinitions(source).slice(0, 3).map((d) =>
        el('li', {}, d.part_of_speech && el('em', {}, `${d.part_of_speech} · `), d.text))),
    ));
  }
  preview.replaceChildren(...nodes);
}

// Checkboxes for words with more than one part of speech ("base": noun, verb, adjective).
function renderPosChoice() {
  const offered = result.existingId ? [] : result.partsOfSpeech ?? [];
  if (offered.length < 2) {
    chosenPos = null;
    posFieldset.hidden = true;
    return;
  }
  chosenPos = new Set(offered.map((p) => p.pos));
  posOptions.replaceChildren(...offered.map(({ pos, count }) => {
    const box = el('input', { type: 'checkbox', value: pos, checked: true });
    box.addEventListener('change', () => {
      if (box.checked) chosenPos.add(pos);
      else if (chosenPos.size > 1) chosenPos.delete(pos);
      else {
        box.checked = true;
        toast('Keep at least one part of speech.');
        return;
      }
      renderPreview();
    });
    return el('label', { class: 'pos-option' }, box, el('span', {}, pos),
      el('span', { class: 'pos-count' }, `${count}`));
  }));
  posFieldset.hidden = false;
}

function details() {
  const out = {};
  for (const [key, field] of Object.entries(extraFields)) {
    if (field.value.trim()) out[key] = field.value;
  }
  const tags = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.length) out.tags = tags;
  if (chosenPos && result && sameTerm(result.term)) out.parts_of_speech = [...chosenPos];
  return out;
}

async function save() {
  const term = input.value.trim();
  if (!term) return;
  if (result?.existingId && sameTerm(result.term)) {
    dialog.close();
    hooks.onOpen?.(result.existingId);
    return;
  }
  updateSaveButton(true);
  saveButton.textContent = 'Saving…';
  try {
    const word = await api.addWord(term, details());
    dialog.close();
    hooks.onAdded?.(word);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body?.id) {
      dialog.close();
      hooks.onOpen?.(err.body.id);
    } else {
      toast(err.message);
      updateSaveButton();
    }
  }
}
