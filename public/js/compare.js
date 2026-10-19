// Compare two words or phrases side by side (press C), with Merriam-Webster's synonym
// discussion when it covers the pair, an optional AI explanation, and saved comparisons.
import { api } from './api.js';
import { el, fill, icon, toast, debounce } from './dom.js';
import { openOverlay } from './overlay.js';
import { renderProfile, discussion } from './profile.js';

const overlay = document.getElementById('compare');
const form = document.getElementById('compare-form');
const inputA = document.getElementById('compare-a');
const inputB = document.getElementById('compare-b');
const options = document.getElementById('compare-options');
const body = document.getElementById('compare-body');
const tabs = overlay.querySelectorAll('[data-tab]');
const savedCount = document.getElementById('saved-count');

const PROVIDER_NAMES = { groq: 'Groq', anthropic: 'Anthropic' };

let hooks = {};
let result = null;
let requestId = 0;
let tab = 'compare';
let saved = [];          // saved comparisons, newest first
let comparing = false;   // a comparison is loading

export function initCompare(callbacks) {
  hooks = callbacks;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
  document.getElementById('compare-swap').addEventListener('click', () => {
    [inputA.value, inputB.value] = [inputB.value, inputA.value];
    if (inputA.value.trim() && inputB.value.trim()) run();
  });
  tabs.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    button.addEventListener('click', () => showTab(button.dataset.tab));
  });
  // Coming back from Settings (a new key or provider): refresh the AI part of the result.
  document.getElementById('settings-dialog').addEventListener('close', () => {
    if (!overlay.hidden && result && tab === 'compare') run();
  });
}

// a/b set the two fields ('' clears one, undefined keeps what was there); when both end up
// filled, the comparison runs right away.
export function openCompare(a, b) {
  options.replaceChildren(...[...(hooks.libraryTerms?.() ?? new Map()).keys()].sort()
    .map((term) => el('option', { value: term })));
  if (a !== undefined) inputA.value = a;
  if (b !== undefined) inputB.value = b;
  const focus = !inputA.value.trim() ? inputA : !inputB.value.trim() ? inputB : null;
  openOverlay(overlay, { focus: focus ?? inputA });
  loadSaved();
  if (!focus) run();
  else if (!result) showTab('compare');
}

async function loadSaved() {
  try {
    saved = await api.listSavedComparisons();
  } catch {
    saved = [];
  }
  savedCount.textContent = saved.length ? `(${saved.length})` : '';
  if (tab === 'saved') renderSaved();
  else if (!result && !comparing) renderStart();
}

function showTab(name) {
  tab = name;
  tabs.forEach((button) => {
    const active = button.dataset.tab === name;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-selected', String(active));
  });
  if (name === 'saved') renderSaved();
  else if (result) render();
  else renderStart();
}

function renderStart() {
  body.replaceChildren(el('div', { class: 'overlay-content' },
    el('p', { class: 'overlay-empty' },
      'Pick two words or phrases, from your library or anywhere, to see them side by side and how they differ.'),
    saved.length > 0 && [el('h3', { class: 'saved-heading' }, 'Saved comparisons'), savedList()]));
}

// ----- Saved comparisons -----

function openSaved(item) {
  inputA.value = item.term_a;
  inputB.value = item.term_b;
  run();
}

function savedList() {
  return el('ul', { class: 'saved-list' }, saved.map((item) => el('li', { class: 'saved-item' },
    el('button', {
      class: 'saved-open', type: 'button', onclick: () => openSaved(item),
      'aria-label': `Open comparison of ${item.term_a} and ${item.term_b}`,
    },
    el('span', { class: 'saved-pair' }, item.term_a, el('span', { class: 'vs' }, ' vs '), item.term_b),
    item.note && el('span', { class: 'saved-note' }, item.note),
    el('span', { class: 'saved-meta' },
      item.has_explanation && el('span', { class: 'badge' }, icon('sparkle'), 'AI'),
      `Saved ${new Date(item.created_at).toLocaleDateString()}`)),
    el('button', {
      class: 'btn ghost small icon-only', type: 'button', title: 'Remove',
      'aria-label': `Remove saved comparison of ${item.term_a} and ${item.term_b}`,
      onclick: () => removeSaved(item),
    }, icon('x')))));
}

function renderSaved() {
  body.replaceChildren(el('div', { class: 'overlay-content' },
    saved.length
      ? [el('h3', { class: 'saved-heading' }, 'Saved comparisons'), savedList()]
      : el('p', { class: 'overlay-empty' },
        'No saved comparisons yet. Compare two words, then choose Save comparison to keep it here with your own note.')));
}

async function removeSaved(item) {
  try {
    await api.removeSavedComparison(item.id);
    if (result?.saved?.id === item.id) result.saved = null;
    toast(`Removed “${item.term_a} vs ${item.term_b}”`);
    await loadSaved();
  } catch (err) {
    toast(err.message);
  }
}

// Where the Save toggle and the note go in the comparison; filled by showSavedState().
let toggleSlot = null;
let noteSlot = null;

