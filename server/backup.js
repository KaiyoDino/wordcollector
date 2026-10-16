// Export/import formats. JSON round-trips everything; CSV is a flat view for spreadsheets.
import { MAX_TAGS_PER_WORD, MAX_TAG_LENGTH, REVIEW_MAX_BOX } from './words.js';

export const BACKUP_FORMAT = 'wordcollector-backup';
// Version 2 added comparisons; version-1 files still import.
export const BACKUP_VERSION = 2;
const MAX_WORDS = 50000;

export function toBackup(words, comparisons = []) {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: new Date().toISOString(), words, comparisons };
}

const CSV_COLUMNS = [
  ['term', (w) => w.term],
  ['part_of_speech', (w) => w.primary_pos ?? ''],
  ['main_definition', (w) => w.definitions[0]?.text ?? ''],
  ['all_definitions', (w) => w.definitions.map((d, i) => `${i + 1}. ${d.text}`).join('\n')],
  ['notes', (w) => w.notes],
  ['tags', (w) => w.tags.join(', ')],
  ['favorite', (w) => (w.favorite ? 'yes' : '')],
  ['found_title', (w) => w.found_title],
  ['found_author', (w) => w.found_author],
  ['found_page', (w) => w.found_page],
  ['date_added', (w) => w.created_at.slice(0, 10)],
];

function csvCell(value) {
  let s = String(value ?? '');
  // Keep spreadsheet apps from treating cell text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(words) {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const w of words) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(w))).join(','));
  // BOM so Excel opens it as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export class BackupError extends Error {}

const str = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const optStr = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isoOr = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);

// Validates and normalizes a parsed backup file. Throws BackupError with a readable message.
export function parseBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.words)) {
    throw new BackupError('This file isn’t a Word Collector backup.');
  }
  if (data.version > BACKUP_VERSION) {
    throw new BackupError('This backup was made by a newer version of Word Collector.');
  }
  if (data.words.length > MAX_WORDS) throw new BackupError('This backup has too many words.');

  const ts = new Date().toISOString();
  return data.words
    .filter((w) => typeof w?.term === 'string' && w.term.trim())
    .map((w) => {
      const created = isoOr(w.created_at, ts);
      return {
        term: w.term.trim().replace(/\s+/g, ' ').slice(0, 100),
        favorite: Boolean(w.favorite),
        notes: str(w.notes, 5000),
        primary_pos: optStr(w.primary_pos, 40),
        pronunciation: optStr(w.pronunciation, 200),
        audio_url: typeof w.audio_url === 'string' && /^https:\/\//.test(w.audio_url) ? w.audio_url.slice(0, 500) : null,
        etymology: optStr(w.etymology, 5000),
        first_use: optStr(w.first_use, 100),
        found_title: str(w.found_title, 300),
        found_author: str(w.found_author, 200),
        found_page: str(w.found_page, 40),
        // Older backups have no kind; derive it the same way new words get it.
        kind: w.kind === 'phrase' || w.kind === 'word' ? w.kind : /\s/.test(w.term.trim()) ? 'phrase' : 'word',
        pos_filter: Array.isArray(w.pos_filter) && w.pos_filter.length
          ? w.pos_filter.filter((p) => typeof p === 'string').slice(0, 20).map((p) => p.slice(0, 40))
          : null,
        syn_discussion: synonymDiscussion(w.syn_discussion),
        review_box: Math.min(Math.max(Number.parseInt(w.review_box, 10) || 0, 0), REVIEW_MAX_BOX),
        review_count: Math.max(Number.parseInt(w.review_count, 10) || 0, 0),
        last_reviewed_at: isoOr(w.last_reviewed_at, null),
        created_at: created,
        updated_at: isoOr(w.updated_at, created),
        definitions: arr(w.definitions)
          .filter((d) => typeof d?.text === 'string' && d.text.trim())
          .slice(0, 200)
          .map((d) => ({
            source: str(d.source, 40) || 'user',
            part_of_speech: optStr(d.part_of_speech, 40),
            text: d.text.trim().slice(0, 5000),
            examples: arr(d.examples).filter((e) => typeof e === 'string').slice(0, 10).map((e) => e.slice(0, 1000)),
          })),
        synonyms: relations(w.synonyms),
        antonyms: relations(w.antonyms),
        tags: [...new Set(arr(w.tags).map((t) => str(t, MAX_TAG_LENGTH)).filter(Boolean))].slice(0, MAX_TAGS_PER_WORD),
      };
    });
}

function relations(list) {
  return arr(list)
    .filter((r) => typeof r?.value === 'string' && r.value.trim())
    .slice(0, 500)
    .map((r) => ({
      value: r.value.trim().slice(0, 100),
      part_of_speech: optStr(r.part_of_speech, 40),
      source: str(r.source, 40) || 'import',
    }));
}

// Keeps only the expected shape: { title, blocks: [{text} | {example}], words: [] }.
function synonymDiscussion(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.blocks)) return null;
  const blocks = d.blocks.slice(0, 50).map((b) => (
    typeof b?.text === 'string' ? { text: b.text.slice(0, 3000) }
    : typeof b?.example === 'string' ? { example: b.example.slice(0, 1000) }
    : null)).filter(Boolean);
  if (!blocks.length) return null;
  return {
    title: str(d.title, 100) || 'synonyms',
    blocks,
    words: arr(d.words).filter((x) => typeof x === 'string').slice(0, 30).map((x) => x.slice(0, 100)),
  };
}

const MAX_COMPARISONS = 20000;
const PROVIDERS = new Set(['groq', 'anthropic']);

// Saved comparisons and AI explanations from a version-2 backup (empty for version 1).
export function parseComparisons(data) {
  return arr(data?.comparisons)
    .filter((c) => typeof c?.term_a === 'string' && c.term_a.trim() && typeof c?.term_b === 'string' && c.term_b.trim())
    .slice(0, MAX_COMPARISONS)
    .map((c) => {
      const e = c.explanation;
      const explanation = e && typeof e.text === 'string' && e.text.trim()
        ? {
          text: e.text.trim().slice(0, 5000),
          model: str(e.model, 100) || 'unknown',
          provider: PROVIDERS.has(e.provider) ? e.provider : null,
          created_at: isoOr(e.created_at, null),
        }
        : null;
      return {
        term_a: c.term_a.trim().replace(/\s+/g, ' ').slice(0, 100),
        term_b: c.term_b.trim().replace(/\s+/g, ' ').slice(0, 100),
        saved: Boolean(c.saved),
        note: str(c.note, 2000),
        saved_at: isoOr(c.saved_at, null),
        explanation,
      };
    })
    .filter((c) => c.term_a.toLowerCase() !== c.term_b.toLowerCase() && (c.saved || c.explanation));
}
