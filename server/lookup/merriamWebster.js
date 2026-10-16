// Merriam-Webster Collegiate Dictionary + Collegiate Thesaurus.
// Docs: https://dictionaryapi.com/products/json
import { fetchJson, describeError } from './http.js';
import { stripMarkup, audioUrl } from './mwMarkup.js';

const BASE = 'https://www.dictionaryapi.com/api/v3/references';
const TIMEOUT_MS = 6000;

const headword = (entry) => String(entry?.meta?.id ?? '').split(':')[0].toLowerCase();

const hasStem = (entry, t) => (entry?.meta?.stems ?? []).some((s) => s.toLowerCase() === t);

// Cross-reference targets, e.g. the "ran" entry says "past tense of run".
const crossRefTargets = (entry) =>
  (entry.cxs ?? []).flatMap((cx) => (cx.cxtis ?? []).map((ti) => String(ti.cxt ?? '').split(':')[0].toLowerCase()));

// Keep entries for this exact word. An exact entry that is only a cross-reference
// ("ran" -> "past tense of run") also pulls in the target's entries that list the term
// as an inflection. With no exact entry, fall back to entries listing it as a stem,
// except for thesaurus phrases: "break the ice" is a stem of "break", whose synonyms
// (shatter, fracture…) say nothing about the phrase.
function relevantEntries(entries, term, ref) {
  const t = term.toLowerCase();
  const exact = entries.filter((e) => headword(e) === t);
  if (!exact.length) {
    if (ref === 'thesaurus' && /\s/.test(t)) return [];
    return entries.filter((e) => hasStem(e, t));
  }
  const targets = new Set(exact.flatMap(crossRefTargets));
  const referenced = entries.filter((e) => targets.has(headword(e)) && hasStem(e, t));
  return [...exact, ...referenced];
}

function crossRefText(entry) {
  return (entry.cxs ?? [])
    .map((cx) => `${cx.cxl} ${(cx.cxtis ?? []).map((ti) => String(ti.cxt ?? '').split(':')[0]).join(', ')}`.trim())
    .filter(Boolean);
}

class InvalidKeyError extends Error {
  constructor() {
    super('Invalid API key');
    this.invalidKey = true;
  }
}

async function query(ref, term, key) {
  const url = `${BASE}/${ref}/json/${encodeURIComponent(term)}?key=${encodeURIComponent(key)}`;
  const { status, body } = await fetchJson(url, TIMEOUT_MS);
  // A wrong key (or one for the other reference) gets HTTP 200 with a plain-text message, not JSON.
  if (status === 200 && !Array.isArray(body)) throw new InvalidKeyError();
  if (status !== 200) throw new Error(`HTTP ${status}`);
  // When the word isn't found MW returns an array of suggestion strings instead of entries.
  if (body.length === 0 || typeof body[0] === 'string') {
    return { entries: [], suggestions: body.filter((s) => typeof s === 'string').slice(0, 8) };
  }
  return { entries: relevantEntries(body, term, ref), suggestions: [] };
}

function pronunciationOf(entry) {
  const mw = entry?.hwi?.prs?.[0]?.mw;
  return mw ? `\\${mw}\\` : null;
}

const firstAudio = (entry) => entry?.hwi?.prs?.find((p) => p.sound?.audio)?.sound.audio;

// Lookups return up to this many; saving keeps fewer (see MAX_SAVED_DEFINITIONS in words.js)
// after any part-of-speech choice, so choosing "adjective" can't lose senses past the cap.
const MAX_DEFINITIONS = 60;
const MAX_EXAMPLES = 3;

// Walks a sense sequence (def[].sseq) and yields each sense object, including
// senses nested in binding substitutes ("bs") and parenthesized sequences ("pseq").
function* senses(seq) {
  for (const item of seq ?? []) {
    if (!Array.isArray(item)) continue;
    if (Array.isArray(item[0])) { yield* senses(item); continue; }
    const [type, data] = item;
    if (type === 'sense') yield data;
    else if (type === 'bs') yield data?.sense;
    else if (type === 'pseq') yield* senses(data);
  }
}

// Text and example sentences from a defining-text array (sense.dt).
function readDt(dt) {
  const text = [];
  const examples = [];
  const usage = [];
  for (const [type, value] of dt ?? []) {
    if (type === 'text') text.push(value);
    else if (type === 'vis') examples.push(...value.map((v) => v.t));
    else if (type === 'uns') {
      for (const note of value.flat()) {
        if (note?.[0] === 'text') usage.push(note[1]);
        if (note?.[0] === 'vis') examples.push(...note[1].map((v) => v.t));
      }
    }
  }
  return {
    text: stripMarkup(text.join(' ')) || stripMarkup(usage.join(' ')),
    examples: examples.map(stripMarkup).filter(Boolean),
  };
}

