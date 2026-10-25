// Small DOM helpers and icons.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

const P = {
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.4-2.4.8a7.4 7.4 0 0 0-1.7-1L14.9 3h-3.8l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.4-.8-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.4 2.4-.8a7.4 7.4 0 0 0 1.7 1l.4 2.9h3.8l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.4.8 2-3.4-2-1.5z',
  close: 'M6 6l12 12M18 6L6 18',
  attach: 'M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7',
  chart: 'M4 20V4M4 20h16M8 16l3.5-4.5 3 2.5L19 8',
  math: 'M5 6h8l-5 6 5 6H5M15 9l4 6M19 9l-4 6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  code: 'M9 8l-5 4 5 4M15 8l5 4-5 4',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  check: 'M5 12.5l4.5 4.5L19 7',
  heading: 'M6 4v16M18 4v16M6 12h12',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M14 4h-4M14 20h-4M14 4l-4 16',
  quote: 'M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6',
  print: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
  history: 'M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5M12 8v4l3 2',
  sync: 'M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4',
  pen: 'M3 21c3-1 5-3 6-6l8-8a2.1 2.1 0 0 0-3-3l-8 8c-3 1-5 3-6 6zM14 5l3 3',
  continue: 'M5 12h11M12 7l5 5-5 5M20 5v14',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  write: 'M4 20h16M6 16l9.5-9.5a2 2 0 0 1 3 3L9 19H6z',
};
export function icon(name, size = 20) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', P[name] || '');
  svg.append(path);
  return svg;
}

const scripts = {};
export function loadScript(src, integrity) {
  if (scripts[src]) return scripts[src];
  scripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    if (integrity) s.integrity = integrity;
    s.onload = () => resolve();
    s.onerror = () => { delete scripts[src]; s.remove(); reject(new Error(`Couldn't load ${src.split('/').pop()}. Check your connection.`)); };
    document.head.append(s);
  });
  return scripts[src];
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
