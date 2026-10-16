// Read-only word profile, shared by the Dictionary view and Compare. Works with a lookup
// result (normalized by fromLookup) or a compare side from the server (same shape).
import { el, icon, playAudio } from './dom.js';

const DEFS_PER_POS = 6;
const CHIP_LIMIT = 20;

const unique = (values) => [...new Map(values.map((v) => [v.toLowerCase(), v])).values()];

// A /api/lookup result in the same shape as a compare side.
export function fromLookup(lookup) {
  return {
    term: lookup.term,
    kind: lookup.kind,
    inLibrary: Boolean(lookup.existingId),
    id: lookup.existingId,
    pronunciation: lookup.pronunciation,
    audioUrl: lookup.audioUrl,
    etymology: lookup.etymology,
    firstUse: lookup.firstUse,
    partsOfSpeech: lookup.partsOfSpeech.map((p) => p.pos),
    definitions: lookup.sources[0]?.definitions ?? [],
    synonyms: unique(lookup.synonyms.map((s) => s.value)),
    antonyms: unique(lookup.antonyms.map((s) => s.value)),
    synonymDiscussion: lookup.synonymDiscussion,
    found: lookup.found,
    suggestions: lookup.suggestions,
  };
}

function groupByPos(definitions) {
  const groups = new Map();
  for (const d of definitions) {
    const key = d.part_of_speech || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return [...groups];
}

function definitionGroups(definitions) {
  return groupByPos(definitions).map(([pos, items]) => {
    const list = el('ol', { class: 'defs' });
    const renderItems = (all) => list.replaceChildren(...(all ? items : items.slice(0, DEFS_PER_POS)).map((d) =>
      el('li', {},
        d.text,
        d.source === 'user' && el('span', { class: 'source-tag user inline' }, 'Yours'),
        (d.examples ?? []).slice(0, 2).map((ex) => el('span', { class: 'example' }, ex)))));
    renderItems(false);
    const more = items.length > DEFS_PER_POS && el('button', {
      class: 'link-button', type: 'button',
      onclick: () => { renderItems(true); more.remove(); },
    }, `Show ${items.length - DEFS_PER_POS} more`);
    return [pos && el('p', { class: 'pos-label' }, pos), list, more];
  });
}

// Chips for synonyms/antonyms. highlight: lowercase values to emphasize (e.g. shared synonyms).
export function chips(values, { onPick, highlight = new Set(), library = new Map() } = {}) {
  const box = el('div', { class: 'chips' });
  const render = (all) => box.replaceChildren(
    ...(all ? values : values.slice(0, CHIP_LIMIT)).map((value) => el('button', {
      class: `chip${highlight.has(value.toLowerCase()) ? ' shared' : ''}${library.has(value.toLowerCase()) ? ' in-library' : ''}`,
      type: 'button',
      onclick: () => onPick?.(value),
    }, value)),
    !all && values.length > CHIP_LIMIT + 5 && el('button', {
      class: 'chip more', type: 'button', onclick: () => render(true),
    }, `Show all ${values.length}`),
  );
  render(values.length <= CHIP_LIMIT + 5);
  return box;
}

// MW's synonym discussion, with the compared words emphasized.
export function discussion(d, { emphasize = [] } = {}) {
  const strong = new Set(emphasize.map((w) => w.toLowerCase()));
  const words = new Set(d.words);
  const pattern = d.words.length
    ? new RegExp(`\\b(${d.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
    : null;
  const highlight = (text) => {
    if (!pattern) return [text];
    const out = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      if (!words.has(m[0].toLowerCase())) continue;
      out.push(text.slice(last, m.index));
      out.push(el('em', { class: strong.has(m[0].toLowerCase()) ? 'syn-word strong' : 'syn-word' }, m[0]));
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  };
  return el('div', { class: 'discussion' },
    d.blocks.map((b) => (b.text
      ? el('p', {}, highlight(b.text))
      : el('p', { class: 'example' }, b.example))),
    el('p', { class: 'hint attribution' }, 'From Merriam-Webster’s synonym discussion'));
}

// The whole profile. options: { onPickTerm, library, highlightSynonyms, showDiscussion }
export function renderProfile(p, options = {}) {
  const { onPickTerm, library, highlightSynonyms, showDiscussion = true } = options;
  return el('article', { class: 'profile' },
    el('header', { class: 'profile-head' },
      el('h3', { class: 'profile-term' }, p.term),
      el('div', { class: 'word-sub' },
        p.pronunciation && el('span', { class: 'pron' }, p.pronunciation),
        p.audioUrl && el('button', {
          class: 'btn ghost small icon-only audio', type: 'button', title: 'Play pronunciation',
          'aria-label': `Play pronunciation of ${p.term}`, onclick: () => playAudio(p.audioUrl),
        }, icon('play')),
        p.kind === 'phrase' && el('span', { class: 'badge muted' }, 'phrase'),
        p.partsOfSpeech.map((pos) => el('span', { class: 'badge' }, pos)),
        p.inLibrary && el('span', { class: 'badge muted' }, 'in your library'))),
    el('section', { class: 'profile-section' },
      p.definitions.length
        ? definitionGroups(p.definitions)
        : el('p', { class: 'status-note' }, 'No dictionary definition found.')),
    showDiscussion && p.synonymDiscussion && el('section', { class: 'profile-section' },
      el('h4', {}, 'Synonym discussion'),
      discussion(p.synonymDiscussion, { emphasize: [p.term] })),
    (p.etymology || p.firstUse) && el('section', { class: 'profile-section' },
      el('h4', {}, 'Origin'),
      p.etymology && el('p', { class: 'origin' }, p.etymology),
      p.firstUse && el('p', { class: 'hint' }, `First known use: ${p.firstUse}`)),
    (p.synonyms.length > 0 || p.antonyms.length > 0) && el('section', { class: 'profile-section' },
      p.synonyms.length > 0 && [el('h4', {}, 'Synonyms'),
        chips(p.synonyms, { onPick: onPickTerm, library, highlight: highlightSynonyms })],
      p.antonyms.length > 0 && [el('h4', {}, 'Antonyms'),
        chips(p.antonyms, { onPick: onPickTerm, library })]),
  );
}
