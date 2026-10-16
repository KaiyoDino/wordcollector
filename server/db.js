// SQLite storage via sql.js (WebAssembly), persisted to a single file.
// No native modules, so this runs unchanged inside Electron later.
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS words (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  term        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  favorite    INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  primary_pos TEXT,
  pronunciation TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS definitions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id        INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  part_of_speech TEXT,
  text           TEXT NOT NULL,
  example        TEXT,
  position       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS relations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('synonym', 'antonym')),
  value   TEXT NOT NULL,
  source  TEXT NOT NULL,
  UNIQUE (word_id, kind, value)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_definitions_word ON definitions(word_id);
CREATE INDEX IF NOT EXISTS idx_relations_word ON relations(word_id);
`;

// Each migration runs once, in order; PRAGMA user_version records how many have run.
const MIGRATIONS = [
  // 1: MW extras, where-found fields, review state, examples, tags, one shared definition order.
  `
  ALTER TABLE words ADD COLUMN audio_url TEXT;
  ALTER TABLE words ADD COLUMN etymology TEXT;
  ALTER TABLE words ADD COLUMN first_use TEXT;
  ALTER TABLE words ADD COLUMN found_title TEXT NOT NULL DEFAULT '';
  ALTER TABLE words ADD COLUMN found_author TEXT NOT NULL DEFAULT '';
  ALTER TABLE words ADD COLUMN found_page TEXT NOT NULL DEFAULT '';
  ALTER TABLE words ADD COLUMN review_box INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE words ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE words ADD COLUMN last_reviewed_at TEXT;

  ALTER TABLE definitions ADD COLUMN examples TEXT NOT NULL DEFAULT '[]';
  UPDATE definitions SET examples = json_array(example) WHERE example IS NOT NULL AND example <> '';

  -- Positions were numbered per source; renumber per word, dictionary rows first.
  UPDATE definitions SET position = (
    SELECT COUNT(*) FROM definitions d2
     WHERE d2.word_id = definitions.word_id
       AND ((d2.source = 'user') < (definitions.source = 'user')
         OR ((d2.source = 'user') = (definitions.source = 'user')
             AND (d2.position < definitions.position
               OR (d2.position = definitions.position AND d2.id < definitions.id))))
  );

  CREATE TABLE tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE word_tags (
    word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (word_id, tag_id)
  );
  CREATE INDEX idx_word_tags_tag ON word_tags(tag_id);
  `,
  // 2: phrases, chosen parts of speech, MW synonym discussions, saved AI comparisons.
  `
  ALTER TABLE words ADD COLUMN kind TEXT NOT NULL DEFAULT 'word';
  UPDATE words SET kind = 'phrase' WHERE instr(trim(term), ' ') > 0;
  ALTER TABLE words ADD COLUMN pos_filter TEXT;
  ALTER TABLE words ADD COLUMN syn_discussion TEXT;
  ALTER TABLE relations ADD COLUMN part_of_speech TEXT;

  CREATE TABLE comparisons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    term_a      TEXT NOT NULL,
    term_b      TEXT NOT NULL,
    explanation TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (term_a, term_b)
  );
  `,
  // 3: saved comparisons (with your note), and which AI provider wrote each explanation.
  `
  CREATE TABLE saved_comparisons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    term_a     TEXT NOT NULL,
    term_b     TEXT NOT NULL,
    key_a      TEXT NOT NULL,
    key_b      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (key_a, key_b)
  );
  ALTER TABLE comparisons ADD COLUMN provider TEXT;
  UPDATE comparisons SET provider = 'anthropic' WHERE model LIKE 'claude%';
  `,
];

function migrate(db) {
  const version = db.exec('PRAGMA user_version')[0].values[0][0];
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.run('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.run(`PRAGMA user_version = ${i + 1}`);
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw new Error(`Database migration ${i + 1} failed: ${err.message}`);
    }
  }
}

export async function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'wordcollector.sqlite');
  const SQL = await initSqlJs();
  const db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  // Earlier versions lost foreign keys after the first save; clear rows they left behind.
  db.exec(`
    DELETE FROM definitions WHERE word_id NOT IN (SELECT id FROM words);
    DELETE FROM relations WHERE word_id NOT IN (SELECT id FROM words);
    DELETE FROM word_tags WHERE word_id NOT IN (SELECT id FROM words);
    DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM word_tags);
  `);

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    // sql.js's export() resets connection pragmas, which would silently turn off cascades.
    db.run('PRAGMA foreign_keys = ON;');
    fs.renameSync(tmp, file);
  }

  function all(sql, params = {}) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  const get = (sql, params) => all(sql, params)[0];

  function run(sql, params = {}) {
    db.run(sql, params);
    return {
      changes: db.getRowsModified(),
      lastId: get('SELECT last_insert_rowid() AS id').id,
    };
  }

  // Runs fn inside a transaction and saves to disk once at the end.
  function transaction(fn) {
    db.run('BEGIN');
    try {
      const result = fn();
      db.run('COMMIT');
      save();
      return result;
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }

  save();
  return { all, get, run, transaction, file };
}
