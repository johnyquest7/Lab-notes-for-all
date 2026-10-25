// Full-text search over the page index.
import { esc } from './util.js';

export function search(pages, query, { vol = '', tag = '' } = {}) {
  const raw = String(query || '').toLowerCase().trim();
  const words = raw.split(/\s+/).filter(Boolean);
  const tagTerms = words.filter((w) => w.startsWith('#')).map((w) => w.slice(1));
  const terms = words.filter((w) => !w.startsWith('#'));
  if (tag) tagTerms.push(tag);
  const results = [];
  for (const p of pages) {
    if (vol && p.vol !== vol) continue;
    if (tagTerms.some((t) => !(p.tags || []).includes(t))) continue;
    const title = (p.title || '').toLowerCase();
    const text = (p.text || '').toLowerCase();
    const tags = (p.tags || []).join(' ');
    let score = 0; let ok = true;
    for (const t of terms) {
      let s = 0;
      if (title.includes(t)) s += 10;
      if (tags.includes(t)) s += 6;
      let i = -1; let n = 0;
      while (n < 5 && (i = text.indexOf(t, i + 1)) !== -1) n++;
      s += n;
      if (String(p.num) === t) s += 8;
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    results.push({ page: p, score, snippet: snippet(p.text || '', terms) });
  }
  results.sort((a, b) => b.score - a.score || String(b.page.date).localeCompare(String(a.page.date)) || b.page.num - a.page.num);
  return results;
}

function snippet(text, terms) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  const start = Math.max(0, at === -1 ? 0 : at - 70);
  let s = text.slice(start, start + 200);
  if (start > 0) s = `…${s.replace(/^\S*\s/, '')}`;
  if (start + 200 < text.length) s += '…';
  let html = esc(s);
  for (const t of terms) {
    if (t.length < 2) continue;
    const re = new RegExp(`(${esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    html = html.replace(re, '<mark>$1</mark>');
  }
  return html;
}
