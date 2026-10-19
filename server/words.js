// Word library queries. Every write goes through db.transaction so it's saved to disk.
export const USER_SOURCE = 'user';
export const MAX_TAGS_PER_WORD = 20;
export const MAX_TAG_LENGTH = 40;
export const REVIEW_MAX_BOX = 5;
// Dictionary definitions kept per word, counted after any part-of-speech choice.
export const MAX_SAVED_DEFINITIONS = 20;

const SORTS = {
  alpha: 'w.term COLLATE NOCASE ASC',
  alpha_desc: 'w.term COLLATE NOCASE DESC',
  date: 'w.created_at DESC, w.id DESC',
  date_asc: 'w.created_at ASC, w.id ASC',
  pos: 'w.primary_pos IS NULL, w.primary_pos COLLATE NOCASE ASC, w.term COLLATE NOCASE ASC',
};

// Fields PATCH /api/words/:id may change, besides tags.
const EDITABLE = ['notes', 'favorite', 'primary_pos', 'found_title', 'found_author', 'found_page'];
// "Where I found it", which can also be set on several words at once.
export const FOUND_FIELDS = ['found_title', 'found_author', 'found_page'];

// A word's tags after a bulk edit: `drop` (lowercase names) removed, then `add` appended
// unless already there in any capitalization.
export function bulkTags(current, add, drop) {
  const kept = current.filter((t) => !drop.has(t.toLowerCase()));
  const have = new Set(kept.map((t) => t.toLowerCase()));
  return [...kept, ...add.filter((t) => !have.has(t.toLowerCase()))];
}

const now = () => new Date().toISOString();

function parseJson(value, fallback = null) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const toWord = (row) => row && { ...row, favorite: Boolean(row.favorite) };

// A word's chosen parts of speech: null keeps everything. Definitions and synonyms with no
// part of speech (e.g. "past tense of run") are always kept.
const keeps = (filter, pos) => !filter || !pos || filter.includes(pos);

