// Lab notebook: views and routing.
import {
  GitHubBackend, MemoryBackend, Library, kv, NetworkError, ConflictError, ApiError, mimeOf,
} from './store.js';
import {
  parseFrontMatter, pagePath, todayISO, nowISO, fmtDate, fmtTime, cleanTag, safeFileName, parseRef, pad,
} from './model.js';
import { renderInto, fitChartsForPrint, loadLib } from './render.js';
import { search } from './search.js';
import { h, icon, debounce, fmtBytes } from './util.js';

// ---------- settings (per device) ----------
const SKEY = 'labnote.settings';
const DEFAULTS = {
  owner: '', repo: '', branch: 'main', token: '',
  apiBase: 'https://api.github.com', theme: 'auto', downscale: true,
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch { /* ignore */ } }
const S = loadSettings();
const DEMO = new URLSearchParams(location.search).has('demo');

const CLOTHS = [
  ['Bottle green', '#24453a'], ['Oxblood', '#5b2228'], ['Navy', '#22335a'],
  ['Slate', '#3c4247'], ['Ochre', '#7d5a1e'], ['Plum', '#4a2c4a'],
];

let lib = null;
const app = document.getElementById('app');
let view = { kind: null, token: 0, urls: [] };

// ---------- boot ----------
function applyTheme() {
  const t = S.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function startLibrary() {
  if (lib) lib.listeners.clear();
  if (DEMO) {
    await kv.del('demo:state'); await kv.del('demo:outbox');
    const { demoFiles } = await import('./demo.js');
    lib = new Library(new MemoryBackend(demoFiles()));
  } else {
    lib = new Library(new GitHubBackend(S));
  }
  lib.on(onLibraryEvent);
  await lib.open();
}

async function boot() {
  applyTheme();
  if ('serviceWorker' in navigator && !DEMO && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => lib?.refresh().then(() => lib.flush()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && lib && Date.now() - (lib.status.at || 0) > 30000) lib.refresh().then(() => lib.flush());
  });
  window.addEventListener('labnote:toast', (e) => toast(e.detail));
  document.addEventListener('keydown', globalKeys);
  window.addEventListener('beforeprint', () => fitChartsForPrint(document, 680));
  window.addEventListener('afterprint', () => {
    fitChartsForPrint(document, null);
    document.body.classList.remove('print-volume');
    document.getElementById('print-root').replaceChildren();
  });
  if (!DEMO && !S.token) { route(); return; }
  try { await startLibrary(); } catch (e) { console.error(e); }
  route();
  // Fetch the chart library in the background so charts also draw offline.
  setTimeout(() => { loadLib('plotly').catch(() => {}); loadLib('papa').catch(() => {}); }, 4000);
}

let rerenderTimer = null;
function onLibraryEvent(kind) {
  if (kind === 'status') { updateSync(); return; }
  if (kind === 'data' && ['home', 'volume', 'page'].includes(view.kind) && !document.querySelector('.modal-root')) {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => route({ quiet: true }), 120);
  }
  updateSync();
}

function globalKeys(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
    if (!lib || document.querySelector('.modal-root')) return;
    e.preventDefault(); openSearch();
  }
  if (view.kind === 'page' && !typing && !document.querySelector('.modal-root')) {
    if (e.key === 'ArrowLeft') document.querySelector('[data-nav="prev"]')?.click();
    if (e.key === 'ArrowRight') document.querySelector('[data-nav="next"]')?.click();
  }
}

// ---------- routing ----------
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(qs || '') };
}

async function route(opts = {}) {
  const { parts, params } = parseHash();
  if (!DEMO && !S.token && parts[0] !== 'settings') return show('setup', viewSetup);
  if (!lib) return show('setup', viewSetup);
  const [a, b, c, d] = parts;
  if (!a) return show('home', viewHome, opts);
  if (a === 'settings') return show('settings', viewSettings);
  if (a === 'search') { await show('home', viewHome, opts); openSearch(params.get('q') || ''); return; }
  if (a === 'v' && b && !c) return show('volume', () => viewVolume(b), opts);
  if (a === 'v' && b && c === 'new') return show('editor', () => viewEditor(b, null, params));
  if (a === 'v' && b && /^\d+$/.test(c) && d === 'edit') return show('editor', () => viewEditor(b, parseInt(c, 10), params));
  if (a === 'v' && b && /^\d+$/.test(c)) return show('page', () => viewPage(b, parseInt(c, 10), params), opts);
  return show('missing', () => viewMissing('That address doesn’t match anything in the notebook.'));
}

async function show(kind, render, { quiet = false } = {}) {
  const token = ++view.token;
  const scroll = window.scrollY;
  const oldUrls = view.urls;
  const prevKind = view.kind;
  view = { kind, token, urls: [] };
  if (!quiet) closeModals();
  let el;
  try { el = await render(); } catch (e) { console.error(e); el = viewMissing(`Something went wrong showing this: ${e.message}`); }
  if (token !== view.token) return;
  if (el) app.replaceChildren(el);
  setTimeout(() => oldUrls.forEach((u) => URL.revokeObjectURL(u)), 1000);
  if (quiet) window.scrollTo(0, scroll);
  else if (prevKind !== kind || kind !== 'page') window.scrollTo(0, 0);
  updateSync();
}

// ---------- chrome ----------
function topbar({ back, backLabel = 'Back', title, sub, actions = [] }) {
  return h('header', { class: 'topbar' },
    h('div', { class: 'tb-left' },
      back ? h('a', { class: 'btn icon ghost', href: back, 'aria-label': backLabel, title: backLabel }, icon('back')) : null,
      h('div', { class: 'tb-title' },
        h('span', { class: 'tb-main' }, title),
        sub ? h('span', { class: 'tb-sub' }, sub) : null)),
    h('div', { class: 'tb-right' }, syncChip(), ...actions));
}

function demoBanner() {
  if (!DEMO) return null;
  return h('div', { class: 'banner' }, 'This is the sample notebook. Nothing you change here is saved. ',
    h('a', { href: location.pathname }, 'Go to your notebook'));
}

function syncChip() {
  return h('button', { class: 'sync-chip', type: 'button', onclick: openSyncTray, 'aria-live': 'polite' }, h('span', { class: 'dot' }), h('span', { class: 'sync-text' }));
}
const SYNC_TEXT = {
  idle: 'Opening', syncing: 'Syncing', synced: 'Synced', offline: 'Offline', error: 'Sync problem', empty: 'Empty repository',
};
function updateSync() {
  if (!lib) return;
  const s = lib.status;
  for (const chip of document.querySelectorAll('.sync-chip')) {
    chip.dataset.state = s.state;
    let text = SYNC_TEXT[s.state] || s.state;
    if (s.state === 'pending') text = `${s.count} waiting to sync`;
    if (s.state === 'attention') text = 'Needs your attention';
    if (s.state === 'offline' && lib.outbox.length) text = `Offline, ${lib.outbox.length} waiting`;
    chip.querySelector('.sync-text').textContent = text;
    chip.title = s.state === 'error' ? s.message || '' : '';
  }
}

