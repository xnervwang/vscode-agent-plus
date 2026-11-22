// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Telling the user when a conversation in any VS Code window on this machine starts to wait for them (a permission
 * prompt, a choice, a question added to its plan since their last message), or stops with a reply they have not read.
 *
 * A source knows a permission prompt only in the window whose agent asked it, so each window writes what its sources
 * report to a file of its own in a folder every window reads, ATTENTION_DIR under sharedHome(): each running
 * conversation that has not stopped, and each stopped one with an unread reply, with its activity and whether it has
 * one.
 *
 * A conversation is announced when it starts to wait, and when it stops with an unread reply after working or after
 * its background work, once it has stayed that way for STABLE_MS: a turn followed at once by another, as a queued
 * message makes it, is not announced. A turn that ran between two reads counts as work when the conversation's
 * lastActiveAt is newer than any read before. An unread reply turning up on a conversation that had already stopped,
 * with nothing newer, is not announced.
 *
 * Only the window that has the focus shows a notification, so there is one on the screen however many windows are
 * open. Changes that come within BATCH_MS of each other are shown as one.
 *
 * The user is looking at the conversation the focused window shows in front, so it gets no notification and no count
 * in any window.
 *
 * A window of an older version writes `state` alone, and only `prompt` and `unread`, read here as waiting and as
 * stopped with an unread reply. Such a window never reports a turn running, so its unread reply is announced on
 * turning up, after the stable period, as that version announced it.
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic, sharedHome } = require('./files');
const { ACTIVITIES, STATES, activityOfState } = require('./sources');
const titleMarks = require('./title-marks');

const ATTENTION_DIR = 'attention';
/* Items gained `activity` and `unseen` within format 1, so that a window of an older version still reads `state`. */
const FORMAT = 1;
/* A window writes its file at least this often, and a file older than STALE_MS is a window that has gone. */
const BEAT_MS = 20000;
const STALE_MS = 60000;
const BATCH_MS = 2000;
const STABLE_MS = 5000;
/* What a window reads in its first seconds was there before it started. */
const WARMUP_MS = 10000;
const REMEMBER_MS = 120000;
const MAX_ITEMS = 200;
const MAX_SEEN = 2000;
const MAX_TITLE = 120;
/* When two windows report one conversation differently, the report that needs the user most wins. */
const RANK = { waiting: 0, working: 1, background: 2, stopped: 3 };
const WINDOW = /^[0-9a-z]+-[0-9a-f]{8}\.json$/;

const keyOf = (sourceId, sessionId) => JSON.stringify([String(sourceId), String(sessionId)]);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/* 'waiting', 'finished' (stopped with an unread reply) or '': how a conversation needs the user, which is also the name
   of the setting for it and of its wording. */
const kindOf = (it) => (it.activity === 'waiting' ? 'waiting' : it.activity === 'stopped' && it.unseen ? 'finished' : '');

/* The activity and unseen of a conversation or an item, worked out from `state` where it has none; `legacy` when it
   had no activity of its own, as an older window's items have not. */
function reading(c) {
  const state = STATES.includes(c.state) ? c.state : '';
  const own = ACTIVITIES.includes(c.activity);
  return { activity: own ? c.activity : state ? activityOfState(state) : '', unseen: typeof c.unseen === 'boolean' ? c.unseen : state === 'unread',
    legacy: !own };
}

/*
 * The running conversations of `lists` that other windows need to hear about: all but those stopped with no reply
 * unseen. `lists` is [{ sourceId, label, conversations }]. Past MAX_ITEMS the ones that need the user are kept.
 */
function itemsOf(lists) {
  const out = [];
  for (const { sourceId, label, conversations } of lists || []) {
    for (const c of conversations || []) {
      if (!c || c.running === false || !c.sessionId) continue;
      const { activity, unseen } = reading(c);
      if (!activity || (activity === 'stopped' && !unseen)) continue;
      out.push({ sourceId: String(sourceId), source: clip(label, 40) || String(sourceId), sessionId: String(c.sessionId),
        state: STATES.includes(c.state) ? c.state : 'idle', activity, unseen, steward: c.steward === true,
        lastActiveAt: Number.isFinite(c.lastActiveAt) ? c.lastActiveAt : 0,
        title: clip(c.title, MAX_TITLE) || String(c.sessionId), cwd: typeof c.cwd === 'string' ? c.cwd : '' });
    }
  }
  const need = (it) => { const k = kindOf(it); return k === 'waiting' ? 0 : k ? 1 : 2; };
  return out.sort((a, b) => need(a) - need(b)).slice(0, MAX_ITEMS);
}

