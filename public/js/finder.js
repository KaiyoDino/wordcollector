// Find a word (press F): describe a meaning ("getting something done quickly") or type a
// word that doesn't exist ("habitualize"), and AI suggests real words for it. Uses the
// same AI provider and key as the explanations in Compare.
import { api } from './api.js';
import { el, icon } from './dom.js';
import { openOverlay } from './overlay.js';
import { attachHistory, recentSearches, rememberSearch } from './history.js';

const overlay = document.getElementById('finder');
const form = document.getElementById('finder-form');
const input = document.getElementById('finder-query');
const body = document.getElementById('finder-body');

const HISTORY = 'finderHistory';
const EXAMPLES = ['getting something done quickly', 'habitualize', 'a person who loves books', 'the smell of rain on dry ground'];
const PROVIDER_NAMES = { groq: 'Groq', anthropic: 'Anthropic' };

let hooks = {};
let result = null;
let ai = null;          // AI status, fetched when the screen first needs it
let requestId = 0;

export function initFinder(callbacks) {
  hooks = callbacks;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    find(input.value);
  });
  attachHistory(input, { key: HISTORY, onPick: find, label: 'Recent' });
  // Coming back from Settings (perhaps with a new key): check the AI again.
  document.getElementById('settings-dialog').addEventListener('close', () => {
    ai = null;
    if (!overlay.hidden && !result) renderStart();
  });
}

export function openFinder(query = '') {
  openOverlay(overlay, { focus: input });
  input.select();
  if (query) find(query);
  else if (!result) renderStart();
}

async function aiStatus() {
  ai ??= await api.getAi().catch(() => ({ available: false }));
  return ai;
}

function noAiNotice() {
  return el('div', { class: 'notice' },
    'Find a word uses AI, like the explanations in Compare. Add a free Groq API key in Settings to use it.',
    el('div', { class: 'chips' },
      el('button', { class: 'chip', type: 'button', onclick: () => hooks.onOpenKeys?.('groq') }, 'Open Settings')));
}

const termChips = (terms) => el('div', { class: 'chips' }, terms.map((t) =>
  el('button', { class: 'chip', type: 'button', onclick: () => find(t) }, t)));

async function renderStart() {
  const id = ++requestId;
  const status = await aiStatus();
  if (id !== requestId) return;
  const recent = recentSearches(HISTORY);
  body.replaceChildren(el('div', { class: 'overlay-content' },
    el('div', { class: 'overlay-empty finder-intro' },
      el('p', {}, 'Describe what you mean and get the word for it, or type a word you made up to find the real one.'),
      !status.available && noAiNotice(),
      status.available && [el('p', { class: 'chips-label' }, 'Try'), termChips(EXAMPLES)],
      status.available && recent.length > 0 && [el('p', { class: 'chips-label' }, 'Recent'), termChips(recent)])));
}

async function find(raw) {
  const query = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!query) return;
  input.value = query;
  const id = ++requestId;
  body.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }), `Finding words for “${query}”…`));
  const status = await aiStatus();
  if (id !== requestId) return;
  if (!status.available) {
    body.replaceChildren(el('div', { class: 'overlay-content' }, noAiNotice()));
    return;
  }
  try {
    const data = await api.suggest(query);
    if (id !== requestId) return;
    result = data;
    rememberSearch(HISTORY, query);
    renderResult();
  } catch (err) {
    if (id !== requestId) return;
    body.replaceChildren(el('div', { class: 'overlay-content' },
      el('div', { class: 'notice' }, err.message,
        el('div', { class: 'chips' }, el('button', { class: 'chip', type: 'button', onclick: () => find(query) }, 'Try again')))));
  }
}

function credit() {
  const model = String(result.model ?? '').replace(/^.*\//, '');
  const via = PROVIDER_NAMES[result.provider];
  return via ? `${model} via ${via}` : model || 'AI';
}

function suggestion(s) {
  const lookUp = () => hooks.onLookup?.(s.word);
  return el('li', { class: 'suggestion' },
    el('div', { class: 'suggestion-head' },
      el('button', { class: 'suggestion-word', type: 'button', title: 'Look it up in the dictionary', onclick: lookUp }, s.word),
      s.pos && el('span', { class: 'badge' }, s.pos),
      s.id && el('span', { class: 'badge muted' }, 'in your library')),
    s.meaning && el('p', { class: 'suggestion-meaning' }, s.meaning),
    s.example && el('span', { class: 'example' }, s.example),
    el('div', { class: 'suggestion-actions' },
      el('button', { class: 'btn ghost small', type: 'button', onclick: lookUp }, icon('book'), 'Look up'),
      s.id
        ? el('button', { class: 'btn ghost small', type: 'button', onclick: () => hooks.onOpen?.(s.id) }, 'Open in library')
        : el('button', { class: 'btn ghost small', type: 'button', onclick: () => hooks.onAdd?.(s.word) }, icon('plus'), 'Add to library')));
}

function renderResult() {
  body.replaceChildren(el('div', { class: 'overlay-content' },
    el('h3', { class: 'finder-heading' }, 'Words for ', el('em', {}, `“${result.query}”`)),
    result.note && el('p', { class: 'finder-note' }, icon('sparkle'), el('span', {}, result.note)),
    el('ol', { class: 'suggestions' }, result.suggestions.map(suggestion)),
    el('p', { class: 'hint attribution' },
      `Suggested by AI (${credit()}). AI can make mistakes; look a word up to check it.`)));
  body.scrollTop = 0;
}

// Called after a word is saved anywhere, so its suggestion offers "Open in library".
export function noteAddedToFinder(word) {
  const match = result?.suggestions.find((s) => s.word.toLowerCase() === word.term.toLowerCase());
  if (!match) return;
  match.id = word.id;
  // Only when the suggestions are what's showing (not a newer search that's loading).
  if (body.querySelector('.suggestions')) renderResult();
}