function openSyncTray() {
  const s = lib.status;
  const body = h('div', { class: 'tray' });
  const lines = {
    synced: `Everything is saved to GitHub. Last checked ${fmtTime(new Date(s.at).toISOString())}.`,
    syncing: 'Checking GitHub for changes.',
    offline: 'GitHub can’t be reached right now. Pages you save are kept on this device and sync when you’re back online.',
    error: s.code === 401
      ? 'GitHub rejected this device’s token. It may have expired or been revoked. Add a new token in Settings.'
      : `The last sync failed: ${s.message || 'unknown error'}.`,
    empty: 'The notebook repository has no files yet.',
    pending: 'Some pages are saved on this device and haven’t reached GitHub yet.',
    attention: 'Some saved pages couldn’t be synced. Choose what to do with each one below.',
  };
  body.append(h('p', null, lines[s.state] || ''));
  if (DEMO) body.append(h('p', { class: 'muted' }, 'The sample notebook lives only in this browser tab.'));
  for (const o of lib.outbox) {
    const title = o.fm?.title || 'Untitled';
    const where = `${lib.volume(o.vol)?.title || o.vol}, p. ${o.num}`;
    const row = h('div', { class: 'tray-item' },
      h('div', null, h('strong', null, title), h('div', { class: 'muted' }, where)));
    if (o.status === 'conflict' || o.status === 'error') {
      row.append(h('p', { class: 'warn' }, o.status === 'conflict' ? 'This page was changed on another device too.' : `Couldn’t sync: ${o.error}`),
        h('div', { class: 'row-actions' },
          o.status === 'conflict' ? h('button', { class: 'btn', onclick: () => resolveItem(o.id, 'overwrite') }, 'Keep this version') : h('button', { class: 'btn', onclick: () => resolveItem(o.id, 'retry') }, 'Try again'),
          h('button', { class: 'btn', onclick: () => resolveItem(o.id, 'new') }, 'Save as a new page'),
          h('button', { class: 'btn danger', onclick: () => resolveItem(o.id, 'discard') }, 'Discard')));
    } else row.append(h('span', { class: 'muted' }, 'Waiting to sync'));
    body.append(row);
  }
  modal({
    title: 'Sync', body,
    buttons: [
      { label: 'Close' },
      { label: 'Sync now', primary: true, run: async () => { await lib.refresh(); await lib.flush(); toast(lib.status.state === 'synced' ? 'Up to date.' : 'Sync finished with problems.'); } },
    ],
  });
}
async function resolveItem(id, how) {
  closeModals();
  await lib.resolve(id, how);
  toast(lib.status.state === 'synced' ? 'Synced.' : 'Done.');
}

let toastTimer;
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.replaceChildren(h('span', null, msg));
  if (action) el.append(h('button', { class: 'btn small', onclick: () => { el.classList.remove('show'); action.run(); } }, action.label));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 8000 : 4000);
}

function closeModals() { document.querySelectorAll('.modal-root').forEach((m) => m.close?.()); }

// buttons: [{label, primary, danger, run(): may return false to keep open}]
function modal({ title, body, buttons = [{ label: 'Close' }], wide = false, onClose }) {
  const prevFocus = document.activeElement;
  const root = h('div', { class: 'modal-root' });
  const panel = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    prevFocus?.focus?.();
  };
  root.close = close;
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  const foot = h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', {
    class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, type: 'button',
    onclick: async (ev) => {
      if (!b.run) return close();
      const btn = ev.currentTarget;
      btn.disabled = true;
      try { const keep = await b.run(); if (keep !== false) close(); } catch (e) { toast(e.message); } finally { btn.disabled = false; }
    },
  }, b.label)));
  panel.append(h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn icon ghost', 'aria-label': 'Close', onclick: close }, icon('close'))), h('div', { class: 'modal-body' }, body), buttons.length ? foot : null);
  root.append(panel);
  document.body.append(root);
  setTimeout(() => (panel.querySelector('[autofocus]') || panel.querySelector('input,textarea,select') || panel.querySelector('.modal-foot .btn.primary') || panel).focus?.(), 30);
  return root;
}

function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => h('button', {
    class: 'menu-item', role: 'menuitem', type: 'button',
    onclick: () => { m.remove(); it.run(); },
  }, icon(it.icon, 18), it.label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 6}px`;
  m.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  m.querySelector('button')?.focus();
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { m.remove(); anchor.focus(); } });
}

function field(label, value, cls = '') {
  return h('div', { class: `field ${cls}` }, h('span', { class: 'lbl' }, label), h('span', { class: 'val' }, value ?? ''));
}
function signerName() { return lib?.notebook?.owner || 'Signed'; }

// ---------- setup ----------
function tokenUrl(owner = S.owner) {
  const p = new URLSearchParams({
    name: 'Lab notebook (this device)',
    description: 'Lets the lab notebook app on one device read and write the notebook repository.',
    expires_in: '366',
    contents: 'write',
  });
  if (owner) p.set('target_name', owner);
  return `https://github.com/settings/personal-access-tokens/new?${p}`;
}

// On <name>.github.io the GitHub account is known, so suggest it.
function guessOwner() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  return m ? m[1] : '';
}

// Entries belong in a private repository; ask before using a public one.
async function confirmPrivate(acc, fullName) {
  if (acc.private) return true;
  const c = await choose('This repository is public', `Anyone on the internet can read what is stored in ${fullName}. Make it private on GitHub (Settings, then Danger Zone, then Change visibility) before writing in it.`, [['cancel', 'Go back'], ['ok', 'Use it anyway']]);
  return c === 'ok';
}

function viewSetup() {
  const start = S.owner && S.repo ? `${S.owner}/${S.repo}` : guessOwner() ? `${guessOwner()}/` : '';
  const repoIn = h('input', { value: start, placeholder: 'your-github-name/lab-notebook-entries', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', id: 'f-repo' });
  const tokenLink = h('a', { href: tokenUrl(guessOwner()), target: '_blank', rel: 'noopener' }, 'Create a token on GitHub');
  const repoName = h('code', null, start.split('/')[1] || 'your entries repository');
  repoIn.addEventListener('input', () => {
    const [o, r] = repoIn.value.trim().split('/');
    tokenLink.href = tokenUrl(o);
    repoName.textContent = r || 'your entries repository';
  });
  const branchIn = h('input', { value: S.branch, autocomplete: 'off', spellcheck: 'false', id: 'f-branch' });
  const tokenIn = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', id: 'f-token', placeholder: 'github_pat_…' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Connect notebook');
  const form = h('form', {
    class: 'setup-form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const [owner, repo] = repoIn.value.trim().split('/');
      const token = tokenIn.value.trim();
      if (!owner || !repo) { err.textContent = 'Enter the repository as owner/name.'; return; }
      if (!token) { err.textContent = 'Paste the token you created on GitHub.'; return; }
      go.disabled = true; go.textContent = 'Checking…';
      try {
        const be = new GitHubBackend({ owner, repo, branch: branchIn.value.trim() || 'main', token, apiBase: S.apiBase });
        const acc = await be.checkAccess();
        if (!acc.canWrite) throw new Error('This token can read the repository but not change it. On GitHub, set Contents to “Read and write”.');
        if (!(await confirmPrivate(acc, `${owner}/${repo}`))) return;
        Object.assign(S, { owner, repo, branch: branchIn.value.trim() || 'main', token });
        saveSettings();
        await startLibrary();
        location.hash = '#/';
        route();
      } catch (e2) {
        err.textContent = e2 instanceof ApiError && e2.status === 401 ? 'GitHub rejected this token. Check that it was copied completely and hasn’t expired.'
          : e2 instanceof ApiError && e2.status === 404 ? `This token can’t see ${owner}/${repo}. When creating it, choose “Only select repositories” and pick that repository.`
            : e2 instanceof NetworkError ? 'GitHub can’t be reached. Check your connection and try again.' : e2.message;
      } finally { go.disabled = false; go.textContent = 'Connect notebook'; }
    },
  },
  h('label', { for: 'f-repo' }, 'Private repository for your entries'), repoIn,
  h('label', { for: 'f-branch' }, 'Branch'), branchIn,
  h('label', { for: 'f-token' }, 'GitHub token'), tokenIn,
  err, go);

  return h('div', { class: 'view setup' },
    h('header', { class: 'topbar' }, h('div', { class: 'tb-left' }, h('div', { class: 'tb-title' }, h('span', { class: 'tb-main' }, 'Lab notebook')))),
    h('article', { class: 'sheet plain narrow' },
      h('h1', null, 'Connect this device'),
      h('p', null, 'Your entries live in a private GitHub repository. Each phone, tablet or computer you use needs its own token that can read and write that one repository. The token stays on this device.'),
      h('ol', { class: 'steps' },
        h('li', null, 'Create an empty ', h('strong', null, 'private'), ' repository on GitHub for your entries, if you haven’t already.'),
        h('li', null, tokenLink, '. Under Repository access, choose ', h('em', null, 'Only select repositories'), ' and pick ', repoName, '. Contents is already set to Read and write.'),
        h('li', null, 'Copy the token, paste it below, and connect.')),
      form,
      h('p', { class: 'muted' }, 'Want to see how it works first? ', h('a', { href: '?demo#/v/sample/1' }, 'Look around the sample notebook'), '.')));
}

