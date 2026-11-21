// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Telling the user when a conversation in any VS Code window on this machine finishes a turn (its source reports
 * `unread`, a red dot) or stops for them (`prompt`, a blue dot).
 *
 * A source knows a permission prompt only in the window whose agent asked it, so each window writes what its sources
 * report in those two states to a file of its own in a folder every window reads, ATTENTION_DIR under sharedHome().
 * Their union is the set of conversations that need the user. A conversation that enters the union, or
 * moves from one of the two states to the other, is announced.
 *
 * Only the window that has the focus shows a notification, so there is one on the screen however many windows are
 * open. Changes that come within BATCH_MS of each other are
 * shown as one. A notification is closed, from whichever window showed it, once none of its conversations is in that
 * state any more: the user has looked at it in some window, or it moved on. Every window counts the union in its
 * status bar.
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic, sharedHome } = require('./files');

const ATTENTION_DIR = 'attention';
const FORMAT = 1;
/* A window writes its file at least this often, and a file older than STALE_MS is a window that has gone. */
const BEAT_MS = 20000;
const STALE_MS = 60000;
const BATCH_MS = 2000;
/* What a window reads in its first seconds was there before it started. */
const WARMUP_MS = 10000;
const REMEMBER_MS = 120000;
const MAX_ITEMS = 200;
const MAX_TITLE = 120;
/* The setting and the wording for each state. */
const KIND = { prompt: 'waiting', unread: 'finished' };
const WINDOW = /^[0-9a-z]+-[0-9a-f]{8}\.json$/;

const keyOf = (sourceId, sessionId) => JSON.stringify([String(sourceId), String(sessionId)]);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/* The running conversations of `lists` in one of the two states. `lists` is [{ sourceId, label, conversations }]. */
function itemsOf(lists) {
  const out = [];
  for (const { sourceId, label, conversations } of lists || []) {
    for (const c of conversations || []) {
      if (!c || c.running === false || !KIND[c.state] || !c.sessionId) continue;
      out.push({ sourceId: String(sourceId), source: clip(label, 40) || String(sourceId), sessionId: String(c.sessionId),
        state: c.state, title: clip(c.title, MAX_TITLE) || String(c.sessionId), cwd: typeof c.cwd === 'string' ? c.cwd : '' });
      if (out.length >= MAX_ITEMS) return out;
    }
  }
  return out;
}

/*
 * Every live window's items, by key, each with `from`, the windows that reported it. A permission prompt outranks an
 * unread reply when two windows disagree. `live` is the set of windows whose file is fresh.
 */
function readAll(dir, now) {
  const merged = new Map(), live = new Set();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return { merged, live }; }
  for (const n of names) {
    if (!WINDOW.test(n)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (!d || d.format !== FORMAT || !Array.isArray(d.items) || !(now - d.at < STALE_MS)) continue;
    live.add(n);
    for (const it of d.items.slice(0, MAX_ITEMS)) {
      if (!it || !KIND[it.state] || typeof it.sourceId !== 'string' || typeof it.sessionId !== 'string') continue;
      const k = keyOf(it.sourceId, it.sessionId);
      const had = merged.get(k);
      if (!had || (had.state !== 'prompt' && it.state === 'prompt')) merged.set(k, Object.assign({ key: k, from: new Set(had ? had.from : []) }, it));
      merged.get(k).from.add(n);
    }
  }
  return { merged, live };
}

/* The notification's text for `items`. `open` and `list` give the command URIs of its links. */
function message(items, { several, open, list }) {
  const name = (it) => `${several ? it.source + ': ' : ''}"${it.title}"`;
  if (items.length === 1) {
    const it = items[0];
    return `${name(it)} ${it.state === 'prompt' ? 'is waiting for you' : 'finished'}. [Open](${open(it)})`;
  }
  const waiting = items.filter((it) => it.state === 'prompt').length;
  const parts = [];
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (items.length - waiting) parts.push(`${items.length - waiting} finished`);
  const shown = items.slice(0, 2).map(name).join(', ') + (items.length > 2 ? ` and ${items.length - 2} more` : '');
  return `${items.length} conversations need you (${parts.join(', ')}): ${shown}. [Show them](${list()})`;
}

/*
 * `lookedAt(item)` answers whether this window shows that conversation in front now; `canWrite()` is false in Restricted
 * Mode, where this window writes nothing; `show(text)` opens a notification and returns { update(text), close() }.
 */
