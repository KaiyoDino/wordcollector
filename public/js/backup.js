// Backups in the Settings dialog: automatic backups (list, back up now, restore, folder)
// and exporting/importing a backup file.
import { api } from './api.js';
import { el, fill, toast } from './dom.js';

const dialog = document.getElementById('settings-dialog');
const dirLabel = document.getElementById('backup-dir');
const lastLabel = document.getElementById('backup-last');
const listNode = document.getElementById('backup-list');
const nowButton = document.getElementById('backup-now');
const openButton = document.getElementById('backup-open');
const changeButton = document.getElementById('backup-change');
const defaultButton = document.getElementById('backup-default');
const desktop = window.desktop;

const SHOWN = 6;
const KIND_LABELS = {
  daily: 'Daily',
  manual: 'Backed up by you',
  'before-upgrade': 'Before an app upgrade',
  'before-restore': 'Before a restore',
};

let state = null;
let showAll = false;

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function refresh() {
  try {
    state = await api.listBackups();
  } catch (err) {
    lastLabel.textContent = err.message;
    return;
  }
  dirLabel.textContent = state.location;
  dirLabel.title = state.location;
  lastLabel.textContent = state.items.length ? `· last backup ${when(state.items[0].created)}` : '· no backups yet';
  openButton.hidden = !desktop;
  changeButton.hidden = !desktop;
  defaultButton.hidden = state.isDefault;
  renderList();
}

function renderList() {
  const items = showAll ? state.items : state.items.slice(0, SHOWN);
  fill(listNode,
    items.map((item) => el('li', { class: 'backup-item' },
      el('span', { class: 'backup-when' }, when(item.created)),
      el('span', { class: 'backup-kind' }, KIND_LABELS[item.kind] ?? item.kind),
      el('span', { class: 'backup-words' }, item.words == null ? 'unreadable' : plural(item.words, 'word')),
      el('button', {
        class: 'btn ghost small', type: 'button', disabled: item.words == null,
        onclick: () => restore(item),
      }, 'Restore'))),
    !showAll && state.items.length > SHOWN && el('li', {},
      el('button', { class: 'link-button', type: 'button', onclick: () => { showAll = true; renderList(); } },
        `Show all ${state.items.length}`)));
}

async function restore(item) {
  const ok = confirm(`Replace your library with the backup from ${when(item.created)} (${plural(item.words, 'word')})?\n\n`
    + 'Your current library is backed up first, so you can undo this.');
  if (!ok) return;
  try {
    await api.restoreBackup(item.name);
    toast('Backup restored. Reloading…');
    setTimeout(() => window.location.reload(), 600);
  } catch (err) {
    toast(err.message);
  }
}

async function setLocation(dir) {
  try {
    await api.setBackupLocation(dir);
    await refresh();
    toast(dir ? 'Future backups will be saved in the new folder.' : 'Backups will be saved in the default folder.');
  } catch (err) {
    toast(err.message);
  }
}

nowButton.addEventListener('click', async () => {
  nowButton.disabled = true;
  try {
    await api.backupNow();
    await refresh();
    toast('Backed up.');
  } catch (err) {
    toast(err.message);
  } finally {
    nowButton.disabled = false;
  }
});
openButton.addEventListener('click', async () => {
  if (!(await desktop.openBackupFolder(state.location))) toast('Couldn’t open the backup folder.');
});
changeButton.addEventListener('click', async () => {
  const folder = await desktop.chooseBackupFolder(state.location);
  if (folder) setLocation(folder);
});
defaultButton.addEventListener('click', () => setLocation(''));

new MutationObserver(() => {
  if (dialog.open) {
    showAll = false;
    refresh();
  }
}).observe(dialog, { attributes: true, attributeFilter: ['open'] });

export function initBackup({ onImported }) {
  const fileInput = document.getElementById('import-file');
  document.getElementById('export-json').href = api.exportUrl('json');
  document.getElementById('export-csv').href = api.exportUrl('csv');
  document.getElementById('import-backup').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('That file isn’t valid JSON. Choose a Word Collector backup (.json).');
      return;
    }
    try {
      const { added, skipped, comparisons = 0 } = await api.importBackup(data);
      const words = (n) => plural(n, 'word');
      const extra = comparisons ? ` Restored ${plural(comparisons, 'comparison')}.` : '';
      toast((skipped
        ? `Imported ${words(added)}. Skipped ${words(skipped)} already in your library.`
        : `Imported ${words(added)}.`) + extra);
      onImported?.();
    } catch (err) {
      toast(err.message);
    }
  });
}