// ---------- home ----------
function viewHome() {
  const vols = lib.volumes();
  const actions = [
    h('button', { class: 'btn icon ghost', 'aria-label': 'Search', title: 'Search ( / )', onclick: () => openSearch() }, icon('search')),
    h('a', { class: 'btn icon ghost', href: '#/settings', 'aria-label': 'Settings', title: 'Settings' }, icon('gear')),
  ];
  const root = h('div', { class: 'view home' }, topbar({ title: lib.notebook.title || 'Laboratory notebooks', sub: lib.notebook.owner || null, actions }), demoBanner());

  if (lib.empty) {
    root.append(h('article', { class: 'sheet plain narrow' },
      h('h1', null, 'Start your notebook'),
      h('p', null, `The repository ${S.owner}/${S.repo} has no files yet. Starting it adds a small settings file; your volumes and pages are added as you write.`),
      h('div', { class: 'form' },
        h('label', { for: 'st-name' }, 'Your name, as you sign pages'),
        h('input', { id: 'st-name', placeholder: 'e.g. A. Researcher', autocomplete: 'name' }),
        h('button', { class: 'btn primary', onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          try { await lib.initialize(document.getElementById('st-name').value.trim()); route(); } catch (err) { toast(err.message); btn.disabled = false; }
        } }, 'Start the notebook'))));
    return root;
  }
  if (!lib.head && lib.status.state !== 'synced') {
    root.append(h('p', { class: 'loading' }, lib.status.state === 'offline' ? 'GitHub can’t be reached and nothing is stored on this device yet.' : 'Opening your notebook…'));
    if (lib.status.state === 'error') root.append(h('p', { class: 'loading' }, lib.status.message || ''));
    return root;
  }

  const shelf = h('section', { class: 'shelf', 'aria-label': 'Volumes' });
  for (const v of vols) shelf.append(cover(v));
  shelf.append(h('button', { class: 'cover new-cover', type: 'button', onclick: openNewVolume },
    icon('plus', 28), h('span', null, vols.length ? 'Start a new volume' : 'Start your first volume')));
  root.append(shelf);
  if (!vols.length) root.append(h('p', { class: 'hint' }, 'Give each project its own volume. Pages are numbered within a volume, like a bound notebook.'));

  const recent = lib.allPages().sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.num - a.num).slice(0, 8);
  if (recent.length) {
    root.append(h('section', { class: 'sheet ledger recent' },
      h('h2', null, 'Recent entries'),
      h('ol', { class: 'ledger-rows' }, recent.map((p) => h('li', null, h('a', { href: `#/v/${p.vol}/${p.num}` },
        h('span', { class: 'l-date' }, fmtDate(p.date)),
        h('span', { class: 'l-title' }, p.title, p.pending ? h('span', { class: 'pending-tag' }, 'waiting to sync') : null),
        h('span', { class: 'l-where' }, `${lib.volume(p.vol)?.title || p.vol}, p. ${p.num}`)))))));
  }
  return root;
}

function cover(v) {
  const pages = lib.pages(v.id);
  return h('a', { class: 'cover', href: `#/v/${v.id}`, style: { '--cloth': v.color || CLOTHS[0][1] } },
    h('span', { class: 'cover-label' },
      h('span', { class: 'cl-kind' }, 'Laboratory notebook'),
      h('span', { class: 'cl-no' }, `No. ${v.number}`),
      h('span', { class: 'cl-title' }, v.title),
      h('span', { class: 'cl-meta' }, `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, h('br'), `Begun ${fmtDate(v.created)}`)));
}

function openNewVolume() {
  const title = h('input', { id: 'nv-title', placeholder: 'e.g. Thyroid cytology classifier', autofocus: true });
  const desc = h('input', { id: 'nv-desc', placeholder: 'Optional' });
  const used = new Set(lib.volumes().map((v) => v.color));
  const pick = CLOTHS.find(([, c]) => !used.has(c))?.[1] || CLOTHS[0][1];
  const swatches = clothPicker(pick);
  modal({
    title: 'New volume',
    body: h('div', { class: 'form' },
      h('label', { for: 'nv-title' }, 'Project'), title,
      h('label', { for: 'nv-desc' }, 'Description'), desc,
      h('span', { class: 'label' }, 'Cover'), swatches.el),
    buttons: [{ label: 'Cancel' }, {
      label: 'Create volume', primary: true,
      run: async () => {
        if (!title.value.trim()) { title.focus(); toast('Give the volume a project name.'); return false; }
        try {
          const id = await lib.createVolume({ title: title.value.trim(), description: desc.value.trim(), color: swatches.value() });
          location.hash = `#/v/${id}`;
        } catch (e) {
          if (e instanceof NetworkError) throw new Error('You’re offline. New volumes can be created once you’re connected.');
          throw e;
        }
      },
    }],
  });
}

function clothPicker(current) {
  let value = current;
  const el = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Cover colour' });
  for (const [name, c] of CLOTHS) {
    const b = h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(c === value), 'aria-label': name, title: name, style: { '--cloth': c } });
    b.onclick = () => { value = c; el.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === b))); };
    el.append(b);
  }
  return { el, value: () => value };
}

// ---------- volume contents ----------
function viewVolume(id) {
  const v = lib.volume(id);
  if (!v) return viewMissing('This volume isn’t in the notebook. It may have been renamed or removed.');
  const pages = lib.pages(id);
  const more = h('button', { class: 'btn icon ghost', 'aria-label': 'More', onclick: (e) => menu(e.currentTarget, [
    { icon: 'edit', label: 'Volume details', run: () => openVolumeDetails(v) },
    pages.length ? { icon: 'print', label: 'Print or save volume as PDF', run: () => printVolume(id) } : null,
    { icon: 'search', label: 'Search this volume', run: () => openSearch('', id) },
  ]) }, icon('more'));
  const root = h('div', { class: 'view volume' },
    topbar({ back: '#/', backLabel: 'All volumes', title: v.title, sub: `Volume ${v.number}`, actions: [
      h('a', { class: 'btn primary', href: `#/v/${id}/new` }, icon('plus', 18), h('span', null, 'New page')), more] }),
    demoBanner());
  const sheet = h('article', { class: 'sheet toc' },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'form-row' }, field('Project', v.title, 'grow'), field('Book no.', v.number)),
      h('div', { class: 'form-row' }, field('Begun', fmtDate(v.created), 'grow'), field('Pages', pages.length))),
    v.description ? h('p', { class: 'vol-desc' }, v.description) : null,
    h('h1', { class: 'toc-title' }, 'Contents'));
  if (!pages.length) {
    sheet.append(h('div', { class: 'empty' }, h('p', null, 'No pages yet.'), h('a', { class: 'btn', href: `#/v/${id}/new` }, icon('write', 18), 'Write page 1')));
  } else {
    sheet.append(h('table', { class: 'toc-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'c-no' }, 'Page'), h('th', { scope: 'col', class: 'c-date' }, 'Date'), h('th', { scope: 'col' }, 'Title'), h('th', { scope: 'col', class: 'c-sig' }, 'Signed'))),
      h('tbody', null, pages.map((p) => h('tr', { onclick: (e) => { if (!e.target.closest('a')) location.hash = `#/v/${id}/${p.num}`; } },
        h('td', { class: 'c-no' }, p.num),
        h('td', { class: 'c-date' }, fmtDate(p.date)),
        h('td', null, h('a', { href: `#/v/${id}/${p.num}` }, p.title),
          p.pending ? h('span', { class: 'pending-tag' }, 'waiting to sync') : null,
          p.tags.length ? h('span', { class: 'toc-tags' }, p.tags.map((t) => `#${t}`).join(' ')) : null),
        h('td', { class: 'c-sig' }, p.signed ? h('span', { class: 'initials', title: `Signed ${fmtDate(p.signed)}` }, initials(p.signer || signerName())) : h('span', { class: 'sr' }, 'Not signed')))))));
  }
  root.append(sheet);
  return root;
}
function initials(name) {
  return String(name).replace(/,.*$/, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3);
}

