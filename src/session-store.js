// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the session list keeps for one project, for every source alike: groups, archived, pinned, title colours, the
 * newest reply seen, the unread mark, and which sources were imported. One file per project in the shared folder
 * (sharedHome()/session-list/<key>.json), so every window and every editor on this machine with the project open
 * reads and writes the same one.
 *
 * Several windows change it at once, so a window never writes what it read back over the file. Each change is an
 * operation stamped with its time; a write takes the lock folder beside the file, reads the file as it is now, applies
 * the pending operations to it and puts the result in place, then lets go. A field keeps the change made last, and the
 * newest reply seen only ever grows, so two windows changing different conversations, or the same one, both keep
 * their change. A write that finds the lock taken tries again shortly. A lock older than LOCK_STALE_MS was left by a
 * window that died while writing, and is taken over.
 *
 * A conversation is keyed by its source and id. A deleted group leaves a marker so that a window that had not seen
 * the deletion does not bring it back; its conversations read as ungrouped.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic, sharedHome } = require('./files');

const STORE_DIR = 'session-list';
const FORMAT = 1;
const LOCK_STALE_MS = 10000;
const RETRY_MS = 60;
const NAME_MAX = 100;
const GROUPS_MAX = 100;
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

const keyOf = (sourceId, sessionId) => JSON.stringify([String(sourceId), String(sessionId)]);
const cleanName = (name) => [...String(name || '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('');

/* The project a window is on: its saved workspace file, else its first folder, else none. `label` is for people. */
function projectOf(folders, workspaceFile) {
  const id = workspaceFile ? `workspace:${workspaceFile}` : folders && folders.length ? `folder:${folders[0]}` : 'none';
  const label = workspaceFile ? path.basename(workspaceFile) : folders && folders.length ? path.basename(folders[0]) : '(no folder)';
  return { key: crypto.createHash('sha256').update(id).digest('hex').slice(0, 16), label, id };
}

const empty = () => ({ format: FORMAT, label: '', groups: {}, s: {}, imported: {}, sweepAt: 0 });

function readFile(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && d.format === FORMAT && typeof d.s === 'object' && typeof d.groups === 'object') {
      return Object.assign(empty(), d, { imported: d.imported && typeof d.imported === 'object' ? d.imported : {} });
    }
  } catch (_) { /* none yet, or unreadable: start empty */ }
  return empty();
}

/* A field [value, at]: the change made last wins. */
const later = (have, next) => (!Array.isArray(have) || !(have[have.length - 1] > next[next.length - 1]) ? next : have);

/* Applies one operation to `d` in place. */
function apply(d, op) {
  const rec = (k) => (d.s[k] || (d.s[k] = {}));
  switch (op.type) {
    case 'group': for (const k of op.keys) rec(k).g = later(rec(k).g, [op.group || null, op.at]); break;
    case 'archive':
      for (const k of op.keys) {
        const had = rec(k).a;
        const first = op.on ? (had && had[0] && had[1] > 0 ? had[1] : op.since || op.at) : 0;
        rec(k).a = later(had, [!!op.on, first, op.at]);
        if (op.on) rec(k).g = later(rec(k).g, [null, op.at]);
        if (op.on && !op.keepPin) rec(k).p = later(rec(k).p, [false, op.at]);
      }
      break;
    case 'pin': for (const k of op.keys) rec(k).p = later(rec(k).p, [!!op.on, op.at]); break;
    case 'color': for (const k of op.keys) rec(k).c = later(rec(k).c, [COLORS.includes(op.color) ? op.color : null, op.at]); break;
    case 'seen': {
      const r = rec(op.key);
      if (!(r.r >= op.replyAt)) r.r = op.replyAt;
      r.u = later(r.u, [false, op.at]);
      break;
    }
    case 'unread': for (const k of op.keys) rec(k).u = later(rec(k).u, [!!op.on, op.at]); break;
    case 'newGroup': if (!d.groups[op.id]) d.groups[op.id] = { n: op.name, o: op.order, at: op.at }; break;
    case 'renameGroup': if (d.groups[op.id] && !d.groups[op.id].del && !(d.groups[op.id].at > op.at)) Object.assign(d.groups[op.id], { n: op.name, at: op.at }); break;
    case 'orderGroup': if (d.groups[op.id] && !d.groups[op.id].del) d.groups[op.id].o = op.order; break;
    case 'deleteGroup': if (d.groups[op.id]) Object.assign(d.groups[op.id], { del: true, at: op.at }); break;
    case 'imported': d.imported[op.sourceId] = op.at; break;
    case 'sweep': d.sweepAt = Math.max(d.sweepAt || 0, op.at); break;
    case 'label': d.label = op.label; break;
    default: break;
  }
}

/*
 * `dir` is the folder of the store files, `key` the project's (projectOf). `now()` gives the time; `log` reports a
 * write that failed. While `writable()` is false, as in Restricted Mode, changes show in this window and are written
 * once it is true again.
 */
