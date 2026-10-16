import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { lookupWord, clearLookupCache, kindOf } from '../lookup/index.js';
import { testKey } from '../lookup/merriamWebster.js';
import { USER_SOURCE, MAX_TAGS_PER_WORD, MAX_TAG_LENGTH, normalizePosFilter } from '../words.js';
import { toBackup, toCsv, parseBackup, parseComparisons, BackupError } from '../backup.js';
import { explainDifference, AI_PROVIDERS } from '../ai.js';
import { BackupError as RestoreError } from '../backups.js';
import { LibraryFileError } from '../db.js';

const MAX_TERM = 100;
const MAX_TEXT = 5000;
const SETTINGS_KEYS = new Set(['theme', 'accent', 'font', 'fontSize', 'density', 'sort', 'favFirst', 'kind', 'aiProvider']);
const MAX_NOTE = 2000;
const KINDS = new Set(['word', 'phrase']);

// API keys: saved in the app's settings table (never sent to the browser), else .env.
// Each is checked with its service before it's saved.
const API_KEYS = {
  collegiate: {
    setting: 'mw_collegiate_key', env: 'MW_COLLEGIATE_KEY', label: 'Dictionary',
    test: (key) => testKey('collegiate', key),
    rejected: 'Merriam-Webster didn’t accept this Dictionary key. Check that it’s your Collegiate Dictionary key.',
  },
  thesaurus: {
    setting: 'mw_thesaurus_key', env: 'MW_THESAURUS_KEY', label: 'Thesaurus',
    test: (key) => testKey('thesaurus', key),
    rejected: 'Merriam-Webster didn’t accept this Thesaurus key. Check that it’s your Collegiate Thesaurus key.',
  },
  groq: {
    setting: 'groq_key', env: 'GROQ_API_KEY', label: 'Groq',
    test: (key) => AI_PROVIDERS.groq.testKey(key),
    rejected: 'Groq didn’t accept this API key. Copy it again from console.groq.com/keys.',
  },
  anthropic: {
    setting: 'anthropic_key', env: 'ANTHROPIC_API_KEY', label: 'Anthropic',
    test: (key) => AI_PROVIDERS.anthropic.testKey(key),
    rejected: 'Anthropic didn’t accept this API key. Copy it again from console.anthropic.com.',
  },
};
const MAX_COMPARE_SYNONYMS = 60;
const MAX_KEY = 200;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 doesn't forward rejected promises to the error handler on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanTerm(raw) {
  const term = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!term) throw new HttpError(400, 'Enter a word');
  if (term.length > MAX_TERM) throw new HttpError(400, `Words are limited to ${MAX_TERM} characters`);
  return term;
}

function cleanText(raw, field, { required = false, max = MAX_TEXT } = {}) {
  if (raw === undefined && !required) return undefined;
  const text = String(raw ?? '').trim();
  if (required && !text) throw new HttpError(400, `${field} is required`);
  if (text.length > max) throw new HttpError(400, `${field} is too long`);
  return text;
}

function cleanTags(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, 'Tags must be a list');
  const seen = new Set();
  const tags = [];
  for (const value of raw) {
    const tag = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new HttpError(400, `Tags are limited to ${MAX_TAG_LENGTH} characters`);
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS_PER_WORD) throw new HttpError(400, `A word can have at most ${MAX_TAGS_PER_WORD} tags`);
  return tags;
}

const listFilter = (query) => ({
  tag: String(query.tag ?? '').trim().slice(0, MAX_TAG_LENGTH),
  kind: KINDS.has(query.kind) ? query.kind : '',
});

function cleanPartsOfSpeech(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, 'Parts of speech must be a list');
  return raw.map((p) => String(p ?? '').trim().slice(0, 40)).filter(Boolean).slice(0, 20);
}

const uniqueValues = (items) => [...new Map(items.map((r) => [r.value.toLowerCase(), r.value])).values()];

