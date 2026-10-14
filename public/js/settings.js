// Appearance + list preferences. Saved to the server (durable) and localStorage (instant first paint).
import { api } from './api.js';
import { el, debounce } from './dom.js';

export const DEFAULTS = {
  theme: 'system',
  accent: '#C96442',
  font: 'serif',
  fontSize: 16,
  density: 'cards',
  sort: 'date',
  favFirst: false,
};

const ACCENTS = [
  ['Terracotta', '#C96442'],
  ['Clay', '#D97757'],
  ['Amber', '#B8862B'],
  ['Sage', '#5E8B6A'],
  ['Ocean', '#3E7CB1'],
  ['Plum', '#8E5BA8'],
  ['Graphite', '#5F5D57'],
];

const LOCAL_KEY = 'wc.settings';
let current = { ...DEFAULTS, ...readLocal() };
const listeners = new Set();

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; }
}

function writeLocal() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(current)); } catch { /* storage unavailable */ }
}

const pushToServer = debounce(() => api.saveSettings(current).catch(() => {}), 400);

export const getSettings = () => current;
export const onSettingsChange = (fn) => listeners.add(fn);

export function setSettings(changes) {
  current = { ...current, ...changes };
  apply();
  writeLocal();
  pushToServer();
  listeners.forEach((fn) => fn(current, changes));
}

function apply() {
  const root = document.documentElement;
  if (current.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = current.theme;
  root.dataset.font = current.font;
  root.dataset.density = current.density;
  root.style.setProperty('--accent', current.accent);
  root.style.setProperty('--font-size', `${current.fontSize}px`);
  syncControls();
}

// Server copy wins over localStorage, since it's what survives a move to the desktop app.
export async function loadSettings() {
  apply();
  try {
    const remote = await api.getSettings();
    if (Object.keys(remote).length) {
      current = { ...DEFAULTS, ...remote };
      apply();
      writeLocal();
    } else {
      pushToServer();
    }
  } catch { /* offline: keep local copy */ }
  return current;
}

// Settings dialog
const dialog = document.getElementById('settings-dialog');
const swatches = document.getElementById('swatches');
const fontSize = document.getElementById('font-size');
const fontSizeOut = document.getElementById('font-size-out');
const customInput = el('input', { type: 'color', 'aria-label': 'Custom accent color' });

swatches.append(
  ...ACCENTS.map(([name, color]) =>
    el('button', {
      type: 'button', class: 'swatch', title: name, 'aria-label': name, dataset: { color },
      style: `background:${color}`, onclick: () => setSettings({ accent: color }),
    })),
  el('label', { class: 'swatch swatch-custom', title: 'Custom color' }, customInput),
);
customInput.addEventListener('input', () => setSettings({ accent: customInput.value.toUpperCase() }));

dialog.querySelectorAll('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button) setSettings({ [group.dataset.setting]: button.value });
  });
});

fontSize.addEventListener('input', () => setSettings({ fontSize: Number(fontSize.value) }));
document.getElementById('settings-reset').addEventListener('click', () => {
  const { sort, favFirst } = current;
  setSettings({ ...DEFAULTS, sort, favFirst });
});
document.getElementById('open-settings').addEventListener('click', () => dialog.showModal());

function syncControls() {
  dialog.querySelectorAll('.segmented').forEach((group) => {
    for (const button of group.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.value === current[group.dataset.setting]));
    }
  });
  const preset = ACCENTS.some(([, c]) => c.toLowerCase() === current.accent.toLowerCase());
  for (const swatch of swatches.querySelectorAll('[data-color]')) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color.toLowerCase() === current.accent.toLowerCase()));
  }
  const custom = swatches.querySelector('.swatch-custom');
  custom.setAttribute('aria-pressed', String(!preset));
  custom.style.background = preset ? '' : current.accent;
  customInput.value = current.accent;
  fontSize.value = current.fontSize;
  fontSizeOut.textContent = `${current.fontSize}px`;
}
