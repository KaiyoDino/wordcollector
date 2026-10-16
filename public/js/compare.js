// Compare two words or phrases side by side (press C), with Merriam-Webster's synonym
// discussion when it covers the pair and an optional AI explanation.
import { api } from './api.js';
import { el, icon, toast } from './dom.js';
import { openOverlay } from './overlay.js';
import { renderProfile, discussion } from './profile.js';

const overlay = document.getElementById('compare');
const form = document.getElementById('compare-form');
const inputA = document.getElementById('compare-a');
const inputB = document.getElementById('compare-b');
const options = document.getElementById('compare-options');
const body = document.getElementById('compare-body');

let hooks = {};
let result = null;
let requestId = 0;

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
  if (!focus) run();
  else if (!result) renderStart();
}

function renderStart() {
  body.replaceChildren(el('div', { class: 'overlay-empty' },
    el('p', {}, 'Pick two words or phrases, from your library or anywhere, to see them side by side and how they differ.')));
}

async function run() {
  const a = inputA.value.trim();
  const b = inputB.value.trim();
  if (!a || !b) {
    (a ? inputB : inputA).focus();
    return;
  }
  const id = ++requestId;
  body.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }), `Comparing “${a}” and “${b}”…`));
  try {
    const data = await api.compare(a, b);
    if (id !== requestId) return;
    result = data;
    render();
  } catch (err) {
    if (id !== requestId) return;
    body.replaceChildren(el('p', { class: 'notice' }, err.message));
  }
}

// Plain-text explanation from Claude: one paragraph per line, "Example:" lines styled.
function explanationText(text) {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const example = line.match(/^Example:\s*(.*)$/i);
    return example ? el('p', { class: 'example' }, example[1]) : el('p', {}, line);
  });
}

function aiBlock() {
  const { left, right, explanation, aiAvailable } = result;
  const box = el('div', { class: 'ai-explanation' });
  const explain = async (again) => {
    box.replaceChildren(el('p', { class: 'loading' }, el('span', { class: 'spinner' }), 'Claude is writing an explanation…'));
    try {
      result.explanation = await api.explainComparison(left.term, right.term, again);
      box.replaceWith(aiBlock());
    } catch (err) {
      toast(err.message);
      box.replaceWith(aiBlock());
    }
  };

  if (explanation) {
    box.append(
      el('h4', {}, icon('sparkle'), 'AI explanation'),
      explanationText(explanation.explanation),
      el('p', { class: 'hint attribution' },
        `Written by Claude on ${new Date(explanation.created_at).toLocaleDateString()}. AI can make mistakes. `,
        aiAvailable && el('button', { class: 'link-button', type: 'button', onclick: () => explain(true) }, 'Write a new one')));
  } else if (aiAvailable) {
    box.append(el('button', { class: 'btn', type: 'button', onclick: () => explain(false) },
      icon('sparkle'), 'Explain the difference with AI'));
  } else {
    box.append(el('p', { class: 'hint' },
      'Want an AI explanation of the difference? Add an Anthropic API key in Settings (about 1–2 cents per explanation). ',
      el('button', { class: 'link-button', type: 'button', onclick: () => hooks.onOpenKeys?.('anthropic') }, 'Open Settings')));
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
  const both = left.found || left.inLibrary ? (right.found || right.inLibrary) : false;
  body.replaceChildren(el('div', { class: 'overlay-content wide' },
    both && el('section', { class: 'difference' },
      el('h3', {}, `How “${left.term}” and “${right.term}” differ`),
      relationBadges(),
      result.discussion && discussion(result.discussion, { emphasize: [left.term, right.term] }),
      !result.discussion && el('p', { class: 'hint' },
        'Merriam-Webster doesn’t discuss these two together. Compare their definitions below.'),
      aiBlock()),
    el('div', { class: 'compare-grid' }, side(left, 'left'), side(right, 'right'))));
  body.scrollTop = 0;
}

// Called after a word is saved, so its column shows "Open in library".
export function noteAddedToCompare(word) {
  if (!result || overlay.hidden) return;
  const t = word.term.toLowerCase();
  if ([result.left.term, result.right.term].some((x) => x.toLowerCase() === t)) run();
}