function openVolumeDetails(v) {
  const title = h('input', { id: 'vd-title', value: v.title });
  const desc = h('input', { id: 'vd-desc', value: v.description || '' });
  const sw = clothPicker(v.color || CLOTHS[0][1]);
  modal({
    title: 'Volume details',
    body: h('div', { class: 'form' },
      h('label', { for: 'vd-title' }, 'Project'), title,
      h('label', { for: 'vd-desc' }, 'Description'), desc,
      h('span', { class: 'label' }, 'Cover'), sw.el,
      h('p', { class: 'muted' }, `Volume ${v.number}. Its folder in the repository is volumes/${v.id}.`)),
    buttons: [{ label: 'Cancel' }, {
      label: 'Save details', primary: true,
      run: async () => {
        if (!title.value.trim()) { toast('The project name can’t be empty.'); return false; }
        await lib.updateNotebook((nb) => {
          const x = nb.volumes.find((y) => y.id === v.id);
          Object.assign(x, { title: title.value.trim(), description: desc.value.trim(), color: sw.value() });
        }, `Update volume: ${title.value.trim()}`);
        toast('Volume details saved.');
      },
    }],
  });
}

// ---------- page ----------
function pageCtx(vol, num, local) {
  return {
    lib, vol, num, urls: view.urls,
    resolveBlob: async (name) => {
      name = decodeURIComponent(name);
      if (local?.has(name)) return local.get(name);
      if (name.startsWith('/')) return lib.readBlob(name.slice(1));
      return lib.readAttachment(vol, num, name);
    },
  };
}

function refLink(key, curVol) {
  const r = parseRef(key);
  if (!r) return null;
  const p = lib.page(r.vol, r.num);
  const label = r.vol === curVol ? `p. ${r.num}` : `${lib.volume(r.vol)?.title || r.vol}, p. ${r.num}`;
  return h('a', { class: 'pageref', href: `#/v/${r.vol}/${r.num}`, title: p?.title || '' }, label);
}

// Builds the page sheet; `ready` resolves when figures and charts are drawn.
async function buildPageSheet(vol, num, { forPrint = false } = {}) {
  const v = lib.volume(vol);
  const entry = lib.page(vol, num);
  const md = await lib.readPage(vol, num);
  const { fm, body } = parseFrontMatter(md);
  const content = h('div', { class: 'sheet-body prose' });
  const ready = renderInto(content, body, pageCtx(vol, num));
  const cont = entry?.continues ? parseRef(entry.continues) : null;
  const next = lib.continuedOn(vol, num);
  const backs = lib.backlinks(vol, num);
  const tags = entry?.tags || [];
  const sig = fm.signed
    ? h('span', { class: 'sig' }, fm.signer || signerName())
    : h('span', { class: 'unsigned' }, 'Not signed');
  const sheet = h('article', { class: 'sheet page', 'data-vol': vol, 'data-num': num },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'form-row' },
        field('Project', v?.title || vol, 'grow'),
        field('Book no.', v?.number ?? ''),
        h('div', { class: 'stamp', 'aria-label': `Page ${num}` }, h('span', { class: 'stamp-no' }, 'No'), pad(num))),
      h('div', { class: 'form-row' },
        field('Title', h('span', { class: 'title' }, fm.title || 'Untitled'), 'grow'),
        field('Date', fmtDate(fm.date)))),
    cont ? h('p', { class: 'cont from' }, 'Continued from ', refLink(entry.continues, vol)) : null,
    content,
    next ? h('p', { class: 'cont to' }, 'Continued on ', refLink(`${next.vol}/${next.num}`, vol)) : null,
    h('footer', { class: 'sheet-foot' },
      tags.length ? h('div', { class: 'form-row' }, field('Index terms', h('span', { class: 'tags' }, tags.map((t) => h('a', { href: `#/search?q=${encodeURIComponent(`#${t}`)}` }, `#${t}`))), 'grow')) : null,
      backs.length ? h('div', { class: 'form-row' }, field('Referred to on', h('span', { class: 'backs' }, backs.map((p) => refLink(`${p.vol}/${p.num}`, vol))), 'grow')) : null,
      h('div', { class: 'form-row sig-row' }, field('Signed', sig, 'grow'), field('Date', fm.signed ? fmtDate(fm.signed) : '')),
      h('div', { class: 'form-row sig-row print-only' }, field('Witnessed and understood by', '', 'grow'), field('Date', '')),
      (fm.amended || []).length ? h('p', { class: 'amended' }, `Amended ${fm.amended.map(fmtDate).join(', ')}`) : null,
      entry?.pending ? h('p', { class: 'pending-note no-print' }, 'Saved on this device. It will be committed to GitHub when you’re back online.') : null));
  if (forPrint) sheet.classList.add('for-print');
  return { el: sheet, ready, fm, body };
}

async function viewPage(vol, num, params) {
  const v = lib.volume(vol);
  if (!v) return viewMissing('This volume isn’t in the notebook.');
  if (!lib.page(vol, num)) {
    return viewMissing(`Page ${num} of ${v.title} hasn’t been written yet.`, h('a', { class: 'btn primary', href: `#/v/${vol}/new` }, 'Write a new page'));
  }
  const { el: sheet, fm } = await buildPageSheet(vol, num);
  const pages = lib.pages(vol);
  const idx = pages.findIndex((p) => p.num === num);
  const prev = pages[idx - 1]; const next = pages[idx + 1];
  const more = h('button', { class: 'btn icon ghost', 'aria-label': 'More', onclick: (e) => menu(e.currentTarget, [
    { icon: 'continue', label: 'Continue on a new page', run: () => { location.hash = `#/v/${vol}/new?continues=${num}`; } },
    { icon: 'copy', label: 'Copy page link for another page', run: () => copyRef(vol, num) },
    { icon: 'print', label: 'Print or save as PDF', run: () => window.print() },
    { icon: 'history', label: 'Version history', run: () => openHistory(vol, num) },
  ]) }, icon('more'));
  const edit = h('a', { class: 'btn', href: `#/v/${vol}/${num}/edit` }, icon('edit', 18), h('span', { class: 'wide-only' }, fm.signed ? 'Amend' : 'Edit'));
  const pager = h('nav', { class: 'pager', 'aria-label': 'Pages' },
    prev ? h('a', { class: 'btn ghost', href: `#/v/${vol}/${prev.num}`, 'data-nav': 'prev', rel: 'prev' }, icon('back', 18), `p. ${prev.num}`) : h('span'),
    h('a', { class: 'btn ghost', href: `#/v/${vol}` }, 'Contents'),
    next ? h('a', { class: 'btn ghost', href: `#/v/${vol}/${next.num}`, 'data-nav': 'next', rel: 'next' }, `p. ${next.num}`, icon('next', 18))
      : h('a', { class: 'btn ghost', href: `#/v/${vol}/new` }, icon('plus', 18), 'New page'));
  const dir = lastPageVisited && lastPageVisited.vol === vol ? Math.sign(num - lastPageVisited.num) : 0;
  if (dir) sheet.classList.add(dir > 0 ? 'turn-next' : 'turn-prev');
  lastPageVisited = { vol, num };
  addSwipe(sheet, prev && `#/v/${vol}/${prev.num}`, next && `#/v/${vol}/${next.num}`);
  return h('div', { class: 'view page-view' },
    topbar({ back: `#/v/${vol}`, backLabel: 'Contents', title: v.title, sub: `Page ${num}`, actions: [edit, more] }),
    demoBanner(), sheet, pager);
}
let lastPageVisited = null;

function addSwipe(el, prevHref, nextHref) {
  let x0 = null; let y0 = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.printout, table, pre, .katex-display, input, textarea')) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 80 && Math.abs(dy) < 50) {
      if (dx < 0 && nextHref) location.hash = nextHref;
      if (dx > 0 && prevHref) location.hash = prevHref;
    }
  });
}

async function copyRef(vol, num) {
  const ref = `[[${vol}/${num}]]`;
  try { await navigator.clipboard.writeText(ref); toast(`Copied ${ref}. Paste it into any page.`); } catch { toast(`Link text: ${ref}`); }
}

async function openHistory(vol, num) {
  const list = h('div', { class: 'history' }, h('p', { class: 'muted' }, 'Loading…'));
  modal({ title: `Versions of p. ${num}`, body: list, buttons: [{ label: 'Close' }] });
  try {
    const items = await lib.history(pagePath(vol, num));
    list.replaceChildren(items.length ? h('ol', { class: 'ledger-rows' }, items.map((c) => h('li', null,
      h(c.url ? 'a' : 'span', c.url ? { href: c.url, target: '_blank', rel: 'noopener' } : null,
        h('span', { class: 'l-date' }, `${fmtDate(c.date)} ${fmtTime(c.date)}`),
        h('span', { class: 'l-title' }, c.message.split('\n')[0]),
        h('span', { class: 'l-where' }, c.sha.slice(0, 7)))))) : h('p', null, 'No saved versions yet.'),
    h('p', { class: 'muted' }, 'GitHub keeps every version. Open one to see exactly what changed.'));
  } catch (e) {
    list.replaceChildren(h('p', null, e instanceof NetworkError ? 'Version history needs a connection to GitHub.' : e.message));
  }
}

function viewMissing(msg, action) {
  return h('div', { class: 'view missing' },
    topbar({ back: '#/', backLabel: 'All volumes', title: 'Not found' }),
    h('article', { class: 'sheet plain narrow' }, h('p', null, msg), action || h('a', { class: 'btn', href: '#/' }, 'Go to all volumes')));
}

// ---------- editor ----------
async function prepareFile(file) {
  if (S.downscale && /^image\/(jpeg|webp|heic|heif)$/.test(file.type) && file.size > 1.5e6) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { /* keep original */ }
  }
  return file;
}