function showSavedState({ editNote = false } = {}) {
  fill(toggleSlot, saveToggle());
  fill(noteSlot, result.saved && noteBlock({ editing: editNote }));
}

// "Save comparison", or once saved, a pressed "Saved" button that removes it again.
function saveToggle() {
  const { left, right } = result;
  if (!result.saved) {
    return el('button', {
      class: 'btn small save-toggle', type: 'button', 'aria-pressed': 'false',
      onclick: async () => {
        try {
          result.saved = await api.saveComparison(left.term, right.term);
          showSavedState();
          toggleSlot.querySelector('button')?.focus();
          loadSaved();
        } catch (err) {
          toast(err.message);
        }
      },
    }, icon('bookmark'), 'Save comparison');
  }
  const { id, note } = result.saved;
  return el('button', {
    class: 'btn small save-toggle', type: 'button', 'aria-pressed': 'true',
    title: 'Saved. Click to remove it from Saved.',
    onclick: async () => {
      if (note && !confirm('Remove this comparison and your note from Saved?')) return;
      await removeSaved({ id, term_a: left.term, term_b: right.term });
      if (result && !result.saved) showSavedState();
    },
  }, icon('bookmark'), 'Saved');
}

// Your note on a saved comparison: an "Add a note" button, the note itself (click to edit),
// or the editor, which saves as you type and goes back to the note when you leave it.
function noteBlock({ editing }) {
  const { id, note = '' } = result.saved;
  const edit = () => {
    fill(noteSlot, noteBlock({ editing: true }));
    const area = noteSlot.querySelector('textarea');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  };
  if (!editing && !note) {
    return el('button', { class: 'note-add', type: 'button', onclick: edit }, icon('pencil'), 'Add a note');
  }
  if (!editing) {
    return el('figure', { class: 'cmp-note' },
      el('figcaption', {}, 'Your note',
        el('button', {
          class: 'btn ghost small icon-only', type: 'button', title: 'Edit note', 'aria-label': 'Edit note', onclick: edit,
        }, icon('pencil'))),
      el('p', { class: 'cmp-note-text', title: 'Click to edit', onclick: edit }, note));
  }

  const status = el('span', { class: 'notes-status', role: 'status' });
  let lastSaved = note;
  const save = debounce(async (text) => {
    if (text.trim() === lastSaved.trim()) return;
    lastSaved = text;
    status.textContent = 'Saving…';
    try {
      const updated = await api.updateSavedComparison(id, text);
      if (result?.saved?.id === id) result.saved = { ...updated, note: result.saved.note };
      status.textContent = 'Saved';
      loadSaved();
    } catch (err) {
      lastSaved = note;
      status.textContent = 'Not saved';
      toast(err.message);
    }
  }, 700);
  // Back to showing the note; the last change is saved straight away.
  const finish = () => {
    if (!area.isConnected) return;
    save.flush(area.value);
    if (result?.saved?.id === id) {
      result.saved = { ...result.saved, note: area.value.trim() };
      fill(noteSlot, noteBlock({ editing: false }));
    }
  };
  const area = el('textarea', {
    class: 'field', rows: 3, maxlength: 2000, value: note,
    placeholder: 'Why these two, where you mixed them up, a way to remember the difference…',
    'aria-label': 'Note for this comparison',
    oninput: () => { status.textContent = ''; save(area.value); },
    onblur: finish,
    onkeydown: (e) => {
      // Esc finishes the note instead of closing Compare.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
    },
  });
  return el('figure', { class: 'cmp-note editing' },
    el('figcaption', {}, 'Your note', status),
    area,
    el('div', { class: 'cmp-note-foot' },
      el('span', { class: 'hint' }, 'Saves as you type'),
      el('button', { class: 'btn small', type: 'button', onclick: finish }, 'Done')));
}

// ----- Comparing -----

async function run() {
  const a = inputA.value.trim();
  const b = inputB.value.trim();
  if (!a || !b) {
    (a ? inputB : inputA).focus();
    return;
  }
  if (tab !== 'compare') showTab('compare');
  const id = ++requestId;
  comparing = true;
  body.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }), `Comparing “${a}” and “${b}”…`));
  try {
    const data = await api.compare(a, b);
    if (id !== requestId) return;
    result = data;
    render();
  } catch (err) {
    if (id !== requestId) return;
    body.replaceChildren(el('p', { class: 'notice' }, err.message));
  } finally {
    if (id === requestId) comparing = false;
  }
}

// Plain-text explanation: one paragraph per line, "Example:" lines styled. Some models put
// everything on one line, so sentences starting "Use …" or "Example:" also begin a new line.
function explanationText(text) {
  const lines = text.replace(/([.!?])\s+(?=Use\s|Example:)/g, '$1\n').split(/\n+/);
  return lines.map((line) => line.trim()).filter(Boolean).map((line) => {
    const example = line.match(/^Example:\s*(.*)$/i);
    return example ? el('p', { class: 'example' }, example[1]) : el('p', {}, line);
  });
}

