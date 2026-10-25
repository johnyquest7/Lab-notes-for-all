// Storage: GitHub (or in-memory demo) backend, local cache, offline outbox.
import {
  PAGE_RE, VOL_INDEX_RE, pagePath, attPath, attDir, volIndexPath, makeEntry,
  serializePage, slugify, todayISO,
} from './model.js';

export const te = new TextEncoder();
export const td = new TextDecoder();

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class NetworkError extends Error {}
export class StaleHeadError extends Error {}
export class ConflictError extends Error {
  constructor(info) { super('This page was changed on another device after you opened it.'); this.info = info; }
}

// ---------- IndexedDB (falls back to memory) ----------
const mem = { kv: new Map(), blobs: new Map() };
let dbp = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const r = indexedDB.open('labnote', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('blobs'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function idb(store, mode, fn) {
  const db = await openDb();
  if (!db) return fn(null, mem[store]);
  return new Promise((resolve, reject) => {
    let req;
    try {
      const tx = db.transaction(store, mode);
      req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    } catch (e) { reject(e); }
  });
}
export const kv = {
  get: (k) => idb('kv', 'readonly', (s, m) => (s ? s.get(k) : { result: m.get(k) })),
  set: (k, v) => idb('kv', 'readwrite', (s, m) => (s ? s.put(v, k) : m.set(k, v))),
  del: (k) => idb('kv', 'readwrite', (s, m) => (s ? s.delete(k) : m.delete(k))),
  async keys(prefix) {
    const all = await idb('kv', 'readonly', (s, m) => (s ? s.getAllKeys() : { result: [...m.keys()] }));
    return (all || []).filter((k) => String(k).startsWith(prefix));
  },
};
const blobs = {
  get: (sha) => idb('blobs', 'readonly', (s, m) => (s ? s.get(sha) : { result: m.get(sha) })),
  put: (sha, buf) => idb('blobs', 'readwrite', (s, m) => (s ? s.put(buf, sha) : m.set(sha, buf))).catch(() => {}),
  clear: () => idb('blobs', 'readwrite', (s, m) => (s ? s.clear() : m.clear())),
};

// ---------- byte helpers ----------
export async function toBytes(data) {
  if (typeof data === 'string') return te.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new Error('Unsupported data');
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function gitSha(bytes) {
  const head = te.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  ipynb: 'application/json', md: 'text/markdown', txt: 'text/plain',
};
export const mimeOf = (path) => MIME[String(path).split('.').pop().toLowerCase()] || 'application/octet-stream';

// ---------- GitHub backend ----------
export class GitHubBackend {
  constructor({ owner, repo, branch = 'main', token, apiBase = 'https://api.github.com' }) {
    Object.assign(this, { owner, repo, branch, token, apiBase: apiBase.replace(/\/$/, '') });
    this.key = `gh:${owner}/${repo}@${branch}`.toLowerCase();
    this.rp = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }
  async req(path, { method = 'GET', body, raw = false, fresh = false } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.apiBase + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: fresh ? 'no-store' : 'default',
      });
    } catch {
      throw new NetworkError('Could not reach GitHub.');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.message || msg; } catch { /* ignore */ }
      throw new ApiError(res.status, msg);
    }
    if (raw) return res.blob();
    if (res.status === 204) return null;
    return res.json();
  }
  async checkAccess() {
    const r = await this.req(this.rp, { fresh: true });
    return { private: r.private, canWrite: !!(r.permissions && r.permissions.push), fullName: r.full_name, defaultBranch: r.default_branch };
  }
  async getHead() {
    try {
      const b = await this.req(`${this.rp}/branches/${encodeURIComponent(this.branch)}`, { fresh: true });
      return { commit: b.commit.sha, tree: b.commit.commit.tree.sha };
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null;
      throw e;
    }
  }
  async getTree(treeSha) {
    const t = await this.req(`${this.rp}/git/trees/${treeSha}?recursive=1`);
    const m = new Map();
    for (const e of t.tree) if (e.type === 'blob') m.set(e.path, e.sha);
    return m;
  }
  getBlob(sha) { return this.req(`${this.rp}/git/blobs/${sha}`, { raw: true }); }
  async createBlob(bytes) {
    const r = await this.req(`${this.rp}/git/blobs`, { method: 'POST', body: { content: b64(bytes), encoding: 'base64' } });
    return r.sha;
  }
  async createTree(base, entries) {
    const tree = entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.delete ? null : e.sha }));
    const r = await this.req(`${this.rp}/git/trees`, { method: 'POST', body: base ? { base_tree: base, tree } : { tree } });
    return r.sha;
  }
  async createCommit(message, tree, parents) {
    const r = await this.req(`${this.rp}/git/commits`, { method: 'POST', body: { message, tree, parents } });
    return r.sha;
  }
  async updateRef(sha) {
    try {
      await this.req(`${this.rp}/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: { sha, force: false } });
    } catch (e) {
      if (e.status === 422 || e.status === 409) throw new StaleHeadError();
      throw e;
    }
  }
  // An empty repository has no branch yet; the contents API creates the first commit.
  async initialize(path, text, message) {
    await this.req(`${this.rp}/contents/${path}`, { method: 'PUT', body: { message, content: b64(te.encode(text)), branch: this.branch } });
  }
  async history(path) {
    const r = await this.req(`${this.rp}/commits?sha=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(path)}&per_page=30`, { fresh: true });
    return r.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.author.date, author: c.commit.author.name, url: c.html_url }));
  }
  webUrl(path) { return `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${path}`; }
}

// ---------- In-memory backend (sample notebook) ----------
export class MemoryBackend {
  constructor(files) {
    this.key = 'demo';
    this.objects = new Map(); this.trees = new Map(); this.commits = new Map();
    this.head = null; this.n = 0;
    this.ready = this.seed(files);
  }
  async seed(files) {
    const entries = [];
    for (const [path, data] of Object.entries(files || {})) {
      entries.push({ path, sha: await this.createBlob(await toBytes(data)) });
    }
    const tree = await this.createTree(null, entries);
    this.head = await this.createCommit('Sample notebook', tree, []);
  }
  async checkAccess() { return { private: true, canWrite: true, fullName: 'sample notebook' }; }
  async getHead() { await this.ready; return this.head ? { commit: this.head, tree: this.commits.get(this.head).tree } : null; }
  async getTree(sha) { return new Map(this.trees.get(sha)); }
  async getBlob(sha) { return new Blob([this.objects.get(sha)]); }
  async createBlob(bytes) { const sha = await gitSha(bytes); this.objects.set(sha, bytes); return sha; }
  async createTree(base, entries) {
    const m = new Map(base ? this.trees.get(base) : []);
    for (const e of entries) (e.delete ? m.delete(e.path) : m.set(e.path, e.sha));
    const sha = `t${++this.n}`; this.trees.set(sha, m); return sha;
  }
  async createCommit(message, tree, parents) {
    const sha = `c${++this.n}${Math.random().toString(16).slice(2, 10)}`;
    this.commits.set(sha, { message, tree, parents, date: new Date().toISOString() });
    return sha;
  }
  async updateRef(sha) {
    if (this.head && this.commits.get(sha).parents[0] !== this.head) throw new StaleHeadError();
    this.head = sha;
  }
  async history(path) {
    const out = [];
    let c = this.head;
    while (c) {
      const cm = this.commits.get(c);
      const p = cm.parents[0];
      const cur = this.trees.get(cm.tree).get(path);
      const prev = p ? this.trees.get(this.commits.get(p).tree).get(path) : undefined;
      if (cur !== prev) out.push({ sha: c, message: cm.message, date: cm.date, author: 'You', url: null });
      c = p;
    }
    return out;
  }
  webUrl() { return null; }
}

// ---------- Library: the notebook as the app sees it ----------
const DEFAULT_NOTEBOOK = { title: 'Laboratory notebooks', owner: '', volumes: [] };
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export class Library {
  constructor(backend) {
    this.b = backend;
    this.key = backend.key;
    this.head = null; this.headTree = null;
    this.tree = new Map();
    this.notebook = structuredClone(DEFAULT_NOTEBOOK);
    this.pagesByKey = {}; // "vol/num" -> entry
    this.outbox = [];
    this.status = { state: 'idle' };
    this.listeners = new Set();
    this.empty = false;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { for (const fn of this.listeners) { try { fn(kind); } catch (e) { console.error(e); } } }
  setStatus(s) { this.status = { ...s, at: Date.now() }; this.emit('status'); }

  async open() {
    const cached = await kv.get(`${this.key}:state`).catch(() => null);
    this.outbox = (await kv.get(`${this.key}:outbox`).catch(() => null)) || [];
    if (cached) {
      this.head = cached.head; this.headTree = cached.headTree;
      this.tree = new Map(cached.tree); this.notebook = cached.notebook; this.pagesByKey = cached.pages || {};
      this.emit('data');
      this.refresh().then(() => this.flush());
    } else {
      await this.refresh();
      this.flush();
    }
  }
  async persist() {
    await kv.set(`${this.key}:state`, {
      head: this.head, headTree: this.headTree, tree: [...this.tree], notebook: this.notebook, pages: this.pagesByKey,
    }).catch(() => {});
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.setStatus({ state: 'syncing' });
      try {
        const head = await this.b.getHead();
        if (!head) { this.empty = true; this.setStatus({ state: 'empty' }); return; }
        this.empty = false;
        if (head.commit !== this.head) await this.load(head);
        this.setStatus(this.idleStatus());
      } catch (e) {
        if (e instanceof NetworkError) this.setStatus({ state: 'offline' });
        else this.setStatus({ state: 'error', message: e.message, code: e.status });
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }
  idleStatus() {
    const conflicts = this.outbox.filter((o) => o.status === 'conflict' || o.status === 'error').length;
    if (conflicts) return { state: 'attention', count: conflicts };
    if (this.outbox.length) return { state: 'pending', count: this.outbox.length };
    return { state: 'synced' };
  }
  async load(head) {
    const tree = await this.b.getTree(head.tree);
    const prevTree = this.tree;
    this.tree = tree;
    try {
      this.notebook = { ...DEFAULT_NOTEBOOK, ...(await this.readJSON('notebook.json', DEFAULT_NOTEBOOK)) };
      await this.reconcile();
    } catch (e) { this.tree = prevTree; throw e; }
    this.head = head.commit; this.headTree = head.tree;
    await this.persist();
    this.emit('data');
  }
  async readJSON(path, fallback) {
    if (!this.tree.has(path)) return structuredClone(fallback);
    try { return JSON.parse(await this.readText(path)); } catch { return structuredClone(fallback); }
  }
  // Make the in-memory page index match the files actually in the repository,
  // so pages added outside the app (e.g. pushed from a laptop) still appear.
  async reconcile({ force = false } = {}) {
    const next = {};
    const volIdx = {};
    for (const path of this.tree.keys()) {
      const m = path.match(VOL_INDEX_RE);
      if (m && !volIdx[m[1]]) volIdx[m[1]] = this.readJSON(path, { pages: {} });
    }
    const stored = {};
    for (const [vol, p] of Object.entries(volIdx)) {
      const j = await p;
      for (const [num, e] of Object.entries(j.pages || {})) stored[`${vol}/${num}`] = e;
    }
    const todo = [];
    for (const [path, sha] of this.tree) {
      const m = path.match(PAGE_RE);
      if (!m) continue;
      const vol = m[1]; const num = parseInt(m[2], 10); const key = `${vol}/${num}`;
      const known = this.pagesByKey[key]?.sha === sha ? this.pagesByKey[key] : stored[key]?.sha === sha ? stored[key] : null;
      if (known && !force) next[key] = known;
      else todo.push({ vol, num, key, path, sha });
    }
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const t = todo[i++];
        try { next[t.key] = makeEntry(t.vol, t.num, await this.readText(t.path), t.sha); } catch (e) { console.warn('index', t.path, e); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
    this.pagesByKey = next;
    return todo.length;
  }

  // ----- reading -----
  async readBlob(path) {
    const sha = this.tree.get(path);
    if (!sha) { const e = new Error(`Not found: ${path}`); e.notFound = true; throw e; }
    const cached = await blobs.get(sha).catch(() => null);
    if (cached) return new Blob([cached], { type: mimeOf(path) });
    const blob = await this.b.getBlob(sha);
    const buf = await blob.arrayBuffer();
    blobs.put(sha, buf);
    return new Blob([buf], { type: mimeOf(path) });
  }
  async readText(path) { return td.decode(await (await this.readBlob(path)).arrayBuffer()); }

  pendingFor(vol, num) {
    return [...this.outbox].reverse().find((o) => o.vol === vol && o.num === num && o.status !== 'discarded');
  }
  async readPage(vol, num) {
    const p = this.pendingFor(vol, num);
    if (p) return serializePage(p.fm, p.body);
    return this.readText(pagePath(vol, num));
  }
  async readAttachment(vol, num, name) {
    const p = this.pendingFor(vol, num);
    const a = p?.attachments?.find((x) => x.name === name);
    if (a) return new Blob([a.buf], { type: a.type || mimeOf(name) });
    return this.readBlob(attPath(vol, num, name));
  }
  attachments(vol, num) {
    const dir = attDir(vol, num);
    const names = new Set();
    for (const p of this.tree.keys()) if (p.startsWith(dir)) names.add(p.slice(dir.length));
    return [...names];
  }

  // ----- queries -----
  volumes() { return [...(this.notebook.volumes || [])].sort((a, b) => (a.number || 0) - (b.number || 0)); }
  volume(id) { return (this.notebook.volumes || []).find((v) => v.id === id); }
  allPages() {
    const map = { ...this.pagesByKey };
    for (const o of this.outbox) {
      if (o.status === 'discarded') continue;
      map[`${o.vol}/${o.num}`] = { ...makeEntry(o.vol, o.num, serializePage(o.fm, o.body), null), pending: true, status: o.status };
    }
    return Object.values(map);
  }
  pages(vol) { return this.allPages().filter((p) => p.vol === vol).sort((a, b) => a.num - b.num); }
  page(vol, num) {
    const p = this.pendingFor(vol, num);
    if (p) return { ...makeEntry(vol, num, serializePage(p.fm, p.body), null), pending: true, status: p.status };
    return this.pagesByKey[`${vol}/${num}`] || null;
  }
  nextNumber(vol, excludeId) {
    let max = 0;
    for (const p of Object.values(this.pagesByKey)) if (p.vol === vol) max = Math.max(max, p.num);
    for (const path of this.tree.keys()) { const m = path.match(PAGE_RE); if (m && m[1] === vol) max = Math.max(max, parseInt(m[2], 10)); }
    for (const o of this.outbox) if (o.vol === vol && o.id !== excludeId && o.status !== 'discarded') max = Math.max(max, o.num || 0);
    return max + 1;
  }
  backlinks(vol, num) {
    const key = `${vol}/${num}`;
    return this.allPages().filter((p) => p.links?.includes(key) && `${p.vol}/${p.num}` !== key)
      .sort((a, b) => (a.vol === b.vol ? a.num - b.num : a.vol.localeCompare(b.vol)));
  }
  continuedOn(vol, num) {
    const key = `${vol}/${num}`;
    return this.allPages().find((p) => p.continues === key) || null;
  }
  tags() {
    const counts = new Map();
    for (const p of this.allPages()) for (const t of p.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // ----- writing -----
  // build(lib) returns { changes: [{path, data} | {path, delete: true}], result, after }.
  // It runs against the latest state on every attempt, so concurrent edits from
  // another device are merged instead of overwritten.
  async commit(message, build) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.b.getHead();
      if (!head) throw new Error('The notebook repository is empty. Open Settings to initialize it.');
      if (head.commit !== this.head) await this.load(head);
      const plan = await build(this);
      const prepared = await Promise.all(plan.changes.map(async (ch) => {
        if (ch.delete) return this.tree.has(ch.path) ? { path: ch.path, delete: true } : null;
        const bytes = await toBytes(ch.data);
        const sha = await gitSha(bytes);
        if (this.tree.get(ch.path) === sha) return null;
        return { path: ch.path, bytes, sha };
      }));
      const entries = prepared.filter(Boolean);
      if (!entries.length) { plan.after?.(); return plan.result; }
      await Promise.all(entries.filter((e) => !e.delete).map(async (e) => { e.sha = await this.b.createBlob(e.bytes); }));
      const tree = await this.b.createTree(head.tree, entries);
      const commit = await this.b.createCommit(message, tree, [head.commit]);
      try { await this.b.updateRef(commit); } catch (e) { if (e instanceof StaleHeadError) continue; throw e; }
      for (const e of entries) {
        if (e.delete) this.tree.delete(e.path);
        else { this.tree.set(e.path, e.sha); blobs.put(e.sha, e.bytes.slice().buffer); }
      }
      this.head = commit; this.headTree = tree;
      plan.after?.();
      await this.persist();
      this.emit('data');
      return plan.result;
    }
    throw new Error('The notebook kept changing while saving. Try again.');
  }

  volumeIndexData(vol, overrides = {}) {
    const pages = {};
    for (const p of Object.values({ ...this.pagesByKey, ...overrides })) {
      if (p.vol === vol && !p.pending) pages[p.num] = { ...p };
    }
    return { version: 1, volume: vol, pages };
  }

  async commitPage(item) {
    const label = this.volume(item.vol)?.title || item.vol;
    return this.commit(item.message || `${item.isNew ? 'Add' : 'Update'} ${label}, p. ${item.num ?? 'new'}`, async (lib) => {
      let num = item.num;
      if (item.isNew || item.asNew) {
        num = lib.nextNumber(item.vol, item.id);
        if (item.num && !lib.tree.has(pagePath(item.vol, item.num)) && !lib.pagesByKey[`${item.vol}/${item.num}`]) num = item.num;
      } else if (!item.force) {
        const cur = lib.tree.get(pagePath(item.vol, num)) || null;
        if (cur !== (item.baseSha || null)) throw new ConflictError({ vol: item.vol, num });
      }
      const md = serializePage(item.fm, item.body);
      const changes = [{ path: pagePath(item.vol, num), data: md }];
      for (const a of item.attachments || []) changes.push({ path: attPath(item.vol, num, a.name), data: a.buf || a.blob });
      for (const n of item.removed || []) changes.push({ path: attPath(item.vol, num, n), delete: true });
      const entry = makeEntry(item.vol, num, md, await gitSha(te.encode(md)));
      const key = `${item.vol}/${num}`;
      changes.push({ path: volIndexPath(item.vol), data: JSON.stringify(lib.volumeIndexData(item.vol, { [key]: entry })) });
      return { changes, result: num, after: () => { lib.pagesByKey[key] = entry; } };
    });
  }

  // Save now if possible; otherwise keep it on this device and sync later.
  async savePage(item) {
    item.id ||= uid();
    if (item.num == null) item.num = this.nextNumber(item.vol, item.id);
    // attachments are stored as ArrayBuffers so they survive in IndexedDB
    item.attachments = await Promise.all((item.attachments || []).map(async (a) => ({
      name: a.name, type: a.type || a.blob?.type || mimeOf(a.name), buf: a.buf || await a.blob.arrayBuffer(),
    })));
    try {
      const num = await this.commitPage(item);
      await this.dropOutbox(item.id);
      return { num, queued: false };
    } catch (e) {
      if (e instanceof NetworkError) {
        item.status = 'pending'; item.queuedAt = Date.now();
        this.outbox = this.outbox.filter((o) => o.id !== item.id).concat(item);
        await kv.set(`${this.key}:outbox`, this.outbox);
        this.setStatus({ state: 'offline' });
        this.emit('data');
        return { num: item.num, queued: true };
      }
      throw e;
    }
  }
  async dropOutbox(id) {
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((o) => o.id !== id);
    if (this.outbox.length !== before) { await kv.set(`${this.key}:outbox`, this.outbox); this.emit('data'); }
  }
  async flush() {
    if (this.flushing || !this.outbox.length) return;
    this.flushing = true;
    try {
      for (const item of [...this.outbox]) {
        if (item.status === 'conflict' || item.status === 'error') continue;
        try {
          const num = await this.commitPage(item);
          this.outbox = this.outbox.filter((o) => o.id !== item.id);
          await kv.set(`${this.key}:outbox`, this.outbox);
          this.emit('saved', { id: item.id, vol: item.vol, num });
        } catch (e) {
          if (e instanceof NetworkError) { this.setStatus({ state: 'offline' }); return; }
          item.status = e instanceof ConflictError ? 'conflict' : 'error';
          item.error = e.message;
          await kv.set(`${this.key}:outbox`, this.outbox);
        }
      }
      this.setStatus(this.idleStatus());
      this.emit('data');
    } finally { this.flushing = false; }
  }
  async resolve(id, how) {
    const item = this.outbox.find((o) => o.id === id);
    if (!item) return;
    if (how === 'discard') { await this.dropOutbox(id); this.setStatus(this.idleStatus()); return; }
    item.status = 'pending';
    if (how === 'overwrite') item.force = true;
    if (how === 'new') { item.asNew = true; item.isNew = true; }
    await kv.set(`${this.key}:outbox`, this.outbox);
    await this.flush();
  }

  async createVolume({ title, color, description }) {
    return this.commit(`Add volume: ${title}`, async (lib) => {
      const nb = structuredClone(lib.notebook);
      nb.volumes ||= [];
      const taken = new Set(nb.volumes.map((v) => v.id));
      let id = slugify(title); let n = 2;
      while (taken.has(id)) id = `${slugify(title).slice(0, 36)}-${n++}`;
      const number = Math.max(0, ...nb.volumes.map((v) => v.number || 0)) + 1;
      nb.volumes.push({ id, title, number, color, description: description || '', created: todayISO() });
      return {
        changes: [
          { path: 'notebook.json', data: `${JSON.stringify(nb, null, 2)}\n` },
          { path: volIndexPath(id), data: JSON.stringify({ version: 1, volume: id, pages: {} }) },
        ],
        result: id,
        after: () => { lib.notebook = nb; },
      };
    });
  }
  async updateNotebook(mutate, message = 'Update notebook settings') {
    return this.commit(message, async (lib) => {
      const nb = structuredClone(lib.notebook);
      mutate(nb);
      return { changes: [{ path: 'notebook.json', data: `${JSON.stringify(nb, null, 2)}\n` }], after: () => { lib.notebook = nb; } };
    });
  }
  async rebuildIndex() {
    await this.refresh();
    const changed = await this.reconcile({ force: true });
    const vols = new Set(Object.values(this.pagesByKey).map((p) => p.vol));
    for (const v of this.volumes()) vols.add(v.id);
    await this.commit('Rebuild search index', async (lib) => ({
      changes: [...vols].map((v) => ({ path: volIndexPath(v), data: JSON.stringify(lib.volumeIndexData(v)) })),
    }));
    return changed;
  }
  async initialize(owner) {
    const nb = { ...DEFAULT_NOTEBOOK, owner };
    await this.b.initialize('notebook.json', `${JSON.stringify(nb, null, 2)}\n`, 'Start notebook');
    await this.refresh();
  }
  async clearCache() {
    await blobs.clear();
    await kv.del(`${this.key}:state`);
  }
  history(path) { return this.b.history(path); }
}