async function viewEditor(vol, num, params) {
  const v = lib.volume(vol);
  if (!v) return viewMissing('This volume isn’t in the notebook.');
  const isNew = num == null;
  const pending = isNew ? null : lib.pendingFor(vol, num);
  const dkey = `${lib.key}:draft:${vol}/${isNew ? 'new' : num}`;
  let fm; let body; let baseSha = null;
  const local = new Map();
  const removed = new Set();
  let existing = [];
  if (!isNew) {
    if (!lib.page(vol, num)) return viewMissing(`Page ${num} doesn’t exist yet.`);
    ({ fm, body } = parseFrontMatter(await lib.readPage(vol, num)));
    baseSha = pending ? (pending.baseSha ?? null) : (lib.tree.get(pagePath(vol, num)) || null);
    existing = lib.attachments(vol, num);
    for (const a of pending?.attachments || []) local.set(a.name, new Blob([a.buf], { type: a.type }));
  } else {
    fm = { title: '', date: todayISO(), tags: [] };
    const c = params.get('continues');
    if (c) fm.continues = c;
  }
  const origSigned = !!fm.signed;
  let notice = null;
  const draft = await kv.get(dkey).catch(() => null);
  if (draft) {
    fm = draft.fm; body = draft.body;
    if (!isNew) {
      if ((draft.baseSha ?? null) !== baseSha) notice = 'This page was changed after your unsaved draft was written. When you save, you’ll be asked which version to keep.';
      baseSha = draft.baseSha ?? null;
    }
    for (const name of draft.attachments || []) {
      const a = await kv.get(`${dkey}:att:${name}`).catch(() => null);
      if (a) local.set(name, new Blob([a.buf], { type: a.type }));
    }
    for (const n of draft.removed || []) removed.add(n);
    toast(`Restored your unsaved draft from ${fmtTime(new Date(draft.updated).toISOString())}.`, { label: 'Discard draft', run: async () => { await clearDraft(); route(); } });
  }

  // ----- fields -----
  const titleIn = h('input', { class: 'val title-input', value: fm.title || '', placeholder: 'What is this page about?', 'aria-label': 'Title' });
  const dateIn = h('input', { type: 'date', class: 'val', value: String(fm.date || todayISO()).slice(0, 10), 'aria-label': 'Date' });
  const tagsIn = h('input', { class: 'val', value: (fm.tags || []).join(', '), placeholder: 'Comma separated, e.g. ablation, tile-size', 'aria-label': 'Index terms' });
  const ta = h('textarea', { class: 'editor-text', spellcheck: 'true', 'aria-label': 'Page text', placeholder: 'Write here. Markdown, $math$, [[page links]] and attachments all work.' });
  ta.value = body || '';
  const preview = h('div', { class: 'prose preview', 'aria-label': 'Preview' });
  const status = h('span', { class: 'ed-status', 'aria-live': 'polite' }, draft ? 'Draft restored' : '');
  const strip = h('div', { class: 'att-strip' });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,.csv,.tsv,.json,.ipynb,.pdf,.txt,.xlsx,.zip' });

  let contLine = null;
  const renderCont = () => {
    const c = fm.continues ? parseRef(fm.continues, vol) : null;
    const nl = c ? h('p', { class: 'cont from' }, 'Continued from ', refLink(`${c.vol}/${c.num}`, vol), ' ',
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { delete fm.continues; renderCont(); changed(); } }, 'Remove')) : h('span', { hidden: true });
    if (contLine) contLine.replaceWith(nl);
    contLine = nl;
  };
  renderCont();

  const collect = () => ({
    fm: {
      ...fm,
      title: titleIn.value.trim(),
      date: dateIn.value || todayISO(),
      tags: [...new Set(tagsIn.value.split(/[,\n]/).map(cleanTag).filter(Boolean))],
    },
    body: ta.value,
  });

  const saveDraft = debounce(async () => {
    const c = collect();
    await kv.set(dkey, { fm: c.fm, body: c.body, baseSha, attachments: [...local.keys()], removed: [...removed], updated: Date.now() }).catch(() => {});
    status.textContent = `Draft kept on this device, ${fmtTime(nowISO())}`;
  }, 700);
  async function clearDraft() {
    saveDraft.cancel();
    for (const k of await kv.keys(`${dkey}:`)) await kv.del(k);
    await kv.del(dkey);
  }

  const previewUrls = [];
  const renderPreview = debounce(async () => {
    if (!wide() && split.dataset.tab !== 'preview') return;
    const old = previewUrls.splice(0);
    const ctx = pageCtx(vol, num ?? lib.nextNumber(vol), local);
    ctx.urls = previewUrls;
    const y = preview.scrollTop;
    await renderInto(preview, ta.value, ctx);
    preview.scrollTop = y;
    old.forEach((u) => URL.revokeObjectURL(u));
  }, 350);

  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.max(ta.scrollHeight + 4, 360)}px`; };
  const changed = () => { status.textContent = 'Editing'; saveDraft(); renderPreview(); };
  for (const el of [titleIn, dateIn, tagsIn]) el.addEventListener('input', changed);
  ta.addEventListener('input', () => { autosize(); changed(); });

  // ----- text helpers -----
  const fire = () => ta.dispatchEvent(new Event('input'));
  function wrap(before, after = before, placeholder = 'text') {
    const s = ta.selectionStart; const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.focus();
    ta.setRangeText(before + (sel || placeholder) + after, s, e, 'end');
    if (!sel) { ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + placeholder.length; }
    fire();
  }
  function prefixLines(prefix) {
    const s = ta.selectionStart; const e = ta.selectionEnd;
    const start = ta.value.lastIndexOf('\n', s - 1) + 1;
    const chunk = ta.value.slice(start, e);
    ta.focus();
    ta.setRangeText(chunk.split('\n').map((l) => prefix + l).join('\n'), start, e, 'end');
    fire();
  }
  function insertBlock(text, selectFrom, selectLen) {
    const s = ta.selectionStart;
    const before = ta.value.slice(0, s);
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    ta.focus();
    ta.setRangeText(`${lead}${text}\n`, s, ta.selectionEnd, 'end');
    if (selectFrom != null) { ta.selectionStart = s + lead.length + selectFrom; ta.selectionEnd = ta.selectionStart + selectLen; }
    fire();
  }
  function insertInline(text) { ta.focus(); ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); fire(); }

  // ----- attachments -----
  const allNames = () => new Set([...existing.filter((n) => !removed.has(n)), ...local.keys()]);
  function uniqueName(name) {
    const taken = allNames();
    if (!taken.has(name)) return name;
    const m = name.match(/^(.*?)(\.[^.]*)?$/);
    let i = 2;
    while (taken.has(`${m[1]}-${i}${m[2] || ''}`)) i++;
    return `${m[1]}-${i}${m[2] || ''}`;
  }
  async function attach(files) {
    for (const f0 of files) {
      const f = await prepareFile(f0);
      let base = f.name && !/^image\.\w+$/.test(f.name) ? f.name : `pasted-${Date.now().toString(36)}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      const name = uniqueName(safeFileName(base));
      local.set(name, f);
      removed.delete(name);
      await kv.set(`${dkey}:att:${name}`, { type: f.type || mimeOf(name), buf: await f.arrayBuffer() }).catch(() => {});
      const ext = name.split('.').pop().toLowerCase();
      if ((f.type || '').startsWith('image/')) {
        insertBlock(`![${name.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ')}](${name})`);
      } else if (['csv', 'tsv'].includes(ext)) {
        const first = (await f.slice(0, 4096).text()).split(/\r?\n/)[0] || '';
        const cols = first.split(ext === 'tsv' ? '\t' : ',').map((c) => c.trim().replace(/^"|"$/g, ''));
        const errCol = cols.slice(1).find((c) => /(^|[_\s-])(sd|se|sem|err|error|ci)$/i.test(c));
        const ys = cols.slice(1).filter((c) => c !== errCol).slice(0, errCol ? 1 : 2);
        insertBlock(`\`\`\`chart\ntype: line\ndata: ${name}\nx: ${cols[0] || ''}\ny: ${ys.join(', ')}\n${errCol ? `error: ${errCol}\n` : ''}title: \n\`\`\``);
      } else if (['ipynb', 'json'].includes(ext)) {
        insertBlock(`![[${name}]]`);
      } else insertInline(`[${name}](${name})`);
    }
    renderStrip();
    saveDraft(); renderPreview();
  }
  function renderStrip() {
    const names = [...new Set([...existing, ...local.keys()])].sort();
    strip.replaceChildren(...names.map((n) => {
      const isLocal = local.has(n) && !existing.includes(n);
      const gone = removed.has(n);
      const size = local.get(n)?.size;
      return h('span', { class: `att${gone ? ' gone' : ''}` },
        h('span', { class: 'att-name' }, n), size ? h('span', { class: 'att-size' }, fmtBytes(size)) : null,
        h('button', {
          class: 'btn icon small ghost', type: 'button', 'aria-label': gone ? `Keep ${n}` : `Remove ${n}`, title: gone ? 'Keep' : 'Remove',
          onclick: async () => {
            if (isLocal) { local.delete(n); await kv.del(`${dkey}:att:${n}`).catch(() => {}); } else if (gone) removed.delete(n); else removed.add(n);
            renderStrip(); saveDraft(); renderPreview();
          },
        }, icon(gone ? 'plus' : 'close', 16)));
    }));
    strip.hidden = !names.length;
  }
  fileIn.addEventListener('change', () => { attach([...fileIn.files]); fileIn.value = ''; });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); attach(files); }
  });
  ta.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); ta.classList.add('drop'); } });
  ta.addEventListener('dragleave', () => ta.classList.remove('drop'));
  ta.addEventListener('drop', (e) => {
    ta.classList.remove('drop');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); attach(files); }
  });

  // ----- toolbar -----
  const tb = (ic, label, run) => h('button', { class: 'tool', type: 'button', title: label, 'aria-label': label, onclick: run }, icon(ic, 18));
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    tb('heading', 'Heading', () => prefixLines('## ')),
    tb('bold', 'Bold', () => wrap('**')),
    tb('italic', 'Italic', () => wrap('*')),
    tb('list', 'List', () => prefixLines('- ')),
    tb('check', 'Checklist', () => prefixLines('- [ ] ')),
    tb('quote', 'Quote', () => prefixLines('> ')),
    h('span', { class: 'tool-sep' }),
    tb('math', 'Equation', () => {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) wrap('$', '$'); else insertBlock('$$\nE = mc^2\n$$', 3, 8);
    }),
    tb('code', 'Code', () => insertBlock('```python\n\n```', 10, 0)),
    tb('table', 'Table', () => insertBlock('| Column | Value |\n|---|---|\n|  |  |')),
    tb('chart', 'Chart', () => insertBlock('```chart\ntype: line\nx: dose\ny: response\ntitle: \n---\ndose,response\n0,0.1\n1,0.4\n2,0.7\n```')),
    tb('link', 'Link to a page', () => openPagePicker(vol, (ref) => insertInline(`[[${ref}]]`))),
    tb('attach', 'Attach files', () => fileIn.click()));

  ta.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
    if (e.key === 'Tab' && !e.shiftKey && !mod) {
      const line = ta.value.slice(ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1, ta.selectionStart);
      if (/^\s*([-*+]|\d+\.)\s/.test(line)) { e.preventDefault(); prefixLines('  '); }
    }
  });

  // ----- write / preview tabs (narrow screens) -----
  const wide = () => window.matchMedia('(min-width: 1100px)').matches;
  const writePane = h('div', { class: 'pane write-pane' }, toolbar, ta, strip);
  const previewPane = h('div', { class: 'pane preview-pane' }, h('div', { class: 'pane-label' }, 'Preview'), preview);
  const split = h('div', { class: 'ed-split', 'data-tab': 'write' }, writePane, previewPane);
  const tabWrite = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'true', onclick: () => setTab('write') }, icon('write', 18), 'Write');
  const tabPrev = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => setTab('preview') }, icon('eye', 18), 'Preview');
  function setTab(t) {
    split.dataset.tab = t;
    tabWrite.setAttribute('aria-selected', String(t === 'write'));
    tabPrev.setAttribute('aria-selected', String(t === 'preview'));
    if (t === 'preview') renderPreview.flush(); else { ta.focus(); autosize(); }
  }

  // ----- save -----
  let saving = false;
  const saveBtn = h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, origSigned ? 'Save amendment' : 'Save');
  const signBtn = origSigned ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => save(true) }, icon('pen', 18), 'Sign & save');
  async function save(sign, opts = {}) {
    if (saving) return;
    saving = true; saveBtn.disabled = true; if (signBtn) signBtn.disabled = true;
    status.textContent = 'Saving…';
    const c = collect();
    if (!c.fm.title) c.fm.title = 'Untitled';
    const now = nowISO();
    if (origSigned) c.fm.amended = [...(c.fm.amended || []), now];
    else if (sign) { c.fm.signed = now; c.fm.signer = signerName(); }
    const item = {
      id: pending?.id, vol, num: isNew ? null : num, isNew: isNew || !!pending?.isNew, baseSha,
      fm: c.fm, body: c.body,
      attachments: [...local].filter(([n]) => !removed.has(n)).map(([name, blob]) => ({ name, blob })),
      removed: [...removed].filter((n) => existing.includes(n)),
      ...opts,
    };
    try {
      const r = await lib.savePage(item);
      await clearDraft();
      leaving = true;
      toast(r.queued ? 'Saved on this device. It will sync to GitHub when you’re back online.' : sign ? 'Signed and saved.' : origSigned ? 'Amendment saved.' : 'Saved.');
      location.hash = `#/v/${vol}/${r.num}`;
    } catch (e) {
      if (e instanceof ConflictError) {
        saving = false;
        const choice = await choose('This page changed on another device', 'Someone (perhaps you, on another device) saved a different version of this page after you started editing.', [
          ['overwrite', 'Replace it with my version'], ['new', 'Save mine as a new page'], ['cancel', 'Keep editing'],
        ]);
        if (choice === 'overwrite') return await save(sign, { force: true });
        if (choice === 'new') return await save(sign, { isNew: true, asNew: true, num: null });
      } else {
        toast(e instanceof ApiError && e.status === 403 ? 'GitHub refused the change. Check that this device’s token has Contents set to Read and write.' : `Couldn’t save: ${e.message}`);
      }
      status.textContent = 'Not saved yet. Your draft is safe on this device.';
    } finally {
      saving = false; saveBtn.disabled = false; if (signBtn) signBtn.disabled = false;
    }
  }
  let leaving = false;
  const cancel = async () => {
    const c = collect();
    const dirty = draft || c.body !== (body || '') || c.fm.title !== (fm.title || '') || local.size || removed.size;
    if (dirty) {
      const choice = await choose('Leave this page?', 'Your draft is kept on this device, so you can come back and finish it.', [['keep', 'Keep draft and leave'], ['discard', 'Discard draft'], ['stay', 'Keep editing']]);
      if (choice === 'stay' || !choice) return;
      if (choice === 'discard') await clearDraft(); else saveDraft.flush();
    }
    leaving = true;
    location.hash = isNew ? `#/v/${vol}` : `#/v/${vol}/${num}`;
  };

  const stamp = h('div', { class: 'stamp', 'aria-label': isNew ? 'New page' : `Page ${num}` }, h('span', { class: 'stamp-no' }, 'No'), isNew ? pad(lib.nextNumber(vol)) : pad(num));
  const sheet = h('article', { class: 'sheet page editing' },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'form-row' }, field('Project', v.title, 'grow'), field('Book no.', v.number), stamp),
      h('div', { class: 'form-row' },
        h('label', { class: 'field grow' }, h('span', { class: 'lbl' }, 'Title'), titleIn),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Date'), dateIn)),
      h('div', { class: 'form-row' }, h('label', { class: 'field grow' }, h('span', { class: 'lbl' }, 'Index terms'), tagsIn))),
    notice ? h('p', { class: 'warn' }, notice) : null,
    origSigned ? h('p', { class: 'note' }, `This page was signed on ${fmtDate(fm.signed)}. Changes are saved as a dated amendment, and the earlier version stays in the page history.`) : null,
    contLine,
    h('div', { class: 'tabs', role: 'tablist' }, tabWrite, tabPrev),
    split, fileIn);

  const root = h('div', { class: 'view editor' },
    topbar({ title: isNew ? `New page in ${v.title}` : `Editing p. ${num}`, sub: v.title, actions: [] }),
    demoBanner(), sheet,
    h('div', { class: 'action-bar' }, status, h('div', { class: 'ab-buttons' }, h('button', { class: 'btn ghost', type: 'button', onclick: cancel }, 'Cancel'), saveBtn, signBtn)));
  root.querySelector('.topbar .tb-left').prepend(h('button', { class: 'btn icon ghost', 'aria-label': 'Cancel', title: 'Cancel', onclick: cancel }, icon('close')));

  renderStrip();
  requestAnimationFrame(() => {
    autosize(); renderPreview.flush();
    (isNew && !titleIn.value ? titleIn : ta).focus({ preventScroll: true });
  });
  window.addEventListener('resize', () => { if (wide()) renderPreview(); }, { passive: true });
  const leaveGuard = () => { if (!leaving && view.kind === 'editor') saveDraft.flush(); };
  window.addEventListener('pagehide', leaveGuard);
  window.addEventListener('hashchange', leaveGuard, { once: true });
  return root;
}

