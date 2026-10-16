// Tiny DOM builder. Text children are always set as text, never parsed as HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function debounce(fn, ms) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return debounced;
}

export function playAudio(url) {
  new Audio(url).play().catch(() => toast('Couldn’t play the pronunciation'));
}

let toastTimer;
export function toast(message, { action } = {}) {
  const node = document.getElementById('toast');
  const hide = () => { node.hidden = true; };
  node.replaceChildren(el('span', {}, message));
  if (action) {
    node.append(el('button', {
      class: 'toast-action', type: 'button',
      onclick: () => { hide(); action.onClick(); },
    }, action.label));
  }
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 6000 : 3000);
}