/*
 * Every live window's items, by key, each with `from`, the windows that reported it, and `kind`. `live` is the set of
 * windows whose file is fresh; `front` maps each of them to the keys it shows in front while it has the focus.
 */
function readAll(dir, now) {
  const merged = new Map(), live = new Set(), front = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return { merged, live, front }; }
  for (const n of names) {
    if (!WINDOW.test(n)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (!d || d.format !== FORMAT || !Array.isArray(d.items) || !(now - d.at < STALE_MS)) continue;
    live.add(n);
    front.set(n, new Set((Array.isArray(d.front) ? d.front.slice(0, MAX_ITEMS) : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string').map((p) => keyOf(p[0], p[1]))));
    for (const raw of d.items.slice(0, MAX_ITEMS)) {
      if (!raw || typeof raw.sourceId !== 'string' || typeof raw.sessionId !== 'string') continue;
      const { activity, unseen, legacy } = reading(raw);
      if (!activity || (activity === 'stopped' && !unseen)) continue;
      const k = keyOf(raw.sourceId, raw.sessionId);
      const title = clip(raw.title, MAX_TITLE);
      const steward = typeof raw.steward === 'boolean' ? raw.steward : title.startsWith(titleMarks.CROWN);
      const it = { key: k, from: new Set([n]), sourceId: raw.sourceId, sessionId: raw.sessionId, source: clip(raw.source, 40) || raw.sourceId,
        title: titleMarks.withMarks(title, { steward }) || raw.sessionId, steward, cwd: typeof raw.cwd === 'string' ? raw.cwd : '', activity,
        unseen, legacy, lastActiveAt: Number.isFinite(raw.lastActiveAt) ? raw.lastActiveAt : 0 };
      const had = merged.get(k);
      if (!had) { merged.set(k, it); continue; }
      const win = RANK[activity] < RANK[had.activity] ? it : had;
      win.from = new Set([...had.from, n]);
      win.unseen = had.unseen || unseen;
      win.legacy = had.legacy && legacy;
      win.lastActiveAt = Math.max(had.lastActiveAt, it.lastActiveAt);
      merged.set(k, win);
    }
  }
  for (const it of merged.values()) it.kind = kindOf(it);
  return { merged, live, front };
}

/* The notification's text for `items`. */
function message(items, { several }) {
  const name = (it) => `${several ? it.source + ': ' : ''}"${it.title}"`;
  if (items.length === 1) {
    const it = items[0];
    return `${name(it)} ${it.kind === 'waiting' ? 'is waiting for you' : 'finished'}.`;
  }
  const waiting = items.filter((it) => it.kind === 'waiting').length;
  const parts = [];
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (items.length - waiting) parts.push(`${items.length - waiting} finished`);
  const shown = items.slice(0, 2).map(name).join(', ') + (items.length > 2 ? ` and ${items.length - 2} more` : '');
  return `${items.length} conversations need you (${parts.join(', ')}): ${shown}.`;
}

/*
 * `lookedAt(item)` answers whether this window shows that conversation in front now; `canWrite()` is false in Restricted
 * Mode, where this window writes nothing; `show(text, items)` shows a notification about `items`.
 */
function createAttention({ dir = path.join(sharedHome(), ATTENTION_DIR), windowId, now = Date.now, focused, lookedAt = () => false,
  settings, canWrite = () => true, show, paint = () => {}, several = () => false, log = () => {}, batchMs = BATCH_MS,
  warmupMs = WARMUP_MS, stableMs = STABLE_MS }) {
  const ownName = `${windowId}.json`;
  const own = path.join(dir, ownName);
  const startedAt = now();
  let written = '', writtenAt = 0, union = null, timer = null, closed = false;
  /* What this window last reported, and the keys it shows in front, sorted. */
  let ownItems = [], ownFront = [];
  /* The keys some window with the focus shows in front, as of the last refresh. */
  let looking = new Set();
  const pending = new Map();
  /* key -> { activity, kind, at, from, stoppedAt }: each conversation as last seen in the union. `stoppedAt` is when it
     stopped with an unread reply after working, until it is announced. */
  const last = new Map();
  /* key -> the newest lastActiveAt this window has read for that conversation. A turn that starts and ends between two
     reads is never seen working, and a newer lastActiveAt is what shows it ran. */
  const activeSeen = new Map();

  function write() {
    if (closed || !canWrite()) return;
    const front = ownFront.map((k) => JSON.parse(k));
    const text = JSON.stringify([ownItems, front]);
    if (text === written && now() - writtenAt < BEAT_MS) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(own, JSON.stringify({ format: FORMAT, at: now(), items: ownItems, front }) + '\n', 0o600);
      written = text;
      writtenAt = now();
    } catch (e) { log('attention: writing ' + own + ': ' + ((e && e.message) || e)); }
  }

  function publish(lists) {
    if (closed || !canWrite()) return;
    ownItems = itemsOf(lists);
    write();
  }

  const inFront = (it) => { try { return lookedAt(it) === true; } catch (_) { return false; } };

  function flush() {
    timer = null;
    if (closed) return;
    const s = settings();
    const items = [...pending.values()].filter((it) => {
      const cur = union && union.get(it.key);
      return cur && cur.kind === it.kind && s[it.kind] !== false;
    });
    pending.clear();
    if (!s.enabled || !items.length || !focused()) return;
    const fresh = items.filter((it) => !looking.has(it.key) && !inFront(it));
    if (!fresh.length) return;
    try { show(message(fresh, { several: several() }), fresh); } catch (e) { log('attention: showing: ' + ((e && e.message) || e)); }
  }

  /* Reads every window's file and acts on what changed since the last read. Returns the union less the conversations
     the user is looking at. */
  function refresh() {
    if (closed) return [];
    const t = now();
    const { merged: next, live, front } = readAll(dir, t);
    const mine = focused() ? [...next.values()].filter((it) => it.kind && inFront(it)).map((it) => it.key).sort() : [];
    if (mine.join('\n') !== ownFront.join('\n')) { ownFront = mine; write(); }
    looking = new Set(mine);
    for (const [n, keys] of front) if (n !== ownName) for (const k of keys) looking.add(k);
    const warm = t - startedAt >= warmupMs;
    const queue = (k, it) => { pending.set(k, it); if (!timer) timer = setTimeout(flush, batchMs); };
    for (const [k, it] of next) {
      const was = last.get(k);
      const seenActive = activeSeen.has(k) ? activeSeen.get(k) : startedAt + warmupMs;
      const rec = { activity: it.activity, kind: it.kind, at: t, from: it.from, stoppedAt: 0 };
      if (it.kind === 'waiting') {
        if (warm && !(was && was.kind === 'waiting' && t - was.at < REMEMBER_MS)) queue(k, it);
      } else if (it.kind === 'finished') {
        const worked = (!!was && (was.activity === 'working' || was.activity === 'background')) || it.lastActiveAt > seenActive;
        if (was && was.stoppedAt) rec.stoppedAt = was.stoppedAt;
        else if (warm && (!was || was.kind !== 'finished') && (worked || it.legacy)) rec.stoppedAt = t;
        if (rec.stoppedAt && t - rec.stoppedAt >= stableMs) { rec.stoppedAt = 0; queue(k, it); }
      }
      last.set(k, rec);
      if (!activeSeen.has(k) || it.lastActiveAt > activeSeen.get(k)) {
        activeSeen.delete(k);
        activeSeen.set(k, it.lastActiveAt);
        if (activeSeen.size > MAX_SEEN) activeSeen.delete(activeSeen.keys().next().value);
      }
    }
    /* A conversation that left the union moved on if a window that reported it is still writing; if all its windows
       went, it is remembered for a while. */
    for (const [k, was] of last) {
      if (next.has(k)) continue;
      if ([...was.from].some((w) => live.has(w)) || t - was.at >= REMEMBER_MS) last.delete(k);
    }
    union = next;
    const all = [...next.values()].filter((it) => it.kind && !looking.has(it.key));
    try { paint(settings().enabled ? all : []); } catch (_) { /* the next refresh */ }
    return all;
  }

  function dispose() {
    closed = true;
    if (timer) clearTimeout(timer);
    if (written) { try { fs.unlinkSync(own); } catch (_) { /* gone */ } }
  }

  return { publish, refresh, dispose, items: () => (union ? [...union.values()].filter((it) => it.kind && !looking.has(it.key)) : []) };
}

module.exports = { createAttention, itemsOf, readAll, message, keyOf, kindOf, ATTENTION_DIR, FORMAT, BEAT_MS, STALE_MS, BATCH_MS, STABLE_MS,
  WARMUP_MS, REMEMBER_MS };