function choose(title, text, options) {
  return new Promise((resolve) => {
    let picked = null;
    modal({
      title, body: h('p', null, text),
      buttons: options.map(([value, label], i) => ({ label, primary: i === 0, run: () => { picked = value; } })),
      onClose: () => resolve(picked),
    });
  });
}

function openPagePicker(curVol, onPick) {
  const input = h('input', { type: 'search', placeholder: 'Search by title, number or words', autofocus: true, 'aria-label': 'Find a page' });
  const list = h('ol', { class: 'picker-list' });
  let root;
  const draw = () => {
    const res = search(lib.allPages(), input.value).slice(0, 30);
    list.replaceChildren(...res.map(({ page: p }) => h('li', null, h('button', {
      type: 'button', class: 'picker-item',
      onclick: () => { onPick(p.vol === curVol ? String(p.num) : `${p.vol}/${p.num}`); root.close(); },
    }, h('span', { class: 'l-where' }, p.vol === curVol ? `p. ${p.num}` : `${lib.volume(p.vol)?.title || p.vol}, p. ${p.num}`), h('span', { class: 'l-title' }, p.title)))));
    if (!res.length) list.append(h('li', { class: 'muted' }, 'No pages match.'));
  };
  input.addEventListener('input', draw);
  draw();
  root = modal({ title: 'Link to a page', body: h('div', { class: 'picker' }, input, list), buttons: [] });
}

