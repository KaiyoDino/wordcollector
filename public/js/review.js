// Flashcard review: see the word, recall the meaning, reveal, then mark whether you knew it.
import { api } from './api.js';
import { el, icon, toast, playAudio } from './dom.js';

const overlay = document.getElementById('review');
const body = document.getElementById('review-body');
const progress = document.getElementById('review-progress');

let hooks = {};
let queue = [];
let index = 0;
let known = 0;
let revealed = false;
let lastOptions = null;
let lastFocus = null;
let busy = false;

export function initReview(callbacks) {
  hooks = callbacks;
  document.getElementById('review-close').addEventListener('click', closeReview);
  document.addEventListener('keydown', onKey);
}

export function openReview() {
  lastFocus = document.activeElement;
  overlay.hidden = false;
  overlay.classList.add('open');
  document.body.classList.add('no-scroll');
  renderStart();
}

function closeReview() {
  overlay.classList.remove('open');
  overlay.hidden = true;
  document.body.classList.remove('no-scroll');
  queue = [];
  hooks.onClosed?.();
  lastFocus?.focus?.();
}

function onKey(e) {
  if (overlay.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeReview(); return; }
  if (!queue.length || index >= queue.length || e.target.closest('select, input')) return;
  if (e.key === ' ' && !revealed) { e.preventDefault(); reveal(); }
  else if (revealed && e.key === 'ArrowLeft') { e.preventDefault(); answer(false); }
  else if (revealed && e.key === 'ArrowRight') { e.preventDefault(); answer(true); }
}

async function renderStart() {
  progress.textContent = '';
  const tags = await api.listTags().catch(() => []);
  const scope = el('select', { class: 'field', 'aria-label': 'Words to review' },
    el('option', { value: 'all' }, 'Everything'),
    el('option', { value: 'word' }, 'Words only'),
    el('option', { value: 'phrase' }, 'Phrases only'),
    el('option', { value: 'fav' }, 'Favorites'),
    tags.map((t) => el('option', { value: `tag:${t.name}` }, `Tag: ${t.name} (${t.count})`)));
  if (lastOptions) scope.value = lastOptions.value;

  const start = el('button', {
    class: 'btn primary', type: 'button',
    onclick: () => {
      const value = scope.value;
      lastOptions = {
        value,
        favorites: value === 'fav',
        kind: value === 'word' || value === 'phrase' ? value : '',
        tag: value.startsWith('tag:') ? value.slice(4) : '',
      };
      begin();
    },
  }, 'Start review');

  body.replaceChildren(el('div', { class: 'review-card start' },
    el('h3', {}, 'Flashcards'),
    el('p', { class: 'hint' },
      'You’ll see a word or phrase. Think of what it means, then reveal the definition and mark whether you knew it. ',
      'Words you miss come back sooner.'),
    el('label', { class: 'found-field' }, el('span', {}, 'Review'), scope),
    el('p', { class: 'hint keys' }, 'Keys: Space reveals · ← didn’t know · → knew it · Esc exits'),
    start));
  start.focus();
}

async function begin() {
  try {
    queue = await api.reviewBatch({ tag: lastOptions.tag, favorites: lastOptions.favorites, kind: lastOptions.kind, limit: 20 });
  } catch (err) {
    toast(err.message);
    return;
  }
  index = 0;
  known = 0;
  if (!queue.length) {
    body.replaceChildren(el('div', { class: 'review-card start' },
      el('h3', {}, 'Nothing to review'),
      el('p', { class: 'hint' }, 'There are no words in this selection yet.'),
      el('button', { class: 'btn', type: 'button', onclick: renderStart }, 'Back')));
    return;
  }
  renderCard();
}

function renderCard() {
  const word = queue[index];
  revealed = false;
  progress.textContent = `${index + 1} of ${queue.length}`;
  const showButton = el('button', { class: 'btn primary', type: 'button', onclick: reveal }, 'Show definition');
  body.replaceChildren(el('div', { class: 'review-card' },
    el('p', { class: 'review-term' }, word.term),
    el('div', { class: 'word-sub review-sub' },
      word.pronunciation && el('span', { class: 'pron' }, word.pronunciation),
      word.audio_url && el('button', {
        class: 'btn ghost small icon-only audio', type: 'button', 'aria-label': 'Play pronunciation',
        onclick: () => playAudio(word.audio_url),
      }, icon('play')),
      word.primary_pos && el('span', { class: 'badge' }, word.primary_pos)),
    el('div', { id: 'review-answer', class: 'review-answer' }),
    el('div', { class: 'review-actions' }, showButton)));
  showButton.focus();
}

function reveal() {
  const word = queue[index];
  revealed = true;
  const [main, ...rest] = word.definitions;
  const answerBox = body.querySelector('#review-answer');
  // el() flattens arrays and skips empty values; replaceChildren doesn't.
  answerBox.replaceChildren(el('div', {},
    main
      ? [el('p', { class: 'review-main' }, main.text),
        main.examples[0] && el('span', { class: 'example' }, main.examples[0]),
        rest.length > 0 && el('details', {},
          el('summary', {}, `${rest.length} more definition${rest.length === 1 ? '' : 's'}`),
          el('ol', { class: 'defs' }, rest.map((d) => el('li', {}, d.text))))]
      : el('p', { class: 'status-note' }, 'This word has no definitions yet.'),
    word.notes && el('p', { class: 'review-notes' }, el('strong', {}, 'Your notes: '), word.notes),
  ));
  const knewIt = el('button', { class: 'btn primary', type: 'button', onclick: () => answer(true) }, 'Knew it →');
  body.querySelector('.review-actions').replaceChildren(
    el('button', { class: 'btn', type: 'button', onclick: () => answer(false) }, '← Didn’t know'),
    knewIt,
  );
  knewIt.focus();
}

async function answer(knewIt) {
  if (busy) return;
  busy = true;
  try {
    await api.recordReview(queue[index].id, knewIt);
    if (knewIt) known++;
    index++;
    if (index < queue.length) renderCard();
    else renderDone();
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false;
  }
}

function renderDone() {
  progress.textContent = '';
  const again = el('button', { class: 'btn primary', type: 'button', onclick: begin }, 'Review again');
  body.replaceChildren(el('div', { class: 'review-card start' },
    el('h3', {}, 'Session complete'),
    el('p', { class: 'review-score' }, `You knew ${known} of ${queue.length}`),
    el('div', { class: 'review-actions' },
      el('button', { class: 'btn', type: 'button', onclick: renderStart }, 'Change selection'),
      again,
      el('button', { class: 'btn ghost', type: 'button', onclick: closeReview }, 'Done'))));
  again.focus();
}
