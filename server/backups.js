// Automatic backups of the whole library file: once a day, before every upgrade, before a
// restore, and on request. Each is a complete copy (words, notes, comparisons, settings and
// keys) that can be restored from Settings.
import fs from 'node:fs';
import path from 'node:path';
import { inspectLibrary, LATEST_VERSION } from './db.js';

// wordcollector-2026-10-15_224714-daily.sqlite
const NAME = /^wordcollector-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-(daily|manual|before-restore|before-upgrade-v\d+)\.sqlite$/;
// How many of each kind to keep; the oldest beyond this are removed. Manual ones are kept.
const KEEP = { daily: 14, 'before-upgrade': 10, 'before-restore': 10 };

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d) => `${localDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const group = (kind) => (kind.startsWith('before-upgrade') ? 'before-upgrade' : kind);

function parse(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, kind] = m;
  return { name, kind, created: new Date(+y, +mo - 1, +d, +h, +mi, +s) };
}

export class BackupError extends Error {}

// dir(): the folder in use right now (it can change in Settings).
export function createBackups({ dir }) {
  function write(bytes, kind, folder = dir()) {
    fs.mkdirSync(folder, { recursive: true });
    let name = `wordcollector-${stamp(new Date())}-${kind}.sqlite`;
    // Two backups in the same second (e.g. "Back up now" twice): don't overwrite.
    for (let i = 1; fs.existsSync(path.join(folder, name)); i++) {
      name = `wordcollector-${stamp(new Date(Date.now() + i * 1000))}-${kind}.sqlite`;
    }
    const target = path.join(folder, name);
    fs.writeFileSync(`${target}.tmp`, bytes);
    fs.renameSync(`${target}.tmp`, target);
    prune(folder);
    return name;
  }

  function entries(folder = dir()) {
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      return [];
    }
    return names.map(parse).filter(Boolean).sort((a, b) => b.created - a.created || b.name.localeCompare(a.name));
  }

  function prune(folder) {
    const seen = {};
    for (const entry of entries(folder)) {
      const g = group(entry.kind);
      seen[g] = (seen[g] ?? 0) + 1;
      if (KEEP[g] && seen[g] > KEEP[g]) fs.rmSync(path.join(folder, entry.name), { force: true });
    }
  }

  async function list() {
    const folder = dir();
    return Promise.all(entries(folder).map(async (entry) => {
      const file = path.join(folder, entry.name);
      let words = null;
      try {
        ({ words } = await inspectLibrary(fs.readFileSync(file)));
      } catch { /* unreadable: still listed, restore will explain */ }
      return { name: entry.name, kind: group(entry.kind), created: entry.created.toISOString(), size: fs.statSync(file).size, words };
    }));
  }

  // One backup per calendar day, taken the first time the app runs that day.
  function dailyIfDue(snapshot) {
    const today = localDate(new Date());
    if (entries().some((e) => e.kind === 'daily' && localDate(e.created) === today)) return null;
    return write(snapshot(), 'daily');
  }

  // Replaces the library with a backup. The current library is backed up first.
  async function restore(name, db) {
    const entry = parse(String(name ?? ''));
    const file = entry && path.join(dir(), entry.name);
    if (!file || !fs.existsSync(file)) throw new BackupError('That backup no longer exists.');
    const bytes = fs.readFileSync(file);
    const { version } = await inspectLibrary(bytes); // throws a readable error if it isn't a library
    if (version > LATEST_VERSION) {
      throw new BackupError('That backup was saved by a newer version of Word Collector. Update the app first.');
    }
    write(db.snapshot(), 'before-restore');
    db.replace(bytes);
  }

  return { write, list, dailyIfDue, restore, dir };
}