// ---------- search ----------
function openSearch(initial = '', vol = '') {
  const input = h('input', { type: 'search', value: initial, placeholder: 'Words, #tag or page number', autofocus: true, 'aria-label': 'Search the notebook' });
  const volSel = h('select', { 'aria-label': 'Volume' }, h('option', { value: '' }, 'All volumes'), lib.volumes().map((v) => h('option', { value: v.id, selected: v.id === vol }, v.title)));
  const tags = h('div', { class: 'tag-cloud' }, lib.tags().slice(0, 24).map(([t, n]) => h('button', {
    type: 'button', class: 'tag-btn', onclick: () => { input.value = `#${t}`; draw(); input.focus(); },
  }, `#${t}`, h('span', { class: 'n' }, n))));
  const out = h('ol', { class: 'results' });
  let root;
  const draw = () => {
    const q = input.value.trim();
    tags.hidden = !!q;
    if (!q && !volSel.value) { out.replaceChildren(); return; }
    const res = search(lib.allPages(), q, { vol: volSel.value }).slice(0, 60);
    out.replaceChildren(...res.map(({ page: p, snippet }) => h('li', null, h('a', { href: `#/v/${p.vol}/${p.num}`, onclick: () => root.close() },
      h('span', { class: 'r-where' }, `${lib.volume(p.vol)?.title || p.vol}, p. ${p.num}`, h('span', { class: 'r-date' }, fmtDate(p.date))),
      h('span', { class: 'r-title' }, p.title),
      snippet ? h('span', { class: 'r-snip', html: snippet }) : null))));
    if (!res.length) out.append(h('li', { class: 'muted' }, 'Nothing matches. Try fewer words.'));
  };
  input.addEventListener('input', draw);
  volSel.addEventListener('change', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const a = out.querySelector('a'); if (a) { a.click(); location.hash = a.getAttribute('href'); } } });
  draw();
  root = modal({ title: 'Search', wide: true, body: h('div', { class: 'search' }, h('div', { class: 'search-row' }, input, volSel), tags, out), buttons: [] });
}