function createStore({ dir = path.join(sharedHome(), STORE_DIR), key, label = '', now = Date.now, log = () => {}, writable = () => true }) {
  const file = path.join(dir, `${key}.json`);
  const lock = `${file}.lock`;
  let cache = null, cacheMtime = '', pending = [], timer = null, closed = false;
  const listeners = new Set();

  /* A write puts a new file in place, so its inode tells a new version even when the clock's tick has not moved the
     modification time. */
  function read() {
    let m = '';
    try { const st = fs.statSync(file); m = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch (_) { m = 'none'; }
    if (!cache || m !== cacheMtime) {
      cache = readFile(file);
      cacheMtime = m;
    }
    /* What is not written yet shows at once in this window. */
    if (!pending.length) return cache;
    const view = JSON.parse(JSON.stringify(cache));
    for (const op of pending) apply(view, op);
    return view;
  }

  function takeLock() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* the mkdir below says */ }
    try { fs.mkdirSync(lock); return true; } catch (_) { /* taken */ }
    try { if (now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); fs.mkdirSync(lock); return true; } } catch (_) { /* another took it */ }
    return false;
  }

  function flush() {
    timer = null;
    if (!pending.length) return true;
    if (!writable()) return false;
    if (!takeLock()) { if (!closed) timer = setTimeout(flush, RETRY_MS); return false; }
    try {
      const d = readFile(file);
      const ops = pending;
      for (const op of ops) apply(d, op);
      writeAtomic(file, JSON.stringify(d) + '\n');
      pending = pending.slice(ops.length);
      cache = null;
      return true;
    } catch (e) {
      log(`session list: writing ${file}: ${(e && e.message) || e}`);
      if (!closed) timer = setTimeout(flush, RETRY_MS * 10);
      return false;
    } finally {
      try { fs.rmdirSync(lock); } catch (_) { /* gone */ }
    }
  }

  function change(op) {
    pending.push(Object.assign({ at: now() }, op));
    if (!timer && !closed) timer = setTimeout(flush, 0);
    for (const fn of listeners) { try { fn(); } catch (_) { /* a listener's own trouble */ } }
  }

  if (label) change({ type: 'label', label });

  const keysOf = (list) => [...new Set((list || []).map((x) => (Array.isArray(x) ? keyOf(x[0], x[1]) : String(x))))];

  return {
    file,
    /* What the store has for one conversation. */
    record(sourceId, sessionId) {
      const r = read().s[keyOf(sourceId, sessionId)] || {};
      const v = (f, i = 0, d = null) => (Array.isArray(r[f]) ? r[f][i] : d);
      return { group: v('g'), archived: !!v('a'), archivedAt: v('a') ? v('a', 1, 0) : 0, pinned: !!v('p'), color: v('c'),
        seenAt: +r.r || 0, unreadMark: !!v('u') };
    },
    /* Every conversation the store has something for, as [sourceId, sessionId]. */
    keys: () => Object.keys(read().s).map((k) => { try { return JSON.parse(k); } catch (_) { return null; } }).filter(Boolean),
    /* The groups in the user's order, deleted ones left out. */
    groups() {
      const g = read().groups;
      return Object.keys(g).filter((id) => !g[id].del).map((id) => ({ id, name: g[id].n, order: +g[id].o || 0 }))
        .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    },
    /* Whether `id` names a group, deleted or not. */
    groupKnown: (id) => !!read().groups[id],
    imported: (sourceId) => +read().imported[sourceId] || 0,
    sweepAt: () => +read().sweepAt || 0,
    setGroup: (list, group) => change({ type: 'group', keys: keysOf(list), group: group || null }),
    /* Archiving moves it out of its group and, unless `keepPin`, unpins it; `since` is when it was archived, when known. */
    archive: (list, on, { since = 0, keepPin = false } = {}) => change({ type: 'archive', keys: keysOf(list), on: !!on, since: +since || 0, keepPin: !!keepPin }),
    pin: (list, on) => change({ type: 'pin', keys: keysOf(list), on: !!on }),
    color: (list, color) => change({ type: 'color', keys: keysOf(list), color: color || null }),
    seen: (sourceId, sessionId, replyAt) => change({ type: 'seen', key: keyOf(sourceId, sessionId), replyAt: +replyAt || 0 }),
    markUnread: (list, on) => change({ type: 'unread', keys: keysOf(list), on: !!on }),
    /* A new group, last; resolves to its id, or '' with no room left. */
    newGroup(name) {
      const have = this.groups();
      if (have.length >= GROUPS_MAX) return '';
      const id = crypto.randomUUID();
      change({ type: 'newGroup', id, name: cleanName(name) || 'New group', order: (have.length ? have[have.length - 1].order : 0) + 1 });
      return id;
    },
    renameGroup(id, name) { const n = cleanName(name); if (n) change({ type: 'renameGroup', id, name: n }); return !!n; },
    deleteGroup: (id) => change({ type: 'deleteGroup', id }),
    /* Puts group `id` before `before`, or last with no `before`. */
    moveGroup(id, before) {
      const list = this.groups().filter((g) => g.id !== id);
      const at = before ? list.findIndex((g) => g.id === before) : -1;
      list.splice(at < 0 ? list.length : at, 0, { id });
      list.forEach((g, i) => change({ type: 'orderGroup', id: g.id, order: i + 1 }));
    },
    markImported: (sourceId) => change({ type: 'imported', sourceId: String(sourceId) }),
    swept: () => change({ type: 'sweep' }),
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    flush,
    pending: () => pending.length,
    dispose() { closed = true; if (timer) clearTimeout(timer); timer = null; flush(); },
  };
}

module.exports = { createStore, projectOf, keyOf, cleanName, STORE_DIR, FORMAT, LOCK_STALE_MS, COLORS, NAME_MAX, GROUPS_MAX };
