// Recent searches (library search, Dictionary, Find a word). They're kept with the settings,
// so they survive restarts and move with backups. attachHistory() offers them in a
// dropdown under a search field.
import { el, icon } from './dom.js';
import { getSettings, setSettings } from './settings.js';

const MAX_ITEMS = 12;
const MAX_SHOWN = 8;

const clean = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ');

export const recentSearches = (key) => getSettings()[key] ?? [];

// Moves `raw` to the front of the list (once, whatever its capitalization).
export function rememberSearch(key, raw) {
  const term = clean(raw);
  const list = recentSearches(key);
  if (!term || list[0] === term) return;
  setSettings({ [key]: [term, ...list.filter((t) => t.toLowerCase() !== term.toLowerCase())].slice(0, MAX_ITEMS) });
}

export const forgetSearch = (key, term) => setSettings({ [key]: recentSearches(key).filter((t) => t !== term) });

let menus = 0;

// The dropdown opens when the field is focused while empty, or on ↓ (then it lists the
// recent searches containing what's typed). ↑/↓ and Enter pick one, which calls
// onPick(term); Esc closes it. anchor: the box to line the menu up with (default: input).
export function attachHistory(input, { key, onPick, anchor = input, label = 'Recent searches' }) {
  const listId = `history-${++menus}`;
  const list = el('ul', { class: 'history-list', id: listId, role: 'listbox', 'aria-label': label });
  const menu = el('div', { class: 'history-menu', hidden: true },
    el('p', { class: 'history-label', 'aria-hidden': 'true' }, label),
    list,
    el('button', {
      class: 'link-button history-clear', type: 'button', tabindex: '-1',
      onclick: () => { setSettings({ [key]: [] }); close(); },
    }, 'Clear history'));
  // Keep focus in the field while using the menu, so it doesn't close under the pointer.
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.append(menu);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  let items = [];
  let active = -1;

  const isOpen = () => !menu.hidden;

  function close() {
    menu.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function highlight(index) {
    active = index;
    list.querySelectorAll('[role="option"]').forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) input.setAttribute('aria-activedescendant', `${listId}-${index}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function pick(term) {
    close();
    input.value = term;
    onPick(term);
  }

  function open() {
    if (document.activeElement !== input) return close();
    const typed = clean(input.value).toLowerCase();
    items = recentSearches(key)
      .filter((t) => !typed || (t.toLowerCase().includes(typed) && t.toLowerCase() !== typed))
      .slice(0, MAX_SHOWN);
    if (!items.length) return close();
    list.replaceChildren(...items.map((term, i) => el('li', {
      id: `${listId}-${i}`, role: 'option', class: 'history-item', 'aria-selected': 'false',
      onclick: () => pick(term),
    },
    icon('clock'),
    el('span', { class: 'history-term' }, term),
    el('button', {
      class: 'history-remove', type: 'button', tabindex: '-1', title: 'Remove from history',
      'aria-label': `Remove “${term}” from history`,
      onclick: (e) => { e.stopPropagation(); forgetSearch(key, term); open(); },
    }, icon('x')))));
    const box = anchor.getBoundingClientRect();
    menu.style.left = `${box.left}px`;
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.width = `${Math.max(box.width, 240)}px`;
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  }

  input.addEventListener('focus', () => { if (!clean(input.value)) open(); });
  input.addEventListener('mousedown', () => { if (document.activeElement === input && !clean(input.value) && !isOpen()) open(); });
  input.addEventListener('input', () => { if (clean(input.value)) close(); else open(); });
  input.addEventListener('blur', close);
  window.addEventListener('resize', close);
  // Belt and braces: a press anywhere else closes it, even if the field never had a blur.
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && e.target !== input && !menu.contains(e.target)) close();
  }, true);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) open();
      if (!isOpen()) return;
      // -1 is the field itself, so ↑ from the first item goes back to what was typed.
      const next = active + (e.key === 'ArrowDown' ? 1 : -1);
      highlight(next >= items.length ? -1 : next < -1 ? items.length - 1 : next);
    } else if (e.key === 'Enter' && isOpen() && active >= 0) {
      // Picking from the list; the field's own Enter (e.g. submitting its form) is skipped.
      e.preventDefault();
      e.stopPropagation();
      pick(items[active]);
    } else if (e.key === 'Escape' && isOpen()) {
      // Only close the menu; Esc again closes the screen it's on.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  return { close };
}