function definitionsOf(entry) {
  const pos = entry.fl ?? null;
  const out = [];
  for (const block of entry.def ?? []) {
    for (const sense of senses(block.sseq)) {
      if (!sense?.dt) continue;
      const main = readDt(sense.dt);
      let { text } = main;
      const examples = [...main.examples];
      // Divided senses ("also : …") belong with their parent sense.
      if (sense.sdsense?.dt) {
        const sub = readDt(sense.sdsense.dt);
        if (sub.text) text = `${text}; ${sense.sdsense.sd}: ${sub.text}`;
        examples.push(...sub.examples);
      }
      if (text) out.push({ part_of_speech: pos, text, examples: examples.slice(0, MAX_EXAMPLES) });
    }
  }
  if (out.length) return out;
  // Entries without sense data: use the short definitions, or the cross-reference.
  const fallback = entry.shortdef?.length ? entry.shortdef : crossRefText(entry);
  return fallback.map((text) => ({ part_of_speech: pos, text, examples: [] }));
}

export async function lookupCollegiate(term, key) {
  const source = {
    id: 'merriam-webster',
    name: 'Merriam-Webster',
    url: `https://www.merriam-webster.com/dictionary/${encodeURIComponent(term)}`,
    definitions: [],
    suggestions: [],
    pronunciation: null,
    audioUrl: null,
    etymology: null,
    firstUse: null,
  };
  if (!key) return { ...source, status: 'disabled', message: 'No API key set (MW_COLLEGIATE_KEY)' };
  try {
    const { entries, suggestions } = await query('collegiate', term, key);
    if (!entries.length) return { ...source, status: 'not_found', suggestions };
    for (const entry of entries) {
      // A cross-reference-only entry ("ran") gets a line saying what it refers to.
      if (!entry.def?.length && !entry.shortdef?.length) {
        source.definitions.push(...crossRefText(entry).map((text) => ({ part_of_speech: entry.fl ?? null, text, examples: [] })));
      } else {
        source.definitions.push(...definitionsOf(entry));
      }
    }
    source.definitions = source.definitions.slice(0, MAX_DEFINITIONS);
    source.pronunciation = entries.map(pronunciationOf).find(Boolean) ?? null;
    source.audioUrl = audioUrl(entries.map(firstAudio).find(Boolean));
    const withEt = entries.find((e) => e.et?.length);
    source.etymology = withEt
      ? stripMarkup(withEt.et.filter(([type]) => type === 'text').map(([, v]) => v).join(' ')) || null
      : null;
    const withDate = entries.find((e) => e.date);
    source.firstUse = withDate ? stripMarkup(withDate.date) || null : null;
    source.synonymDiscussion = synonymDiscussionOf(entries);
    return { ...source, status: source.definitions.length ? 'found' : 'not_found' };
  } catch (err) {
    return { ...source, status: 'error', message: describeError(err), invalidKey: Boolean(err.invalidKey) };
  }
}

export async function lookupThesaurus(term, key) {
  const source = {
    id: 'merriam-webster-thesaurus',
    name: 'Merriam-Webster Thesaurus',
    url: `https://www.merriam-webster.com/thesaurus/${encodeURIComponent(term)}`,
    synonyms: [],
    antonyms: [],
  };
  if (!key) return { ...source, status: 'disabled', message: 'No API key set (MW_THESAURUS_KEY)' };
  try {
    const { entries } = await query('thesaurus', term, key);
    if (!entries.length) return { ...source, status: 'not_found' };
    // Keep each entry's part of speech, so a word saved as only some parts of speech
    // keeps only the matching synonyms.
    for (const entry of entries) {
      const pos = entry.fl ?? null;
      source.synonyms.push(...(entry.meta?.syns ?? []).flat().map((value) => ({ value, pos })));
      source.antonyms.push(...(entry.meta?.ants ?? []).flat().map((value) => ({ value, pos })));
    }
    const found = source.synonyms.length || source.antonyms.length;
    return { ...source, status: found ? 'found' : 'not_found' };
  } catch (err) {
    return { ...source, status: 'error', message: describeError(err), invalidKey: Boolean(err.invalidKey) };
  }
}

// MW's synonym discussion ("transient, transitory, ephemeral … mean lasting only a short
// time. transient applies to …"): kept in order as text and example blocks, plus the words
// it compares (marked {sc}…{/sc} in the source) so the page can highlight them.
function synonymDiscussionOf(entries) {
  const syns = entries.find((e) => e.syns?.length)?.syns?.[0];
  if (!syns?.pt?.length) return null;
  const words = new Set();
  const blocks = [];
  for (const [type, value] of syns.pt) {
    if (type === 'text') {
      for (const m of String(value).matchAll(/\{sc\}(.*?)\{\/sc\}/g)) words.add(m[1].toLowerCase());
      const text = stripMarkup(value);
      if (text) blocks.push({ text });
    } else if (type === 'vis') {
      for (const v of value) {
        const example = stripMarkup(v.t);
        if (example) blocks.push({ example });
      }
    }
  }
  if (!blocks.length) return null;
  return { title: stripMarkup(syns.pl) || 'synonyms', blocks, words: [...words] };
}

// Checks a key against its reference ('collegiate' or 'thesaurus').
// Resolves to { ok: true } or { ok: false, invalidKey, message }.
export async function testKey(ref, key) {
  try {
    await query(ref, 'test', key);
    return { ok: true };
  } catch (err) {
    return { ok: false, invalidKey: Boolean(err.invalidKey), message: describeError(err) };
  }
}
