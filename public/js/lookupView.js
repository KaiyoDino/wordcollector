// Dictionary: look up any word or phrase without saving it (press D). From here you can
// add it to your library, open it if it's already saved, or compare it with another word.
import { api } from './api.js';
import { el, icon } from './dom.js';
import { openOverlay } from './overlay.js';
import { renderProfile, fromLookup } from './profile.js';

const overlay = document.getElementById('lookup');
const form = document.getElementById('lookup-form');
const input = document.getElementById('lookup-term');
const body = document.getElementById('lookup-body');

const MAX_RECENT = 12;
let hooks = {};
let current = null;      // the profile being shown
let recent = [];         // terms looked up this session, newest first
let requestId = 0;

export function initLookupView(callbacks) {
  hooks = callbacks;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookUp(input.value);
  });
}

export function openLookup(term = '') {
  openOverlay(overlay, { focus: input });
  input.select();
  if (term) lookUp(term);
  else if (!current) renderStart();
}

// Called after a word is saved anywhere, so the "Add" button here turns into "Open".
export function noteAdded(word) {
  if (current && current.term.toLowerCase() === word.term.toLowerCase()) {
    current = { ...current, inLibrary: true, id: word.id };
    renderResult();
  }
}

function renderStart() {
  body.replaceChildren(el('div', { class: 'overlay-empty' },
    el('p', {}, 'Look up any word or phrase. Nothing is saved unless you choose Add to library.'),
    recent.length > 0 && [
      el('p', { class: 'chips-label' }, 'Recent lookups'),
      el('div', { class: 'chips' }, recent.map((t) =>
        el('button', { class: 'chip', type: 'button', onclick: () => lookUp(t) }, t))),
    ]));
}

async function lookUp(raw) {
  const term = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!term) return;
  input.value = term;
  const id = ++requestId;
  body.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }), `Looking up “${term}”…`));
  try {
    const result = await api.lookup(term);
    if (id !== requestId) return;
    current = { ...fromLookup(result), keyProblem: result.sources.some((s) => s.status === 'disabled' || s.invalidKey),
      unavailable: result.unavailable };
    recent = [term, ...recent.filter((t) => t.toLowerCase() !== term.toLowerCase())].slice(0, MAX_RECENT);
    renderResult();
  } catch (err) {
    if (id !== requestId) return;
    body.replaceChildren(el('p', { class: 'notice' }, err.message));
  }
}

function actions() {
  const p = current;
  return el('div', { class: 'profile-actions' },
    p.inLibrary
      ? el('button', { class: 'btn', type: 'button', onclick: () => hooks.onOpen?.(p.id) }, 'In your library · Open')
      : el('button', {
        class: 'btn primary', type: 'button', onclick: () => hooks.onAdd?.(p.term),
      }, icon('plus'), 'Add to library'),
    el('button', { class: 'btn ghost', type: 'button', onclick: () => hooks.onCompare?.(p.term) },
      icon('compare'), 'Compare with…'),
  );
}

function renderResult() {
  const p = current;
  const nodes = [];
  if (p.keyProblem) {
    nodes.push(el('div', { class: 'notice' },
      'Add your free Merriam-Webster keys in Settings to look words up.',
      el('div', { class: 'chips' },
        el('button', { class: 'chip', type: 'button', onclick: () => hooks.onOpenKeys?.() }, 'Open Settings'))));
  } else if (!p.found && p.unavailable?.length) {
    nodes.push(el('div', { class: 'notice' }, `Couldn’t reach ${p.unavailable.join(' or ')}. Try again in a moment.`));
  } else if (!p.found) {
    nodes.push(el('div', { class: 'notice' },
      `Merriam-Webster doesn’t have “${p.term}”.`,
      p.suggestions?.length > 0 && [
        el('p', { class: 'chips-label' }, 'Did you mean…'),
        el('div', { class: 'chips' }, p.suggestions.map((s) =>
          el('button', { class: 'chip', type: 'button', onclick: () => lookUp(s) }, s))),
      ]));
  }
  if (p.found || p.inLibrary) {
    nodes.push(actions(), renderProfile(p, {
      onPickTerm: lookUp,
      library: hooks.libraryTerms?.() ?? new Map(),
    }));
  } else if (!p.keyProblem) {
    // Not in the dictionary: it can still be saved with your own definition.
    nodes.push(actions());
  }
  body.replaceChildren(el('div', { class: 'overlay-content' }, nodes));
  body.scrollTop = 0;
}
