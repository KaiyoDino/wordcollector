import express from 'express';
import { lookupWord, clearLookupCache } from '../lookup/index.js';
import { testKey } from '../lookup/merriamWebster.js';
import { USER_SOURCE, MAX_TAGS_PER_WORD, MAX_TAG_LENGTH } from '../words.js';
import { toBackup, toCsv, parseBackup, BackupError } from '../backup.js';

const MAX_TERM = 100;
const MAX_TEXT = 5000;
const SETTINGS_KEYS = new Set(['theme', 'accent', 'font', 'fontSize', 'density', 'sort', 'favFirst']);

// Merriam-Webster keys: saved in the app's settings table (never sent to the browser), else .env.
const MW_KEYS = {
  collegiate: { setting: 'mw_collegiate_key', env: 'MW_COLLEGIATE_KEY', label: 'Dictionary' },
  thesaurus: { setting: 'mw_thesaurus_key', env: 'MW_THESAURUS_KEY', label: 'Thesaurus' },
};
const MAX_KEY = 100;

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
});

export function createApiRouter({ words, settings }) {
  const router = express.Router();

  function keyInfo(name) {
    const { setting, env } = MW_KEYS[name];
    const saved = settings.get(setting);
    const value = saved || process.env[env] || '';
    return { value, source: saved ? 'app' : value ? 'env' : null };
  }
  const currentKeys = () => ({ collegiate: keyInfo('collegiate').value, thesaurus: keyInfo('thesaurus').value });

  // Registered before the default parser so backups can be larger than 100kb.
  router.post('/import', express.json({ limit: '10mb' }), (req, res) => {
    try {
      res.json(words.importAll(parseBackup(req.body)));
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
    if (existing) return res.status(409).json({ error: 'That word is already in your library', id: existing.id });
    const lookup = await lookupWord(term, { keys: currentKeys() });
    res.status(201).json({ ...words.create(term, lookup), unavailable: lookup.unavailable });
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

  router.get('/export', (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const all = words.exportAll();
    const date = new Date().toISOString().slice(0, 10);
    res.attachment(`wordcollector-${date}.${format}`);
    if (format === 'csv') res.type('text/csv; charset=utf-8').send(toCsv(all));
    else res.type('application/json').send(JSON.stringify(toBackup(all), null, 2));
  });

  router.get('/keys', (req, res) => {
    res.json(Object.fromEntries(Object.keys(MW_KEYS).map((name) => {
      const { value, source } = keyInfo(name);
      return [name, { set: Boolean(value), source, hint: value ? `••••${value.slice(-4)}` : null }];
    })));
  });

  // Empty string removes the app's saved key; anything else is checked with MW before saving.
  router.put('/keys', wrap(async (req, res) => {
    const updates = Object.entries(req.body ?? {}).filter(([name]) => MW_KEYS[name]);
    if (!updates.length) throw new HttpError(400, 'Nothing to save');
    for (const [name, raw] of updates) {
      const value = String(raw ?? '').trim();
      if (value.length > MAX_KEY) throw new HttpError(400, 'That key is too long');
      if (!value) continue;
      const result = await testKey(name, value);
      if (!result.ok) {
        const { label } = MW_KEYS[name];
        throw new HttpError(400, result.invalidKey
          ? `Merriam-Webster didn’t accept this ${label} key. Check that it’s your Collegiate ${label} key.`
          : `Couldn’t check the ${label} key (${result.message}). Try again.`);
      }
    }
    for (const [name, raw] of updates) {
      const value = String(raw ?? '').trim();
      if (value) settings.merge({ [MW_KEYS[name].setting]: value });
      else settings.remove(MW_KEYS[name].setting);
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