function createAttention({ dir = path.join(sharedHome(), ATTENTION_DIR), windowId, now = Date.now, focused, lookedAt = () => false,
  settings, canWrite = () => true, show, paint = () => {}, links, several = () => false, log = () => {}, batchMs = BATCH_MS,
  warmupMs = WARMUP_MS }) {
  const own = path.join(dir, `${windowId}.json`);
  const startedAt = now();
  let written = '', writtenAt = 0, union = null, timer = null, closed = false;
  const pending = new Map();
  const shown = [];
  /* key -> { state, at, from }: each conversation as last seen in the union. */
  const last = new Map();

  function publish(lists) {
    if (closed || !canWrite()) return;
    const items = itemsOf(lists);
    const text = JSON.stringify(items);
    if (text === written && now() - writtenAt < BEAT_MS) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(own, JSON.stringify({ format: FORMAT, at: now(), items }) + '\n', 0o600);
      written = text;
      writtenAt = now();
    } catch (e) { log('attention: writing ' + own + ': ' + ((e && e.message) || e)); }
  }

  function flush() {
    timer = null;
    if (closed) return;
    const s = settings();
    const items = [...pending.values()].filter((it) => {
      const cur = union && union.get(it.key);
      return cur && cur.state === it.state && s[KIND[it.state]] !== false;
    });
    pending.clear();
    if (!s.enabled || !items.length || !focused()) return;
    const fresh = items.filter((it) => { try { return !lookedAt(it); } catch (_) { return true; } });
    if (!fresh.length) return;
    const text = message(fresh, { several: several(), open: links.open, list: links.list });
    let handle = null;
    try { handle = show(text); } catch (e) { log('attention: showing: ' + ((e && e.message) || e)); }
    if (handle) shown.push({ items: new Map(fresh.map((it) => [it.key, it.state])), handle });
  }

  /* Reads every window's file and acts on what changed since the last read. Returns the union, newest first. */
  function refresh() {
    if (closed) return [];
    const t = now();
    const { merged: next, live } = readAll(dir, t);
    const warm = t - startedAt >= warmupMs;
    for (const [k, it] of next) {
      const was = last.get(k);
      last.set(k, { state: it.state, at: t, from: it.from });
      if (!warm || (was && was.state === it.state && t - was.at < REMEMBER_MS)) continue;
      pending.set(k, it);
      if (!timer) timer = setTimeout(flush, batchMs);
    }
    /* A conversation that left the union moved on if a window that reported it is still writing; if all its windows
       went, it is remembered for a while. */
    for (const [k, was] of last) {
      if (next.has(k)) continue;
      if ([...was.from].some((w) => live.has(w)) || t - was.at >= REMEMBER_MS) last.delete(k);
    }
    union = next;
    for (let i = shown.length - 1; i >= 0; i--) {
      const n = shown[i];
      for (const [k, state] of [...n.items]) { const cur = next.get(k); if (!cur || cur.state !== state) n.items.delete(k); }
      if (!n.items.size) { try { n.handle.close(); } catch (_) { /* gone */ } shown.splice(i, 1); continue; }
      const left = [...n.items.keys()].map((k) => next.get(k));
      try { n.handle.update(message(left, { several: several(), open: links.open, list: links.list })); } catch (_) { /* gone */ }
    }
    const all = [...next.values()];
    try { paint(settings().enabled ? all : []); } catch (_) { /* the next refresh */ }
    return all;
  }

  /* Takes a conversation out of the notifications showing it, as when the user opens it from one. */
  function dismiss(key) {
    for (let i = shown.length - 1; i >= 0; i--) {
      const n = shown[i];
      if (!n.items.delete(key)) continue;
      if (!n.items.size) { try { n.handle.close(); } catch (_) { /* gone */ } shown.splice(i, 1); continue; }
      const left = [...n.items.keys()].map((k) => union && union.get(k)).filter(Boolean);
      try { n.handle.update(message(left, { several: several(), open: links.open, list: links.list })); } catch (_) { /* gone */ }
    }
  }

  function dispose() {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const n of shown.splice(0)) { try { n.handle.close(); } catch (_) { /* gone */ } }
    if (written) { try { fs.unlinkSync(own); } catch (_) { /* gone */ } }
  }

  return { publish, refresh, dismiss, dispose, items: () => (union ? [...union.values()] : []), _shown: shown };
}

module.exports = { createAttention, itemsOf, readAll, message, keyOf, ATTENTION_DIR, FORMAT, BEAT_MS, STALE_MS, BATCH_MS, WARMUP_MS, REMEMBER_MS };
