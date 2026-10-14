// Word library queries. Every write goes through db.transaction so it's saved to disk.
export const USER_SOURCE = 'user';
export const MAX_TAGS_PER_WORD = 20;
export const MAX_TAG_LENGTH = 40;
export const REVIEW_MAX_BOX = 5;

const SORTS = {
  alpha: 'w.term COLLATE NOCASE ASC',
  alpha_desc: 'w.term COLLATE NOCASE DESC',
  date: 'w.created_at DESC, w.id DESC',
  date_asc: 'w.created_at ASC, w.id ASC',
  pos: 'w.primary_pos IS NULL, w.primary_pos COLLATE NOCASE ASC, w.term COLLATE NOCASE ASC',
};

// Fields PATCH /api/words/:id may change, besides tags.
const EDITABLE = ['notes', 'favorite', 'primary_pos', 'found_title', 'found_author', 'found_page'];

const now = () => new Date().toISOString();

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const toWord = (row) => row && { ...row, favorite: Boolean(row.favorite) };
const toDefinition = ({ example, ...row }) => ({ ...row, examples: parseJsonArray(row.examples) });

export function createWordStore(db) {
  function tagsFor(wordId) {
    return db.all(
      `SELECT t.name FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
        WHERE wt.word_id = $id ORDER BY t.name COLLATE NOCASE`,
      { $id: wordId },
    ).map((r) => r.name);
  }

  function list({ sort = 'date', favFirst = false, q = '', tag = '' } = {}) {
    const order = [favFirst ? 'w.favorite DESC' : null, SORTS[sort] ?? SORTS.date]
      .filter(Boolean)
      .join(', ');
    const rows = db.all(
      `SELECT w.id, w.term, w.favorite, w.primary_pos, w.created_at, w.found_title,
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
        ORDER BY ${order}`,
      { $q: q, $like: `%${q}%`, $tag: tag },
    );
    return rows.map((r) => ({ ...toWord(r), tags: parseJsonArray(r.tags) }));
  }

  function get(id) {
    const word = toWord(db.get('SELECT * FROM words WHERE id = $id', { $id: id }));
    if (!word) return null;
    word.definitions = db.all(
      'SELECT * FROM definitions WHERE word_id = $id ORDER BY position, id',
      { $id: id },
    ).map(toDefinition);
    const relations = db.all(
      'SELECT kind, value, source FROM relations WHERE word_id = $id ORDER BY id',
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
  function writeLookup(wordId, lookup) {
    const existing = db.all(
      `SELECT id, source, text FROM definitions WHERE word_id = $id AND source <> '${USER_SOURCE}'`,
      { $id: wordId },
    );
    const byKey = new Map(existing.map((d) => [`${d.source}\n${d.text}`, d.id]));
    let position = nextPosition(wordId);
    for (const source of lookup.sources) {
      for (const def of source.definitions) {
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
      for (const item of items) {
        db.run(
          'INSERT OR IGNORE INTO relations (word_id, kind, value, source) VALUES ($w, $k, $v, $s)',
          { $w: wordId, $k: kind, $v: item.value, $s: item.source },
        );
      }
    }
  }

  function create(term, lookup) {
    const id = db.transaction(() => {
      const ts = now();
      const { lastId } = db.run(
        `INSERT INTO words (term, primary_pos, pronunciation, audio_url, etymology, first_use, created_at, updated_at)
         VALUES ($term, $pos, $pr, $audio, $et, $first, $ts, $ts)`,
        {
          $term: term, $pos: lookup.primaryPos, $pr: lookup.pronunciation, $audio: lookup.audioUrl,
          $et: lookup.etymology, $first: lookup.firstUse, $ts: ts,
        },
      );
      writeLookup(lastId, lookup);
      return lastId;
    });
    return get(id);
  }

  function refresh(id, lookup) {
    db.transaction(() => {
      writeLookup(id, lookup);
      db.run(
        `UPDATE words SET pronunciation = COALESCE($pr, pronunciation), audio_url = COALESCE($audio, audio_url),
                          etymology = COALESCE($et, etymology), first_use = COALESCE($first, first_use),
                          primary_pos = COALESCE(primary_pos, $pos), updated_at = $ts
          WHERE id = $id`,
        {
          $id: id, $pr: lookup.pronunciation, $audio: lookup.audioUrl, $et: lookup.etymology,
          $first: lookup.firstUse, $pos: lookup.primaryPos, $ts: now(),
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
  function reviewBatch({ tag = '', favorites = false, limit = 20 } = {}) {
    const rows = db.all(
      `SELECT w.id FROM words w
        WHERE ($fav = 0 OR w.favorite = 1)
          AND ($tag = '' OR EXISTS (
                SELECT 1 FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
                 WHERE wt.word_id = w.id AND t.name = $tag COLLATE NOCASE))
        ORDER BY w.review_box ASC, w.last_reviewed_at IS NOT NULL, w.last_reviewed_at ASC, random()
        LIMIT $limit`,
      { $fav: favorites ? 1 : 0, $tag: tag, $limit: limit },
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
        synonyms: synonyms.map(({ value, source }) => ({ value, source })),
        antonyms: antonyms.map(({ value, source }) => ({ value, source })),
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
          `INSERT INTO words (term, favorite, notes, primary_pos, pronunciation, audio_url, etymology, first_use,
                              found_title, found_author, found_page, review_box, review_count, last_reviewed_at,
                              created_at, updated_at)
           VALUES ($term, $fav, $notes, $pos, $pr, $audio, $et, $first, $title, $author, $page, $box, $count, $last, $created, $updated)`,
          {
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
              'INSERT OR IGNORE INTO relations (word_id, kind, value, source) VALUES ($w, $k, $v, $s)',
              { $w: lastId, $k: kind, $v: item.value, $s: item.source },
            );
          }
        }
        if (w.tags.length) writeTags(lastId, w.tags);
        added++;
      }
      return { added, skipped };
    });
  }

  return {
    list, get, findByTerm, create, refresh, update, remove,
    definitionIds, reorder, getDefinition, addUserDefinition, updateUserDefinition, removeDefinition,
    listTags, reviewBatch, recordReview, exportAll, importAll,
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
