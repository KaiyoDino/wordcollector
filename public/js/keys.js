// API key controls in the Settings dialog (Merriam-Webster, and optionally Anthropic). Keys
// are checked and stored by the server; the browser only ever sees whether a key is set and
// its last 4 characters.
import { api } from './api.js';

const dialog = document.getElementById('settings-dialog');
const section = document.getElementById('keys-section');
const saveButton = document.getElementById('keys-save');
const message = document.getElementById('keys-message');
const NAMES = ['collegiate', 'thesaurus', 'groq', 'anthropic'];

const input = (name) => section.querySelector(`[data-key="${name}"]`);

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

async function refreshStatus() {
  try {
    const status = await api.getKeys();
    for (const name of NAMES) {
      const { set, source, hint } = status[name];
      section.querySelector(`[data-key-status="${name}"]`).textContent =
        source === 'app' ? `· saved ${hint}` : source === 'env' ? `· from .env ${hint}` : set ? '' : '· not set';
      section.querySelector(`[data-key-remove="${name}"]`).hidden = source !== 'app';
    }
    return status;
  } catch {
    return null;
  }
}

async function save(values) {
  saveButton.disabled = true;
  showMessage('Checking with Merriam-Webster…');
  try {
    await api.saveKeys(values);
    for (const name of Object.keys(values)) input(name).value = '';
    await refreshStatus();
    showMessage(Object.values(values).some(Boolean) ? 'Saved.' : 'Removed.');
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    saveButton.disabled = false;
  }
}

saveButton.addEventListener('click', () => {
  const values = Object.fromEntries(NAMES.map((n) => [n, input(n).value.trim()]).filter(([, v]) => v));
  if (!Object.keys(values).length) return showMessage('Paste a key first.', true);
  save(values);
});

for (const name of NAMES) {
  section.querySelector(`[data-key-remove="${name}"]`).addEventListener('click', () => save({ [name]: '' }));
  input(name).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveButton.click(); }
  });
}

// Opens Settings scrolled to a key field (used when a lookup or explanation needs a key).
export function openKeySettings(name = 'collegiate') {
  if (!dialog.open) dialog.showModal();
  const field = input(NAMES.includes(name) ? name : 'collegiate');
  field.closest('.key-field').scrollIntoView({ block: 'center' });
  field.focus();
}

dialog.addEventListener('close', () => {
  showMessage('');
  for (const name of NAMES) input(name).value = '';
});
new MutationObserver(() => { if (dialog.open) refreshStatus(); })
  .observe(dialog, { attributes: true, attributeFilter: ['open'] });