export function createApiRouter({ words, settings, db, backups, location }) {
  const router = express.Router();

  function keyInfo(name) {
    const { setting, env } = API_KEYS[name];
    const saved = settings.get(setting);
    const value = saved || process.env[env] || '';
    return { value, source: saved ? 'app' : value ? 'env' : null };
  }
  const currentKeys = () => ({ collegiate: keyInfo('collegiate').value, thesaurus: keyInfo('thesaurus').value });

  // The AI provider for explanations: the one chosen in Settings, or the other one if only it
  // has a key. Null when neither has a key.
  function currentAi() {
    const chosen = settings.get('aiProvider') === 'anthropic' ? 'anthropic' : 'groq';
    const other = chosen === 'groq' ? 'anthropic' : 'groq';
    const id = keyInfo(chosen).value ? chosen : keyInfo(other).value ? other : null;
    if (!id) return { available: false, provider: null, label: null, chosen };
    const provider = AI_PROVIDERS[id];
    return { available: true, provider: id, label: provider.label, model: provider.model(), chosen, apiKey: keyInfo(id).value };
  }
  const publicAi = ({ apiKey, ...info }) => info;

  // Registered before the default parser so backups can be larger than 100kb.
  router.post('/import', express.json({ limit: '10mb' }), (req, res) => {
    try {
      const result = words.importAll(parseBackup(req.body));
      res.json({ ...result, comparisons: words.importComparisons(parseComparisons(req.body)) });
    } catch (err) {
      if (err instanceof BackupError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  router.use(express.json({ limit: '100kb' }));

  const requireWord = (req) => {
    const id = Number(req.params.id);
    const word = Number.isInteger(id) ? words.get(id) : null;
    if (!word) throw new HttpError(404, 'Word not found');
    return word;
  };

  const requireUserDefinition = (req, word) => {
    const def = words.getDefinition(word.id, Number(req.params.defId));
    if (!def) throw new HttpError(404, 'Definition not found');
    if (def.source !== USER_SOURCE) throw new HttpError(403, 'Dictionary definitions are read-only');
    return def;
  };

  router.get('/lookup', wrap(async (req, res) => {
    const term = cleanTerm(req.query.term);
    const existing = words.findByTerm(term);
    res.json({ ...(await lookupWord(term, { keys: currentKeys() })), existingId: existing?.id ?? null });
  }));

  router.get('/words', (req, res) => {
    res.json(words.list({
      sort: String(req.query.sort ?? 'date'),
      favFirst: req.query.favFirst === '1',
      q: String(req.query.q ?? '').trim().slice(0, MAX_TERM),
      ...listFilter(req.query),
    }));
  });

  router.get('/tags', (req, res) => res.json(words.listTags()));

  router.post('/words', wrap(async (req, res) => {
    const term = cleanTerm(req.body?.term);
    const existing = words.findByTerm(term);
    if (existing) return res.status(409).json({ error: `“${term}” is already in your library`, id: existing.id });
    const body = req.body ?? {};
    const extras = {
      notes: cleanText(body.notes, 'Notes'),
      found_title: cleanText(body.found_title, 'Title', { max: 300 }),
      found_author: cleanText(body.found_author, 'Author', { max: 200 }),
      found_page: cleanText(body.found_page, 'Page', { max: 40 }),
      tags: cleanTags(body.tags),
    };
    const chosen = cleanPartsOfSpeech(body.parts_of_speech);
    const lookup = await lookupWord(term, { keys: currentKeys() });
    extras.posFilter = normalizePosFilter(chosen, lookup.partsOfSpeech);
    res.status(201).json({ ...words.create(term, kindOf(term), lookup, extras), unavailable: lookup.unavailable });
  }));

  router.get('/words/:id', (req, res) => res.json(requireWord(req)));

  router.patch('/words/:id', (req, res) => {
    const word = requireWord(req);
    const body = req.body ?? {};
    res.json(words.update(word.id, {
      notes: cleanText(body.notes, 'Notes'),
      favorite: body.favorite === undefined ? undefined : Boolean(body.favorite),
      primary_pos: body.primary_pos === undefined ? undefined : String(body.primary_pos ?? '').trim().slice(0, 40) || null,
      found_title: cleanText(body.found_title, 'Title', { max: 300 }),
      found_author: cleanText(body.found_author, 'Author', { max: 200 }),
      found_page: cleanText(body.found_page, 'Page', { max: 40 }),
      tags: cleanTags(body.tags),
    }));
  });

  router.delete('/words/:id', (req, res) => {
    words.remove(requireWord(req).id);
    res.status(204).end();
  });

  router.post('/words/:id/refresh', wrap(async (req, res) => {
    const word = requireWord(req);
    const lookup = await lookupWord(word.term, { fresh: true, keys: currentKeys() });
    res.json({ ...words.refresh(word.id, lookup), unavailable: lookup.unavailable });
  }));

  // Choose which parts of speech a word keeps; the dictionary data is re-applied right away.
  router.put('/words/:id/parts-of-speech', wrap(async (req, res) => {
    const word = requireWord(req);
    const chosen = cleanPartsOfSpeech(req.body?.parts_of_speech) ?? [];
    const lookup = await lookupWord(word.term, { keys: currentKeys() });
    if (!lookup.found) throw new HttpError(502, 'Couldn’t get this word from the dictionary right now. Try again later.');
    const posFilter = normalizePosFilter(chosen, lookup.partsOfSpeech);
    res.json({ ...words.refresh(word.id, lookup, { posFilter }), unavailable: lookup.unavailable });
  }));

  // Reordering is allowed for every definition; dictionary text itself stays read-only.
  router.put('/words/:id/definitions/order', (req, res) => {
    const word = requireWord(req);
    const ids = req.body?.ids;
    const current = new Set(words.definitionIds(word.id));
    const valid = Array.isArray(ids) && ids.length === current.size
      && new Set(ids).size === ids.length && ids.every((id) => current.has(id));
    if (!valid) throw new HttpError(400, 'The order must list each of this word’s definitions once');
    res.json(words.reorder(word.id, ids));
  });

  router.post('/words/:id/definitions', (req, res) => {
    const word = requireWord(req);
    res.status(201).json(words.addUserDefinition(word.id, {
      text: cleanText(req.body?.text, 'Definition', { required: true }),
      part_of_speech: cleanText(req.body?.part_of_speech, 'Part of speech'),
      example: cleanText(req.body?.example, 'Example'),
    }));
  });

  router.patch('/words/:id/definitions/:defId', (req, res) => {
    const word = requireWord(req);
    const def = requireUserDefinition(req, word);
    const text = cleanText(req.body?.text, 'Definition');
    if (text === '') throw new HttpError(400, 'Definition is required');
    res.json(words.updateUserDefinition(word.id, def.id, {
      text,
      part_of_speech: cleanText(req.body?.part_of_speech, 'Part of speech'),
      example: cleanText(req.body?.example, 'Example'),
    }));
  });

  router.delete('/words/:id/definitions/:defId', (req, res) => {
    const word = requireWord(req);
    words.removeDefinition(requireUserDefinition(req, word).id);
    res.status(204).end();
  });

  router.get('/review', (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    res.json(words.reviewBatch({ ...listFilter(req.query), favorites: req.query.favorites === '1', limit }));
  });

  router.post('/words/:id/review', (req, res) => {
    const word = requireWord(req);
    if (typeof req.body?.known !== 'boolean') throw new HttpError(400, 'known must be true or false');
    res.json(words.recordReview(word.id, req.body.known));
  });

  // ----- Compare -----

  // A side of a comparison: your saved version if the term is in your library (your own
  // definitions and order), otherwise the dictionary's. The lookup also supplies MW's
  // synonym discussion for words saved before discussions were stored.
  async function profileFor(term) {
    const existing = words.findByTerm(term);
    const lookup = await lookupWord(term, { keys: currentKeys() });
    if (existing) {
      const w = words.get(existing.id);
      return {
        term: w.term, kind: w.kind, inLibrary: true, id: w.id,
        pronunciation: w.pronunciation, audioUrl: w.audio_url, etymology: w.etymology, firstUse: w.first_use,
        partsOfSpeech: [...new Set(w.definitions.map((d) => d.part_of_speech).filter(Boolean))],
        definitions: w.definitions.map(({ part_of_speech, text, examples, source }) => ({ part_of_speech, text, examples, source })),
        synonyms: uniqueValues(w.synonyms).slice(0, MAX_COMPARE_SYNONYMS),
        antonyms: uniqueValues(w.antonyms).slice(0, MAX_COMPARE_SYNONYMS),
        synonymDiscussion: w.syn_discussion ?? lookup.synonymDiscussion,
        found: true,
      };
    }
    return {
      term: lookup.term, kind: lookup.kind, inLibrary: false, id: null,
      pronunciation: lookup.pronunciation, audioUrl: lookup.audioUrl, etymology: lookup.etymology,
      firstUse: lookup.firstUse, partsOfSpeech: lookup.partsOfSpeech.map((p) => p.pos),
      definitions: lookup.sources[0].definitions,
      synonyms: uniqueValues(lookup.synonyms).slice(0, MAX_COMPARE_SYNONYMS),
      antonyms: uniqueValues(lookup.antonyms).slice(0, MAX_COMPARE_SYNONYMS),
      synonymDiscussion: lookup.synonymDiscussion, found: lookup.found, suggestions: lookup.suggestions,
      unavailable: lookup.unavailable, keyProblem: lookup.sources.some((s) => s.status === 'disabled' || s.invalidKey),
    };
  }

  // MW's synonym discussion, when one of the two words has a discussion naming both.
  function sharedDiscussion(a, b) {
    const names = [a.term.toLowerCase(), b.term.toLowerCase()];
    return [a.synonymDiscussion, b.synonymDiscussion]
      .find((d) => d && names.every((n) => d.words.includes(n))) ?? null;
  }

  async function comparePair(req) {
    const a = cleanTerm(req.query?.a ?? req.body?.a);
    const b = cleanTerm(req.query?.b ?? req.body?.b);
    if (a.toLowerCase() === b.toLowerCase()) throw new HttpError(400, 'Pick two different words to compare');
    const [left, right] = await Promise.all([profileFor(a), profileFor(b)]);
    return { left, right, discussion: sharedDiscussion(left, right) };
  }

  router.get('/compare', wrap(async (req, res) => {
    const { left, right, discussion } = await comparePair(req);
    const lower = (list) => new Set(list.map((v) => v.toLowerCase()));
    const leftSyn = lower(left.synonyms);
    res.json({
      left, right, discussion,
      sharedSynonyms: right.synonyms.filter((v) => leftSyn.has(v.toLowerCase())),
      relation: {
        synonyms: leftSyn.has(right.term.toLowerCase()) || lower(right.synonyms).has(left.term.toLowerCase()),
        antonyms: lower(left.antonyms).has(right.term.toLowerCase()) || lower(right.antonyms).has(left.term.toLowerCase()),
      },
      explanation: words.getExplanation(left.term, right.term),
      saved: words.findSavedComparison(left.term, right.term),
      ai: publicAi(currentAi()),
    });
  }));

  // Explains the difference with Claude (the user's own Anthropic key). Saved per pair, so
  // each pair costs at most once unless "again" is requested.
  router.post('/compare/explain', wrap(async (req, res) => {
    const { left, right, discussion } = await comparePair(req);
    const existing = words.getExplanation(left.term, right.term);
    if (existing && req.body?.again !== true) return res.json(existing);
    const ai = currentAi();
    if (!ai.available) throw new HttpError(400, 'Add a free Groq API key in Settings to get AI explanations.');
    const discussionText = discussion
      ? discussion.blocks.map((block) => block.text ?? `Example: ${block.example}`).join('\n')
      : null;
    const { text, model } = await explainDifference(ai.provider, ai.apiKey, [left, right], discussionText);
    res.json(words.saveExplanation(left.term, right.term, text, model, ai.provider));
  }));

  // ----- Saved comparisons -----

  const requireSaved = (req) => {
    const id = Number(req.params.id);
    const saved = Number.isInteger(id) ? words.getSavedComparison(id) : null;
    if (!saved) throw new HttpError(404, 'Saved comparison not found');
    return saved;
  };

  router.get('/saved-comparisons', (req, res) => res.json(words.listSavedComparisons()));

  router.post('/saved-comparisons', (req, res) => {
    const a = cleanTerm(req.body?.a);
    const b = cleanTerm(req.body?.b);
    if (a.toLowerCase() === b.toLowerCase()) throw new HttpError(400, 'Pick two different words to compare');
    res.status(201).json(words.saveComparison(a, b, cleanText(req.body?.note, 'Note', { max: MAX_NOTE })));
  });

  router.patch('/saved-comparisons/:id', (req, res) => {
    const saved = requireSaved(req);
    res.json(words.updateSavedComparisonNote(saved.id, cleanText(req.body?.note, 'Note', { max: MAX_NOTE }) ?? saved.note));
  });

  router.delete('/saved-comparisons/:id', (req, res) => {
    words.removeSavedComparison(requireSaved(req).id);
    res.status(204).end();
  });

  // ----- Automatic backups -----

  router.get('/backups', wrap(async (req, res) => {
    res.json({
      location: location.get(),
      defaultLocation: location.defaultDir,
      isDefault: path.resolve(location.get()) === path.resolve(location.defaultDir),
      items: await backups.list(),
    });
  }));

  router.post('/backups', (req, res) => {
    res.status(201).json({ name: backups.write(db.snapshot(), 'manual') });
  });

  // Replaces the whole library (words, comparisons, settings, keys) with a backup.
  // The current library is backed up first, so a restore can itself be undone.
  router.post('/backups/restore', wrap(async (req, res) => {
    try {
      await backups.restore(req.body?.name, db);
    } catch (err) {
      if (err instanceof RestoreError || err instanceof LibraryFileError) throw new HttpError(400, err.message);
      throw err;
    }
    clearLookupCache();
    res.json({ ok: true });
  }));

  // Moves future backups to another folder ("" goes back to the default).
  router.put('/backups/location', (req, res) => {
    const raw = String(req.body?.dir ?? '').trim();
    if (raw && (!path.isAbsolute(raw) || raw.length > 500)) throw new HttpError(400, 'Choose a full folder path.');
    const dir = raw || location.defaultDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.wordcollector-write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.rmSync(probe);
    } catch {
      throw new HttpError(400, 'Word Collector can’t save files in that folder. Choose another one.');
    }
    location.set(raw);
    res.json({ location: location.get() });
  });

  router.get('/export', (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const all = words.exportAll();
    const date = new Date().toISOString().slice(0, 10);
    res.attachment(`wordcollector-${date}.${format}`);
    if (format === 'csv') res.type('text/csv; charset=utf-8').send(toCsv(all));
    else res.type('application/json').send(JSON.stringify(toBackup(all, words.exportComparisons()), null, 2));
  });

  router.get('/keys', (req, res) => {
    res.json(Object.fromEntries(Object.keys(API_KEYS).map((name) => {
      const { value, source } = keyInfo(name);
      return [name, { set: Boolean(value), source, hint: value ? `••••${value.slice(-4)}` : null }];
    })));
  });

  // Empty string removes the app's saved key; anything else is checked with its service first.
  router.put('/keys', wrap(async (req, res) => {
    const updates = Object.entries(req.body ?? {}).filter(([name]) => API_KEYS[name]);
    if (!updates.length) throw new HttpError(400, 'Nothing to save');
    for (const [name, raw] of updates) {
      const value = String(raw ?? '').trim();
      if (value.length > MAX_KEY) throw new HttpError(400, 'That key is too long');
      if (!value) continue;
      const result = await API_KEYS[name].test(value);
      if (!result.ok) {
        const { label, rejected } = API_KEYS[name];
        throw new HttpError(400, result.invalidKey
          ? rejected
          : `Couldn’t check the ${label} key (${result.message}). Try again.`);
      }
    }
    for (const [name, raw] of updates) {
      const value = String(raw ?? '').trim();
      if (value) settings.merge({ [API_KEYS[name].setting]: value });
      else settings.remove(API_KEYS[name].setting);
    }
    clearLookupCache();
    res.json({ ok: true });
  }));

  // Only appearance and list preferences; stored API keys stay on the server.
  router.get('/settings', (req, res) => {
    res.json(Object.fromEntries(Object.entries(settings.all()).filter(([key]) => SETTINGS_KEYS.has(key))));
  });

  router.put('/settings', (req, res) => {
    const values = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([key]) => SETTINGS_KEYS.has(key)),
    );
    settings.merge(values);
    res.json(Object.fromEntries(Object.entries(settings.all()).filter(([key]) => SETTINGS_KEYS.has(key))));
  });

  router.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  });

  return router;
}
