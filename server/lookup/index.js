// Queries the dictionary and thesaurus in parallel and merges the results into one profile.
import { lookupCollegiate, lookupThesaurus } from './merriamWebster.js';

// Unique per (value, part of speech): the same synonym can belong to the noun and the
// adjective, and must survive if only one of them is saved. Pages showing a lookup
// de-duplicate by value.
function mergeRelations(sources, kind, term) {
  const self = term.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    for (const { value: raw, pos } of source[kind] ?? []) {
      const value = String(raw).trim();
      const key = `${value.toLowerCase()}
${pos ?? ''}`;
      if (!value || value.toLowerCase() === self || seen.has(key)) continue;
      seen.add(key);
      out.push({ value, part_of_speech: pos ?? null, source: source.id });
    }
  }
  return out;
}

export const kindOf = (term) => (/\s/.test(term.trim()) ? 'phrase' : 'word');

// Distinct parts of speech in dictionary order, with how many definitions each has.
function partsOfSpeech(definitions) {
  const counts = new Map();
  for (const { part_of_speech: pos } of definitions) {
    if (pos) counts.set(pos, (counts.get(pos) ?? 0) + 1);
  }
  return [...counts].map(([pos, count]) => ({ pos, count }));
}

// Recent results, so saving right after a preview doesn't query every dictionary again.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

export const clearLookupCache = () => cache.clear();

// keys: { collegiate, thesaurus } Merriam-Webster API keys (either may be empty).
export async function lookupWord(term, { fresh = false, keys = {} } = {}) {
  const key = term.trim().toLowerCase();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const result = await queryAll(term.trim(), keys);
  // Don't cache transient failures.
  if (!result.sources.some((s) => s.status === 'error')) {
    cache.delete(key);
    cache.set(key, { at: Date.now(), result });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return result;
}

async function queryAll(clean, keys) {
  const [mw, thesaurus] = await Promise.all([
    lookupCollegiate(clean, keys.collegiate),
    lookupThesaurus(clean, keys.thesaurus),
  ]);

  const relationSources = [thesaurus];
  const firstDef = mw.definitions.find((d) => d.part_of_speech);

  return {
    term: clean,
    kind: kindOf(clean),
    found: mw.status === 'found',
    unavailable: [mw, thesaurus].filter((s) => s.status === 'error' && !s.invalidKey).map((s) => s.name),
    pronunciation: mw.pronunciation,
    audioUrl: mw.audioUrl,
    etymology: mw.etymology,
    firstUse: mw.firstUse,
    primaryPos: firstDef?.part_of_speech ?? null,
    partsOfSpeech: partsOfSpeech(mw.definitions),
    synonymDiscussion: mw.synonymDiscussion ?? null,
    suggestions: mw.suggestions,
    sources: [mw, thesaurus].map(({ id, name, url, status, message, invalidKey, definitions }) => ({
      id, name, url, status, message, invalidKey: Boolean(invalidKey), definitions: definitions ?? [],
    })),
    synonyms: mergeRelations(relationSources, 'synonyms', clean),
    antonyms: mergeRelations(relationSources, 'antonyms', clean),
  };
}