// ---------- printing ----------
async function printVolume(id) {
  const v = lib.volume(id);
  const pr = document.getElementById('print-root');
  pr.replaceChildren();
  toast('Preparing the volume for printing…');
  const pages = lib.pages(id);
  pr.append(h('article', { class: 'sheet print-cover' },
    h('div', { class: 'cover-label big' },
      h('span', { class: 'cl-kind' }, 'Laboratory notebook'),
      h('span', { class: 'cl-no' }, `No. ${v.number}`),
      h('span', { class: 'cl-title' }, v.title),
      h('span', { class: 'cl-meta' }, `${lib.notebook.owner || ''}`, h('br'), `${fmtDate(v.created)} to ${fmtDate(pages[pages.length - 1]?.date || todayISO())}`))));
  const toc = viewVolume(id).querySelector('.sheet.toc');
  pr.append(toc);
  const readies = [];
  for (const p of pages) {
    const { el, ready } = await buildPageSheet(id, p.num, { forPrint: true });
    pr.append(el); readies.push(ready);
  }
  const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 15000))]);
  await settle(Promise.allSettled(readies));
  await settle(Promise.all([...pr.querySelectorAll('img')].map((i) => i.decode?.().catch(() => {}))));
  document.body.classList.add('print-volume');
  fitChartsForPrint(pr, 680);
  setTimeout(() => window.print(), 50);
}

// ---------- settings ----------
function viewSettings() {
  const isLib = !!lib;
  const back = isLib ? '#/' : null;
  const nbTitle = h('input', { id: 's-title', value: lib?.notebook.title || '' });
  const owner = h('input', { id: 's-owner', value: lib?.notebook.owner || '', placeholder: 'Your name as you sign it' });
  const theme = h('select', { id: 's-theme' }, [['auto', 'Match this device'], ['light', 'Light paper'], ['dark', 'Night paper']].map(([v, l]) => h('option', { value: v, selected: S.theme === v }, l)));
  const down = h('input', { type: 'checkbox', id: 's-down', checked: S.downscale });
  const repo = h('input', { id: 's-repo', value: `${S.owner}/${S.repo}`, spellcheck: 'false' });
  const branch = h('input', { id: 's-branch', value: S.branch, spellcheck: 'false' });
  const token = h('input', { id: 's-token', type: 'password', placeholder: S.token ? 'Saved on this device (paste a new one to replace it)' : 'github_pat_…', autocomplete: 'off' });
  const api = h('input', { id: 's-api', value: S.apiBase, spellcheck: 'false' });

  theme.addEventListener('change', () => { S.theme = theme.value; saveSettings(); applyTheme(); });
  down.addEventListener('change', () => { S.downscale = down.checked; saveSettings(); });

  const section = (title, ...kids) => h('section', { class: 'settings-section' }, h('h2', null, title), ...kids);
  return h('div', { class: 'view settings' },
    topbar({ back, backLabel: 'All volumes', title: 'Settings' }),
    demoBanner(),
    h('article', { class: 'sheet plain narrow' },
      isLib ? section('Notebook',
        h('div', { class: 'form' },
          h('label', { for: 's-title' }, 'Notebook title'), nbTitle,
          h('label', { for: 's-owner' }, 'Name used when signing pages'), owner,
          h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            try { await lib.updateNotebook((nb) => { nb.title = nbTitle.value.trim() || 'Laboratory notebooks'; nb.owner = owner.value.trim(); }); toast('Notebook details saved.'); } catch (err) { toast(err instanceof NetworkError ? 'You’re offline. Try again when connected.' : err.message); } finally { e.target.disabled = false; }
          } }, 'Save notebook details'))) : null,
      section('This device',
        h('div', { class: 'form' },
          h('label', { for: 's-theme' }, 'Paper'), theme,
          h('label', { class: 'check', for: 's-down' }, down, ' Shrink large photos to 2400 px before attaching'))),
      DEMO ? null : section('Connection',
        h('p', { class: 'muted' }, 'Entries are stored in this private GitHub repository. The token is kept only in this browser.'),
        h('div', { class: 'form' },
          h('label', { for: 's-repo' }, 'Repository'), repo,
          h('label', { for: 's-branch' }, 'Branch'), branch,
          h('label', { for: 's-token' }, 'Token'), token,
          h('details', null, h('summary', null, 'Advanced'), h('label', { for: 's-api' }, 'GitHub API address'), api),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
              const [o, r] = repo.value.trim().split('/');
              if (!o || !r) { toast('Enter the repository as owner/name.'); return; }
              const next = { ...S, owner: o, repo: r, branch: branch.value.trim() || 'main', apiBase: api.value.trim() || DEFAULTS.apiBase, token: token.value.trim() || S.token };
              e.target.disabled = true;
              try {
                const acc = await new GitHubBackend(next).checkAccess();
                if (!acc.canWrite) throw new Error('This token can’t change the repository. Set Contents to Read and write.');
                if (!(await confirmPrivate(acc, `${o}/${r}`))) return;
                Object.assign(S, next); saveSettings();
                await startLibrary(); toast('Connected.'); location.hash = '#/';
              } catch (err) {
                toast(err instanceof ApiError && err.status === 401 ? 'GitHub rejected this token.' : err instanceof ApiError && err.status === 404 ? 'This token can’t see that repository.' : err.message);
              } finally { e.target.disabled = false; }
            } }, 'Save connection'),
            h('a', { class: 'btn', href: tokenUrl(), target: '_blank', rel: 'noopener' }, 'Create a new token')))),
      isLib ? section('Maintenance',
        h('p', { class: 'muted' }, 'Rebuild the search index after editing page files directly in GitHub or on a computer. Clearing the cache only removes copies stored on this device.'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn', type: 'button', onclick: async (e) => {
            e.target.disabled = true; toast('Rebuilding the search index…');
            try { const n = await lib.rebuildIndex(); toast(`Search index rebuilt (${n} pages read).`); } catch (err) { toast(err.message); } finally { e.target.disabled = false; }
          } }, 'Rebuild search index'),
          h('button', { class: 'btn', type: 'button', onclick: async () => { await lib.clearCache(); toast('Cached copies cleared. Pages will download again as you open them.'); lib.head = null; await lib.refresh(); } }, 'Clear cached copies'))) : null,
      section('Help',
        h('p', null, h('a', { href: '?demo#/v/sample/1' }, 'Open the sample notebook'), ' to see every kind of entry with its source text.')),
      DEMO ? null : section('Disconnect',
        h('p', { class: 'muted' }, 'Removes the token and cached pages from this device. Nothing in GitHub changes.'),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          const ok = await choose('Disconnect this device?', lib?.outbox.length ? `${lib.outbox.length} saved pages haven’t synced yet and will be lost.` : 'You can connect again at any time with a token.', [['yes', 'Disconnect'], ['no', 'Cancel']]);
          if (ok !== 'yes') return;
          if (lib) { await lib.clearCache(); await kv.del(`${lib.key}:outbox`); }
          S.token = ''; saveSettings(); location.hash = '#/'; location.reload();
        } }, 'Disconnect this device'))));
}

boot();
