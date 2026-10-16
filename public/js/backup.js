// Library backup controls in the Settings dialog.
import { api } from './api.js';
import { toast } from './dom.js';

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
      const plural = (n) => `${n} word${n === 1 ? '' : 's'}`;
      const extra = comparisons ? ` Restored ${comparisons} comparison${comparisons === 1 ? '' : 's'}.` : '';
      toast((skipped
        ? `Imported ${plural(added)}. Skipped ${plural(skipped)} already in your library.`
        : `Imported ${plural(added)}.`) + extra);
      onImported?.();
    } catch (err) {
      toast(err.message);
    }
  });
}