function credit(explanation) {
  const model = String(explanation.model ?? '').replace(/^.*\//, '');
  const via = PROVIDER_NAMES[explanation.provider];
  return via ? `${model} via ${via}` : model || 'AI';
}

function aiBlock() {
  const { left, right, explanation, ai } = result;
  const box = el('div', { class: 'ai-explanation' });
  const explain = async (again) => {
    box.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }),
      `${ai.label ?? 'AI'} is writing an explanation…`));
    try {
      result.explanation = await api.explainComparison(left.term, right.term, again);
      if (result.saved) loadSaved(); // the saved list shows an "AI" badge
    } catch (err) {
      toast(err.message);
    }
    box.replaceWith(aiBlock());
  };

  if (explanation) {
    // fill(), not append(): explanationText() returns a list of paragraphs.
    fill(box,
      el('h4', {}, icon('sparkle'), 'AI explanation'),
      explanationText(explanation.explanation),
      el('p', { class: 'hint attribution' },
        `Written by AI (${credit(explanation)}) on ${new Date(explanation.created_at).toLocaleDateString()}. AI can make mistakes. `,
        ai.available && el('button', { class: 'link-button', type: 'button', onclick: () => explain(true) }, 'Write a new one')));
  } else if (ai.available) {
    box.append(el('button', { class: 'btn', type: 'button', onclick: () => explain(false) },
      icon('sparkle'), 'Explain the difference with AI'),
    el('span', { class: 'hint ai-provider' }, ai.provider === 'groq' ? ' Groq · free' : ' Claude · about 1–2¢'));
  } else {
    box.append(el('p', { class: 'hint' },
      'Want an AI explanation of the difference? Add a free Groq API key in Settings. ',
      el('button', { class: 'link-button', type: 'button', onclick: () => hooks.onOpenKeys?.('groq') }, 'Open Settings')));
  }
  return box;
}

function relationBadges() {
  const { relation, sharedSynonyms } = result;
  const badges = [];
  if (relation.synonyms) badges.push(el('span', { class: 'badge' }, 'Listed as synonyms'));
  if (relation.antonyms) badges.push(el('span', { class: 'badge' }, 'Listed as antonyms'));
  if (sharedSynonyms.length) {
    badges.push(el('span', { class: 'badge muted' }, `${sharedSynonyms.length} shared synonym${sharedSynonyms.length === 1 ? '' : 's'}`));
  }
  return badges.length ? el('div', { class: 'relation-badges' }, badges) : null;
}

function side(profile, which) {
  const replace = (term) => {
    (which === 'left' ? inputA : inputB).value = term;
    run();
  };
  if (!profile.found && !profile.inLibrary) {
    return el('div', { class: 'compare-col' },
      el('h3', { class: 'profile-term' }, profile.term),
      el('p', { class: 'notice' },
        profile.keyProblem ? 'Add your Merriam-Webster keys in Settings to look this up.'
          : profile.unavailable?.length ? 'The dictionary didn’t respond. Try again in a moment.'
            : 'Merriam-Webster doesn’t have this word.'),
      profile.suggestions?.length > 0 && el('div', { class: 'chips' }, profile.suggestions.map((s) =>
        el('button', { class: 'chip', type: 'button', onclick: () => replace(s) }, s))));
  }
  const shared = new Set(result.sharedSynonyms.map((s) => s.toLowerCase()));
  return el('div', { class: 'compare-col' },
    renderProfile(profile, {
      onPickTerm: replace,
      library: hooks.libraryTerms?.() ?? new Map(),
      highlightSynonyms: shared,
      showDiscussion: false,
    }),
    el('div', { class: 'profile-actions' },
      profile.inLibrary
        ? el('button', { class: 'btn small', type: 'button', onclick: () => hooks.onOpen?.(profile.id) }, 'Open in library')
        : profile.found && el('button', { class: 'btn small', type: 'button', onclick: () => hooks.onAdd?.(profile.term) },
          icon('plus'), 'Add to library')));
}

function render() {
  const { left, right } = result;
  const bothFound = (left.found || left.inLibrary) && (right.found || right.inLibrary);
  toggleSlot = el('div', { class: 'save-slot' });
  noteSlot = el('div', { class: 'note-slot' });
  showSavedState();
  body.replaceChildren(el('div', { class: 'overlay-content wide' },
    el('section', { class: 'difference' },
      el('div', { class: 'difference-head' },
        el('h3', {}, `How “${left.term}” and “${right.term}” differ`),
        toggleSlot),
      noteSlot,
      bothFound && relationBadges(),
      bothFound && result.discussion && discussion(result.discussion, { emphasize: [left.term, right.term] }),
      bothFound && !result.discussion && el('p', { class: 'hint' },
        'Merriam-Webster doesn’t discuss these two together. Compare their definitions below.'),
      bothFound && aiBlock()),
    el('div', { class: 'compare-grid' }, side(left, 'left'), side(right, 'right'))));
  body.scrollTop = 0;
}

// Called after a word is saved, so its column shows "Open in library".
export function noteAddedToCompare(word) {
  if (!result || overlay.hidden) return;
  const t = word.term.toLowerCase();
  if ([result.left.term, result.right.term].some((x) => x.toLowerCase() === t)) run();
}