// Picks the dictionary definitions to save: those of the kept parts of speech, at most
// MAX_SAVED_DEFINITIONS. When there are more, the slots are shared out in turns between
// parts of speech, so "base" (31 noun senses listed first) still keeps its adjective
// senses. Dictionary order is kept.
function selectDefinitions(definitions, filter) {
  const kept = definitions.filter((d) => keeps(filter, d.part_of_speech));
  if (kept.length <= MAX_SAVED_DEFINITIONS) return kept;
  const groups = new Map();
  for (const d of kept) {
    const key = d.part_of_speech ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const chosen = new Set();
  for (let turn = 0; chosen.size < MAX_SAVED_DEFINITIONS; turn++) {
    const before = chosen.size;
    for (const list of groups.values()) {
      if (list[turn] && chosen.size < MAX_SAVED_DEFINITIONS) chosen.add(list[turn]);
    }
    if (chosen.size === before) break;
  }
  return kept.filter((d) => chosen.has(d));
}

// Normalizes a parts-of-speech choice against what the dictionary offers: choosing all of
// them (or none) means no filter, so new senses MW adds later are kept too.
export function normalizePosFilter(chosen, available) {
  if (!Array.isArray(chosen) || !chosen.length) return null;
  const offered = available.map((p) => p.pos);
  const picked = offered.filter((pos) => chosen.includes(pos));
  if (!picked.length || picked.length === offered.length) return null;
  return picked;
}
const toDefinition = ({ example, ...row }) => ({ ...row, examples: parseJsonArray(row.examples) });

export function createWordStore(db) {
  function tagsFor(wordId) {
    return db.all(
      `SELECT t.name FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
        WHERE wt.word_id = $id ORDER BY t.name COLLATE NOCASE`,
      { $id: wordId },
    ).map((r) => r.name);
  }

  function list({ sort = 'date', favFirst = false, q = '', tag = '', kind = '' } = {}) {
    const order = [favFirst ? 'w.favorite DESC' : null, SORTS[sort] ?? SORTS.date]
      .filter(Boolean)
      .join(', ');
    const rows = db.all(
      `SELECT w.id, w.term, w.kind, w.favorite, w.primary_pos, w.created_at,
              w.found_title, w.found_author, w.found_page,
              (SELECT d.text FROM definitions d WHERE d.word_id = w.id
                ORDER BY d.position, d.id LIMIT 1) AS first_definition,
              (SELECT json_group_array(name) FROM (
                 SELECT t.name FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
                  WHERE wt.word_id = w.id ORDER BY t.name COLLATE NOCASE)) AS tags
         FROM words w
        WHERE ($q = '' OR w.term LIKE $like OR w.notes LIKE $like
               OR w.found_title LIKE $like OR w.found_author LIKE $like)
          AND ($tag = '' OR EXISTS (
                SELECT 1 FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
                 WHERE wt.word_id = w.id AND t.name = $tag COLLATE NOCASE))
          AND ($kind = '' OR w.kind = $kind)
        ORDER BY ${order}`,
      { $q: q, $like: `%${q}%`, $tag: tag, $kind: kind },
    );
    return rows.map((r) => ({ ...toWord(r), tags: parseJsonArray(r.tags) }));
  }

  function get(id) {
    const word = toWord(db.get('SELECT * FROM words WHERE id = $id', { $id: id }));
    if (!word) return null;
    word.pos_filter = parseJson(word.pos_filter);
    word.syn_discussion = parseJson(word.syn_discussion);
    word.definitions = db.all(
      'SELECT * FROM definitions WHERE word_id = $id ORDER BY position, id',
      { $id: id },
    ).map(toDefinition);
    const relations = db.all(
      'SELECT kind, value, part_of_speech, source FROM relations WHERE word_id = $id ORDER BY id',
      { $id: id },
    );
    word.synonyms = relations.filter((r) => r.kind === 'synonym');
    word.antonyms = relations.filter((r) => r.kind === 'antonym');
    word.tags = tagsFor(id);
    return word;
  }

  const findByTerm = (term) =>
    db.get('SELECT id FROM words WHERE term = $term COLLATE NOCASE', { $term: term });

  const nextPosition = (wordId) =>
    db.get('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM definitions WHERE word_id = $w', { $w: wordId }).pos;

  function insertDefinition(wordId, source, def, position) {
    return db.run(
      `INSERT INTO definitions (word_id, source, part_of_speech, text, examples, position)
       VALUES ($w, $s, $pos, $text, $ex, $i)`,
      {
        $w: wordId, $s: source, $pos: def.part_of_speech || null, $text: def.text,
        $ex: JSON.stringify(def.examples ?? []), $i: position,
      },
    ).lastId;
  }

  // Merges fresh dictionary results into a word. Rows whose text is unchanged keep
  // their id and place in your order; rows the dictionary dropped are removed; new
  // rows go at the end. Your own definitions are never touched.
  function writeLookup(wordId, lookup, posFilter = null) {
    const existing = db.all(
      `SELECT id, source, text FROM definitions WHERE word_id = $id AND source <> '${USER_SOURCE}'`,
      { $id: wordId },
    );
    const byKey = new Map(existing.map((d) => [`${d.source}\n${d.text}`, d.id]));
    let position = nextPosition(wordId);
    for (const source of lookup.sources) {
      for (const def of selectDefinitions(source.definitions, posFilter)) {
        const key = `${source.id}\n${def.text}`;
        const keptId = byKey.get(key);
        if (keptId) {
          db.run('UPDATE definitions SET part_of_speech = $pos, examples = $ex WHERE id = $id', {
            $id: keptId, $pos: def.part_of_speech || null, $ex: JSON.stringify(def.examples ?? []),
          });
          byKey.delete(key);
        } else {
          insertDefinition(wordId, source.id, def, position++);
        }
      }
    }
    for (const staleId of byKey.values()) db.run('DELETE FROM definitions WHERE id = $id', { $id: staleId });

    db.run('DELETE FROM relations WHERE word_id = $id', { $id: wordId });
    for (const [kind, items] of [['synonym', lookup.synonyms], ['antonym', lookup.antonyms]]) {
      // INSERT OR IGNORE: a synonym listed under two kept parts of speech is stored once.
      for (const item of items.filter((r) => keeps(posFilter, r.part_of_speech))) {
        db.run(
          'INSERT OR IGNORE INTO relations (word_id, kind, value, part_of_speech, source) VALUES ($w, $k, $v, $pos, $s)',
          { $w: wordId, $k: kind, $v: item.value, $pos: item.part_of_speech ?? null, $s: item.source },
        );
      }
    }
  }

  const firstKeptPos = (lookup, posFilter) =>
    lookup.partsOfSpeech?.map((p) => p.pos).find((pos) => keeps(posFilter, pos)) ?? lookup.primaryPos ?? null;

  // extras: optional { posFilter, notes, found_title, found_author, found_page, tags } from the add dialog.
  function create(term, kind, lookup, extras = {}) {
    const posFilter = extras.posFilter ?? null;
    const id = db.transaction(() => {
      const ts = now();
      const { lastId } = db.run(
        `INSERT INTO words (term, kind, primary_pos, pronunciation, audio_url, etymology, first_use, pos_filter,
                            syn_discussion, notes, found_title, found_author, found_page, created_at, updated_at)
         VALUES ($term, $kind, $pos, $pr, $audio, $et, $first, $filter, $disc, $notes, $title, $author, $page, $ts, $ts)`,
        {
          $term: term, $kind: kind, $pos: firstKeptPos(lookup, posFilter), $pr: lookup.pronunciation,
          $audio: lookup.audioUrl, $et: lookup.etymology, $first: lookup.firstUse,
          $filter: posFilter ? JSON.stringify(posFilter) : null,
          $disc: lookup.synonymDiscussion ? JSON.stringify(lookup.synonymDiscussion) : null,
          $notes: extras.notes ?? '', $title: extras.found_title ?? '', $author: extras.found_author ?? '',
          $page: extras.found_page ?? '', $ts: ts,
        },
      );
      writeLookup(lastId, lookup, posFilter);
      if (extras.tags?.length) writeTags(lastId, extras.tags);
      return lastId;
    });
    return get(id);
  }

  // Re-applies fresh dictionary data. With posFilter given (a new choice of parts of
  // speech), it's saved too; otherwise the word's saved choice is used.
  function refresh(id, lookup, { posFilter } = {}) {
    db.transaction(() => {
      const current = db.get('SELECT pos_filter, primary_pos FROM words WHERE id = $id', { $id: id });
      const filter = posFilter !== undefined ? posFilter : parseJson(current.pos_filter);
      writeLookup(id, lookup, filter);
      // Keep the part of speech used for sorting, unless it's no longer among the kept ones.
      const primary = current.primary_pos && keeps(filter, current.primary_pos)
        ? current.primary_pos : firstKeptPos(lookup, filter);
      db.run(
        `UPDATE words SET pronunciation = COALESCE($pr, pronunciation), audio_url = COALESCE($audio, audio_url),
                          etymology = COALESCE($et, etymology), first_use = COALESCE($first, first_use),
                          syn_discussion = COALESCE($disc, syn_discussion), pos_filter = $filter,
                          primary_pos = $primary, updated_at = $ts
          WHERE id = $id`,
        {
          $id: id, $pr: lookup.pronunciation, $audio: lookup.audioUrl, $et: lookup.etymology,
          $first: lookup.firstUse, $ts: now(), $primary: primary,
          $disc: lookup.synonymDiscussion ? JSON.stringify(lookup.synonymDiscussion) : null,
          $filter: filter ? JSON.stringify(filter) : null,
        },
      );
    });
    return get(id);
  }

  // Replaces a word's tags and drops tags no word uses any more.
  function writeTags(wordId, names) {
    db.run('DELETE FROM word_tags WHERE word_id = $w', { $w: wordId });
    for (const name of names) {
      db.run('INSERT OR IGNORE INTO tags (name) VALUES ($n)', { $n: name });
      const { id: tagId } = db.get('SELECT id FROM tags WHERE name = $n COLLATE NOCASE', { $n: name });
      db.run('INSERT OR IGNORE INTO word_tags (word_id, tag_id) VALUES ($w, $t)', { $w: wordId, $t: tagId });
    }
    db.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM word_tags)');
  }

  function update(id, changes) {
    db.transaction(() => {
      for (const field of EDITABLE) {
        if (changes[field] === undefined) continue;
        const value = field === 'favorite' ? (changes.favorite ? 1 : 0) : changes[field];
        db.run(`UPDATE words SET ${field} = $v WHERE id = $id`, { $id: id, $v: value });
      }
      if (changes.tags !== undefined) writeTags(id, changes.tags);
      db.run('UPDATE words SET updated_at = $ts WHERE id = $id', { $id: id, $ts: now() });
    });
    return get(id);
  }

  // The same change to several words at once: tags added and removed, and any "where I
  // found it" fields given (FOUND_FIELDS; '' clears one). Each word keeps its other tags.
  function bulkUpdate(ids, { addTags = [], removeTags = [], fields = {} }) {
    db.transaction(() => {
      const drop = new Set(removeTags.map((t) => t.toLowerCase()));
      for (const id of ids) {
        for (const field of FOUND_FIELDS) {
          if (fields[field] === undefined) continue;
          db.run(`UPDATE words SET ${field} = $v WHERE id = $id`, { $id: id, $v: fields[field] });
        }
        if (addTags.length || removeTags.length) writeTags(id, bulkTags(tagsFor(id), addTags, drop));
        db.run('UPDATE words SET updated_at = $ts WHERE id = $id', { $id: id, $ts: now() });
      }
    });
    return ids.length;
  }

  function remove(id) {
    return db.transaction(() => {
      const removed = db.run('DELETE FROM words WHERE id = $id', { $id: id }).changes > 0;
      db.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM word_tags)');
      return removed;
    });
  }

  function definitionIds(wordId) {
    return db.all('SELECT id FROM definitions WHERE word_id = $w', { $w: wordId }).map((r) => r.id);
  }

  const mainPos = (wordId) => db.get(
    'SELECT part_of_speech AS pos FROM definitions WHERE word_id = $w ORDER BY position, id LIMIT 1',
    { $w: wordId },
  )?.pos ?? null;

  // ids must be exactly the word's definition ids, in the new order. Only position changes.
  // If the word's part of speech was following the main definition (not set by hand),
  // it follows the new main definition too.
  function reorder(wordId, ids) {
    db.transaction(() => {
      const { primary_pos: current } = db.get('SELECT primary_pos FROM words WHERE id = $id', { $id: wordId });
      const oldMain = mainPos(wordId);
      ids.forEach((defId, i) => db.run('UPDATE definitions SET position = $i WHERE id = $id', { $i: i, $id: defId }));
      const newMain = mainPos(wordId);
      if (newMain && (current == null || current === oldMain)) {
        db.run('UPDATE words SET primary_pos = $p WHERE id = $id', { $id: wordId, $p: newMain });
      }
      db.run('UPDATE words SET updated_at = $ts WHERE id = $id', { $id: wordId, $ts: now() });
    });
    return get(wordId);
  }

  const getDefinition = (wordId, defId) => {
    const row = db.get('SELECT * FROM definitions WHERE id = $d AND word_id = $w', { $d: defId, $w: wordId });
    return row && toDefinition(row);
  };

  function addUserDefinition(wordId, { text, part_of_speech, example }) {
    return db.transaction(() => {
      const id = insertDefinition(wordId, USER_SOURCE, {
        text, part_of_speech, examples: example ? [example] : [],
      }, nextPosition(wordId));
      return getDefinition(wordId, id);
    });
  }

  function updateUserDefinition(wordId, defId, { text, part_of_speech, example }) {
    db.transaction(() => {
      if (text !== undefined) db.run('UPDATE definitions SET text = $v WHERE id = $id', { $id: defId, $v: text });
      if (part_of_speech !== undefined) db.run('UPDATE definitions SET part_of_speech = $v WHERE id = $id', { $id: defId, $v: part_of_speech || null });
      if (example !== undefined) db.run('UPDATE definitions SET examples = $v WHERE id = $id', { $id: defId, $v: JSON.stringify(example ? [example] : []) });
    });
    return getDefinition(wordId, defId);
  }

  function removeDefinition(defId) {
    db.transaction(() => db.run('DELETE FROM definitions WHERE id = $id', { $id: defId }));
  }

  function listTags() {
    return db.all(
      `SELECT t.name, COUNT(wt.word_id) AS count FROM tags t
         JOIN word_tags wt ON wt.tag_id = t.id
        GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
    );
  }

  // Leitner-style queue: words in the lowest box first, then the least recently reviewed.
  function reviewBatch({ tag = '', favorites = false, kind = '', limit = 20 } = {}) {
    const rows = db.all(
      `SELECT w.id FROM words w
        WHERE ($fav = 0 OR w.favorite = 1)
          AND ($kind = '' OR w.kind = $kind)
          AND ($tag = '' OR EXISTS (
                SELECT 1 FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
                 WHERE wt.word_id = w.id AND t.name = $tag COLLATE NOCASE))
        ORDER BY w.review_box ASC, w.last_reviewed_at IS NOT NULL, w.last_reviewed_at ASC, random()
        LIMIT $limit`,
      { $fav: favorites ? 1 : 0, $tag: tag, $kind: kind, $limit: limit },
    );
    return rows.map((r) => get(r.id));
  }

  function recordReview(id, known) {
    db.transaction(() => {
      db.run(
        `UPDATE words SET review_box = CASE WHEN $known THEN MIN(review_box + 1, ${REVIEW_MAX_BOX}) ELSE 0 END,
                          review_count = review_count + 1, last_reviewed_at = $ts
          WHERE id = $id`,
        { $id: id, $known: known ? 1 : 0, $ts: now() },
      );
    });
    return get(id);
  }

  function exportAll() {
    const ids = db.all('SELECT id FROM words ORDER BY created_at, id').map((r) => r.id);
    return ids.map((id) => {
      const { id: _id, definitions, synonyms, antonyms, ...word } = get(id);
      return {
        ...word,
        definitions: definitions.map(({ source, part_of_speech, text, examples }) => ({ source, part_of_speech, text, examples })),
        synonyms: synonyms.map(({ value, part_of_speech, source }) => ({ value, part_of_speech, source })),
        antonyms: antonyms.map(({ value, part_of_speech, source }) => ({ value, part_of_speech, source })),
      };
    });
  }

  // words: already-validated export entries (see backup.js). Existing terms are skipped.
  function importAll(words) {
    return db.transaction(() => {
      let added = 0;
      let skipped = 0;
      for (const w of words) {
        if (findByTerm(w.term)) { skipped++; continue; }
        const { lastId } = db.run(
          `INSERT INTO words (term, kind, favorite, notes, primary_pos, pronunciation, audio_url, etymology, first_use,
                              pos_filter, syn_discussion, found_title, found_author, found_page, review_box,
                              review_count, last_reviewed_at, created_at, updated_at)
           VALUES ($term, $kind, $fav, $notes, $pos, $pr, $audio, $et, $first, $filter, $disc, $title, $author, $page,
                   $box, $count, $last, $created, $updated)`,
          {
            $kind: w.kind, $filter: w.pos_filter ? JSON.stringify(w.pos_filter) : null,
            $disc: w.syn_discussion ? JSON.stringify(w.syn_discussion) : null,
            $term: w.term, $fav: w.favorite ? 1 : 0, $notes: w.notes, $pos: w.primary_pos, $pr: w.pronunciation,
            $audio: w.audio_url, $et: w.etymology, $first: w.first_use, $title: w.found_title,
            $author: w.found_author, $page: w.found_page, $box: w.review_box, $count: w.review_count,
            $last: w.last_reviewed_at, $created: w.created_at, $updated: w.updated_at,
          },
        );
        w.definitions.forEach((def, i) => insertDefinition(lastId, def.source, def, i));
        for (const [kind, items] of [['synonym', w.synonyms], ['antonym', w.antonyms]]) {
          for (const item of items) {
            db.run(
              'INSERT OR IGNORE INTO relations (word_id, kind, value, part_of_speech, source) VALUES ($w, $k, $v, $pos, $s)',
              { $w: lastId, $k: kind, $v: item.value, $pos: item.part_of_speech, $s: item.source },
            );
          }
        }
        if (w.tags.length) writeTags(lastId, w.tags);
        added++;
      }
      return { added, skipped };
    });
  }

  // Comparisons are keyed by the pair in alphabetical order, so A-vs-B and B-vs-A match.
  const pairKey = (a, b) => [a.trim().toLowerCase(), b.trim().toLowerCase()].sort();

  // ----- AI explanations (one per pair; each was paid for or rate-limited, so they're kept) -----

  function getExplanation(a, b) {
    const [x, y] = pairKey(a, b);
    return db.get(
      'SELECT explanation, model, provider, created_at FROM comparisons WHERE term_a = $a AND term_b = $b',
      { $a: x, $b: y },
    ) ?? null;
  }

  function writeExplanation(a, b, { explanation, model, provider, created_at = now() }) {
    const [x, y] = pairKey(a, b);
    db.run(
      `INSERT INTO comparisons (term_a, term_b, explanation, model, provider, created_at) VALUES ($a, $b, $e, $m, $p, $ts)
       ON CONFLICT(term_a, term_b) DO UPDATE SET explanation = excluded.explanation, model = excluded.model,
                                                 provider = excluded.provider, created_at = excluded.created_at`,
      { $a: x, $b: y, $e: explanation, $m: model, $p: provider ?? null, $ts: created_at },
    );
  }

  function saveExplanation(a, b, explanation, model, provider) {
    db.transaction(() => writeExplanation(a, b, { explanation, model, provider }));
    return getExplanation(a, b);
  }

  // ----- Saved comparisons (a pair you chose to keep, with an optional note) -----

  const SAVED_COLUMNS = `s.id, s.term_a, s.term_b, s.note, s.created_at, s.updated_at,
    EXISTS (SELECT 1 FROM comparisons c WHERE c.term_a = s.key_a AND c.term_b = s.key_b) AS has_explanation`;
  const toSaved = (row) => row && { ...row, has_explanation: Boolean(row.has_explanation) };

  function listSavedComparisons() {
    return db.all(`SELECT ${SAVED_COLUMNS} FROM saved_comparisons s ORDER BY s.created_at DESC, s.id DESC`).map(toSaved);
  }

  function getSavedComparison(id) {
    return toSaved(db.get(`SELECT ${SAVED_COLUMNS} FROM saved_comparisons s WHERE s.id = $id`, { $id: id }));
  }

  function findSavedComparison(a, b) {
    const [x, y] = pairKey(a, b);
    return toSaved(db.get(`SELECT ${SAVED_COLUMNS} FROM saved_comparisons s WHERE s.key_a = $a AND s.key_b = $b`, { $a: x, $b: y }));
  }

  function writeSavedComparison(a, b, { note, created_at = now() }) {
    const [x, y] = pairKey(a, b);
    db.run(
      `INSERT INTO saved_comparisons (term_a, term_b, key_a, key_b, note, created_at, updated_at)
       VALUES ($ta, $tb, $a, $b, $note, $ts, $ts)
       ON CONFLICT(key_a, key_b) DO UPDATE SET note = COALESCE($noteOrNull, note), updated_at = $now`,
      { $ta: a, $tb: b, $a: x, $b: y, $note: note ?? '', $noteOrNull: note ?? null, $ts: created_at, $now: now() },
    );
  }

  // Saving a pair that's already saved keeps it (and only changes the note if one is given).
  function saveComparison(a, b, note) {
    db.transaction(() => writeSavedComparison(a, b, { note }));
    return findSavedComparison(a, b);
  }

  function updateSavedComparisonNote(id, note) {
    db.transaction(() => db.run(
      'UPDATE saved_comparisons SET note = $note, updated_at = $ts WHERE id = $id',
      { $id: id, $note: note, $ts: now() },
    ));
    return getSavedComparison(id);
  }

  function removeSavedComparison(id) {
    return db.transaction(() => db.run('DELETE FROM saved_comparisons WHERE id = $id', { $id: id }).changes > 0);
  }

  // ----- Backups: saved pairs and every AI explanation -----

  function exportComparisons() {
    const byKey = new Map();
    for (const s of db.all('SELECT term_a, term_b, key_a, key_b, note, created_at FROM saved_comparisons ORDER BY id')) {
      byKey.set(`${s.key_a}\n${s.key_b}`, {
        term_a: s.term_a, term_b: s.term_b, saved: true, note: s.note, saved_at: s.created_at, explanation: null,
      });
    }
    for (const c of db.all('SELECT term_a, term_b, explanation, model, provider, created_at FROM comparisons ORDER BY id')) {
      const key = `${c.term_a}\n${c.term_b}`;
      const entry = byKey.get(key) ?? { term_a: c.term_a, term_b: c.term_b, saved: false, note: '', saved_at: null };
      entry.explanation = { text: c.explanation, model: c.model, provider: c.provider, created_at: c.created_at };
      byKey.set(key, entry);
    }
    return [...byKey.values()];
  }

  // comparisons: validated entries (see backup.js). Pairs already present are left alone.
  function importComparisons(comparisons) {
    return db.transaction(() => {
      let added = 0;
      for (const c of comparisons) {
        let changed = false;
        if (c.saved && !findSavedComparison(c.term_a, c.term_b)) {
          writeSavedComparison(c.term_a, c.term_b, { note: c.note, created_at: c.saved_at ?? now() });
          changed = true;
        }
        if (c.explanation && !getExplanation(c.term_a, c.term_b)) {
          writeExplanation(c.term_a, c.term_b, {
            explanation: c.explanation.text, model: c.explanation.model, provider: c.explanation.provider,
            created_at: c.explanation.created_at ?? now(),
          });
          changed = true;
        }
        if (changed) added++;
      }
      return added;
    });
  }

  return {
    list, get, findByTerm, create, refresh, update, bulkUpdate, remove,
    definitionIds, reorder, getDefinition, addUserDefinition, updateUserDefinition, removeDefinition,
    listTags, reviewBatch, recordReview, exportAll, importAll,
    getExplanation, saveExplanation, listSavedComparisons, getSavedComparison, findSavedComparison,
    saveComparison, updateSavedComparisonNote, removeSavedComparison, exportComparisons, importComparisons,
  };
}

export function createSettingsStore(db) {
  return {
    all() {
      const out = {};
      for (const { key, value } of db.all('SELECT key, value FROM settings')) {
        try { out[key] = JSON.parse(value); } catch { /* skip corrupt value */ }
      }
      return out;
    },
    merge(values) {
      db.transaction(() => {
        for (const [key, value] of Object.entries(values)) {
          db.run(
            'INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            { $k: key, $v: JSON.stringify(value) },
          );
        }
      });
      return this.all();
    },
    get(key) {
      const row = db.get('SELECT value FROM settings WHERE key = $k', { $k: key });
      try { return row ? JSON.parse(row.value) : undefined; } catch { return undefined; }
    },
    remove(key) {
      db.transaction(() => db.run('DELETE FROM settings WHERE key = $k', { $k: key }));
    },
  };
}
