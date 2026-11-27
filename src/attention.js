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
 * Only the window that has the focus shows notifications, so each conversation gets one on the screen however many
 * windows are open. Changes that come within BATCH_MS of each other are shown together, one notification for each
 * conversation. When a source reports why a conversation is waiting, the notification says so (src/wait-reason.js); a
 * window whose panel shows the prompt knows more than one that read a machine-wide list, so the most precise of the
 * reasons the windows report is kept.
 *
 * Each window marks `here` on its reports for conversations it shows, and reports them even once they have stopped
 * with nothing unseen. Where windows report one conversation differently, a report marked `here` wins over one that
 * is not: a machine-wide list can be half a minute old, and a wait it still reports after that window saw the wait end
 * would hide the next one, which then goes unannounced.
 *
 * The user is looking at the conversation the focused window shows in front, so it gets no notification and no count
 * in any window. One that window shows anywhere else, in a tab behind others or a side bar, gets no notification
 * either: the user is already in the window where it is answered, and its tab's dot and the count show it.
 *
 * A window without the focus keeps what it would have shown, and once it gets the focus shows, once, what of that still
 * needs the user. Every window notes in its file, with the time, each conversation it has told the user about or found
 * already in front of them. A window drops what it kept once another window has noted the same conversation since, so
 * the next window the user goes to does not show it again.
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
const waitReason = require('./wait-reason');

const ATTENTION_DIR = 'attention';
/* Items gained `activity` and `unseen` within format 1, so that a window of an older version still reads `state`. */
const FORMAT = 1;
/* A window writes its file at least this often, and a file older than STALE_MS is a window that has gone. */
const BEAT_MS = 20000;
const STALE_MS = 60000;
const BATCH_MS = 2000;
/* A window that reads a machine-wide list can hear of a permission prompt before the window whose panel shows it, and
   without the tool's name. A notification of such a prompt waits this long for that window to name the tool. */
const PRECISE_MS = 3000;
const STABLE_MS = 5000;
/* What a window reads in its first seconds was there before it started. */
const WARMUP_MS = 10000;
const REMEMBER_MS = 120000;
const HOLD_MS = 5000;
const MAX_ITEMS = 200;
const MAX_SEEN = 2000;
const MAX_TITLE = 120;
/* A window keeps its note that it told the user about a conversation this long: as long as another window may still
   hold a notification of it, kept while no window had the focus. */
const SETTLED_MS = 24 * 3600 * 1000;
/* With neither or both marked `here`, the report that needs the user most wins. */
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
 * unseen, unless this window shows them, for the reason given at the top of this file. `lists` is
 * [{ sourceId, label, conversations }]; `shown(item)` says whether this window shows that conversation, which marks
 * it `here`. Past MAX_ITEMS the ones that need the user are kept.
 */
const activeAt = (c) => (Number.isFinite(c.lastReplyAt) && c.lastReplyAt > 0 ? c.lastReplyAt : Number.isFinite(c.lastActiveAt) ? c.lastActiveAt : 0);
const unwritten = (activity, unseen) => !activity || (activity === 'stopped' && !unseen);

function itemsOf(lists, shown = () => false) {
  const out = [];
  for (const { sourceId, label, conversations } of lists || []) {
    for (const c of conversations || []) {
      if (!c || c.running === false || !c.sessionId) continue;
      const { activity, unseen } = reading(c);
      if (!activity) continue;
      const it = { sourceId: String(sourceId), source: clip(label, 40) || String(sourceId), sessionId: String(c.sessionId),
        state: STATES.includes(c.state) ? c.state : 'idle', activity, unseen, steward: c.steward === true, lastActiveAt: activeAt(c),
        title: clip(c.title, MAX_TITLE) || String(c.sessionId), cwd: typeof c.cwd === 'string' ? c.cwd : '',
        waitingFor: activity === 'waiting' ? waitReason.reasonOf(c.waitingFor) : null };
      let here = false;
      try { here = shown(it) === true; } catch (_) { here = false; }
      if (unwritten(activity, unseen) && !here) continue;
      if (here) it.here = true;
      out.push(it);
    }
  }
  const need = (it) => { const k = kindOf(it); return k === 'waiting' ? 0 : k ? 1 : 2; };
  return out.sort((a, b) => need(a) - need(b)).slice(0, MAX_ITEMS);
}

/*
 * Every live window's items, by key, each with `from` (the windows that reported it), `kind` and `waitingFor`. `live` is
 * the set of windows whose file is fresh; `front` maps each of them to the keys it shows in front while it has the focus;
 * `settled` maps each of them to the conversations it told the user about, key -> time.
 */
function readAll(dir, now, kept = null) {
  const merged = new Map(), live = new Set(), front = new Map(), settled = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return { merged, live, front, settled }; }
  /* On Windows a read can fail while that window renames its new copy into place; that read uses the kept copy
     instead, so the window's conversations stay in the union. */
  if (kept) for (const n of [...kept.keys()]) if (!names.includes(n)) kept.delete(n);
  for (const n of names) {
    if (!WINDOW.test(n)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (kept) kept.set(n, d); }
    catch (_) { d = kept ? kept.get(n) : null; if (!d) continue; }
    if (!d || d.format !== FORMAT || !Array.isArray(d.items) || !(now - d.at < STALE_MS)) continue;
    live.add(n);
    front.set(n, new Set((Array.isArray(d.front) ? d.front.slice(0, MAX_ITEMS) : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string').map((p) => keyOf(p[0], p[1]))));
    const notes = new Map();
    for (const p of Array.isArray(d.settled) ? d.settled.slice(0, MAX_ITEMS) : []) {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string' || !Number.isFinite(p[2])) continue;
      const k = keyOf(p[0], p[1]);
      if (!(notes.get(k) >= p[2])) notes.set(k, p[2]);
    }
    settled.set(n, notes);
    for (const raw of d.items.slice(0, MAX_ITEMS)) {
      if (!raw || typeof raw.sourceId !== 'string' || typeof raw.sessionId !== 'string') continue;
      const { activity, unseen, legacy } = reading(raw);
      if (!activity || (activity === 'stopped' && !unseen && raw.here !== true)) continue;
      const k = keyOf(raw.sourceId, raw.sessionId);
      const title = clip(raw.title, MAX_TITLE);
      const steward = typeof raw.steward === 'boolean' ? raw.steward : title.includes(titleMarks.CROWN);
      const it = { key: k, from: new Set([n]), sourceId: raw.sourceId, sessionId: raw.sessionId, source: clip(raw.source, 40) || raw.sourceId,
        title: titleMarks.withMarks(title, { steward }) || raw.sessionId, steward, cwd: typeof raw.cwd === 'string' ? raw.cwd : '', activity,
        unseen, legacy, here: raw.here === true, lastActiveAt: Number.isFinite(raw.lastActiveAt) ? raw.lastActiveAt : 0,
        waitingFor: activity === 'waiting' ? waitReason.reasonOf(raw.waitingFor) : null };
      const had = merged.get(k);
      if (!had) { merged.set(k, it); continue; }
      const one = it.here !== had.here;
      const win = one ? (it.here ? it : had) : RANK[activity] < RANK[had.activity] ? it : had;
      win.from = new Set([...had.from, n]);
      win.unseen = had.unseen || unseen;
      win.legacy = had.legacy && legacy;
      win.here = had.here || it.here;
      win.lastActiveAt = Math.max(had.lastActiveAt, it.lastActiveAt);
      win.waitingFor = win.activity !== 'waiting' ? null : one ? win.waitingFor : waitReason.better(had.waitingFor, it.waitingFor);
      merged.set(k, win);
    }
  }
  for (const it of merged.values()) it.kind = kindOf(it);
  return { merged, live, front, settled };
}

/* The text of the notification about conversation `it`. A waiting conversation's reason is named where the source gave
   one; `several` puts the source's name first. */
function message(it, { several }) {
  const name = `${several ? it.source + ': ' : ''}"${it.title}"`;
  return `${name} ${it.kind === 'waiting' ? waitReason.predicate(waitReason.reasonOf(it.waitingFor)) : 'finished'}.`;
}

/*
 * `lookedAt(item)` answers whether this window shows that conversation in front now, and `shownHere(item)` whether it
 * shows it in any tab or a side bar; `canWrite()` is false in Restricted Mode, where this window writes nothing;
 * `show(text, item)` puts up the notification for that conversation.
 */
function createAttention({ dir = path.join(sharedHome(), ATTENTION_DIR), windowId, now = Date.now, focused, lookedAt = () => false,
  shownHere = () => false, settings, canWrite = () => true, show, paint = () => {}, several = () => false, log = () => {},
  batchMs = BATCH_MS, warmupMs = WARMUP_MS, stableMs = STABLE_MS, preciseMs = PRECISE_MS }) {
  const ownName = `${windowId}.json`;
  const own = path.join(dir, ownName);
  const startedAt = now();
  let written = '', writtenAt = 0, union = null, timer = null, closed = false, hadFocus = false;
  const lastRead = new Map();
  /* key -> { kind, queuedAt }: what this window would have shown while it did not have the focus. */
  const missed = new Map();
  /* [sourceId, sessionId, at]: the conversations this window told the user about, newest last. */
  let told = [];
  /* key -> the latest time another live window told the user about that conversation, as of the last refresh. */
  let toldElsewhere = new Map();
  /* What this window last reported, and the keys it shows in front, sorted. */
  let ownItems = [], ownFront = [];
  /* The keys some window with the focus shows in front, as of the last refresh. */
  let looking = new Set();
  const pending = new Map();
  /* key -> { activity, kind, at, from, stoppedAt }: each conversation as last seen in the union. `stoppedAt` is when it
     stopped with an unread reply after working, until it is announced. */
  const last = new Map();
  /* key -> the newest lastActiveAt this window has read for that conversation. A turn that starts and ends between two
     reads is never seen working, and a newer lastActiveAt is what shows it ran. A source's lastReplyAt, when it gives one,
     is used instead, since a rename or a hook's note also makes a conversation active. */
  const activeSeen = new Map();

  const isFocused = () => { try { return focused() === true; } catch (_) { return false; } };
  /* key -> when this window stopped showing that conversation. Until a list of its source asked for after then is
     published, what the windows report for it can be the state from before, such as a wait the user answered just
     before closing its tab, so it is neither told nor counted; HOLD_MS bounds the wait. */
  const leftAt = new Map();
  let shownBefore = new Set();
  /* sourceId -> when the list in the last publish was asked for. */
  const askedAt = new Map();
  const held = (k) => leftAt.has(k);

  function write() {
    if (closed || !canWrite()) return;
    const front = ownFront.map((k) => JSON.parse(k));
    const text = JSON.stringify([ownItems, front, told]);
    if (text === written && now() - writtenAt < BEAT_MS) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(own, JSON.stringify({ format: FORMAT, at: now(), items: ownItems, front, settled: told }) + '\n', 0o600);
      written = text;
      writtenAt = now();
    } catch (e) { log('attention: writing ' + own + ': ' + ((e && e.message) || e)); }
  }

  const seeActive = (k, active) => {
    if (activeSeen.has(k) && !(active > activeSeen.get(k))) return;
    activeSeen.delete(k);
    activeSeen.set(k, active);
    if (activeSeen.size > MAX_SEEN) activeSeen.delete(activeSeen.keys().next().value);
  };

  function publish(lists) {
    if (closed) return;
    for (const l of lists || []) if (l && Number.isFinite(l.askedAt)) askedAt.set(String(l.sourceId), l.askedAt);
    /* A stopped conversation with nothing unseen is left out of this window's file, so its reply time is noted here from
       the list: marked unread later, it would otherwise look like a turn that ran between two reads. */
    for (const { sourceId, conversations } of lists || []) {
      for (const c of conversations || []) {
        if (!c || c.running === false || !c.sessionId) continue;
        const { activity, unseen } = reading(c);
        if (activity && unwritten(activity, unseen)) seeActive(keyOf(sourceId, c.sessionId), activeAt(c));
      }
    }
    if (!canWrite()) return;
    ownItems = itemsOf(lists, here);
    write();
  }

  const inFront = (it) => { try { return lookedAt(it) === true; } catch (_) { return false; } };
  const here = (it) => { try { return shownHere(it) === true; } catch (_) { return false; } };

  /* Notes in this window's file that the user has been told about `items`, or already had them in front of them. */
  function settle(items) {
    if (!items.length) return;
    const t = now(), keys = new Set(items.map((it) => it.key));
    told = told.filter((p) => t - p[2] < SETTLED_MS && !keys.has(keyOf(p[0], p[1])))
      .concat(items.map((it) => [it.sourceId, it.sessionId, t])).slice(-MAX_ITEMS);
    write();
  }

  /* Shows a notification for each of `items` that this window does not show and no focused window has in front; all of
     them count as told. */
  function tell(items) {
    settle(items);
    const fresh = items.filter((it) => !looking.has(it.key) && !inFront(it) && !here(it));
    if (!fresh.length) return;
    const named = several();
    for (const it of fresh) {
      try { show(message(it, { several: named }), it); } catch (e) { log('attention: showing: ' + ((e && e.message) || e)); }
    }
  }

  /* A notification uses what the windows report when it is shown, which can name a tool no window knew of when the
     change was first seen. */
  function flush() {
    timer = null;
    if (closed) return;
    const s = settings(), t = now();
    const items = [], later = [];
    for (const it of pending.values()) {
      const cur = union && union.get(it.key);
      if (!cur || cur.kind !== it.kind || s[it.kind] === false) continue;
      if (held(it.key)) { later.push(it); continue; }
      cur.queuedAt = it.queuedAt;
      if (cur.kind === 'waiting' && waitReason.detail(cur.waitingFor) === 1 && t - it.queuedAt < preciseMs) later.push(cur);
      else items.push(cur);
    }
    pending.clear();
    for (const it of later) pending.set(it.key, it);
    if (later.length) timer = setTimeout(flush, batchMs);
    if (!s.enabled || !items.length) return;
    if (isFocused()) { tell(items); return; }
    for (const it of items) {
      missed.delete(it.key);
      missed.set(it.key, { kind: it.kind, queuedAt: it.queuedAt });
      if (missed.size > MAX_ITEMS) missed.delete(missed.keys().next().value);
    }
  }

  /* On getting the focus, shows what this window kept while it had no focus, leaving out conversations that moved on
     since and those another window told the user about after they were kept. Each window reads the shared files on its own timer, so a window that told
     the user of a change can have done so up to a batch before this one saw it. */
  function replay() {
    if (!missed.size) return;
    const s = settings(), kept = [...missed.entries()];
    missed.clear();
    if (!s.enabled) return;
    const due = [];
    for (const [k, m] of kept) {
      const cur = union && union.get(k);
      if (!cur || cur.kind !== m.kind || s[m.kind] === false) continue;
      if (toldElsewhere.get(k) >= m.queuedAt - batchMs) continue;
      due.push(Object.assign({}, cur, { queuedAt: m.queuedAt }));
    }
    tell(due);
  }

  /* Reads every window's file and acts on what changed since the last read. Returns the union less the conversations
     the user is looking at. */
  function refresh() {
    if (closed) return [];
    const t = now();
    const { merged: next, live, front, settled } = readAll(dir, t, lastRead);
    const focus = isFocused();
    const mine = focus ? [...next.values()].filter((it) => it.kind && inFront(it)).map((it) => it.key).sort() : [];
    if (mine.join('\n') !== ownFront.join('\n')) { ownFront = mine; write(); }
    looking = new Set(mine);
    for (const [n, keys] of front) if (n !== ownName) for (const k of keys) looking.add(k);
    toldElsewhere = new Map();
    for (const [n, notes] of settled) {
      if (n === ownName) continue;
      for (const [k, at] of notes) if (!(toldElsewhere.get(k) >= at)) toldElsewhere.set(k, at);
    }
    const shownNow = new Set([...next.values()].filter((it) => here(it)).map((it) => it.key));
    for (const k of shownBefore) if (!shownNow.has(k) && next.has(k)) leftAt.set(k, t);
    for (const k of shownNow) leftAt.delete(k);
    shownBefore = shownNow;
    for (const [k, at] of leftAt) {
      const it = next.get(k), asked = it ? askedAt.get(String(it.sourceId)) || 0 : 0;
      if (!it || asked > at || t - at >= HOLD_MS) leftAt.delete(k);
    }
    const warm = t - startedAt >= warmupMs;
    const queue = (k, it) => {
      const had = pending.get(k);
      it.queuedAt = had ? had.queuedAt : t;
      pending.set(k, it);
      if (!timer) timer = setTimeout(flush, batchMs);
    };
    for (const [k, it] of next) {
      if (held(k)) continue;
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
      seeActive(k, it.lastActiveAt);
    }
    /* A conversation that left the union moved on if a window that reported it is still writing; if all its windows
       went, it is remembered for a while. */
    for (const [k, was] of last) {
      if (next.has(k)) continue;
      if ([...was.from].some((w) => live.has(w)) || t - was.at >= REMEMBER_MS) last.delete(k);
    }
    union = next;
    if (focus && !hadFocus) replay();
    hadFocus = focus;
    const all = [...next.values()].filter((it) => it.kind && !looking.has(it.key) && !held(it.key));
    try { paint(settings().enabled ? all : []); } catch (_) { /* the next refresh */ }
    return all;
  }

  function dispose() {
    closed = true;
    if (timer) clearTimeout(timer);
    if (written) { try { fs.unlinkSync(own); } catch (_) { /* gone */ } }
  }

  return { publish, refresh, dispose, items: () => (union ? [...union.values()].filter((it) => it.kind && !looking.has(it.key) && !held(it.key)) : []) };
}

module.exports = { createAttention, itemsOf, readAll, message, keyOf, kindOf, ATTENTION_DIR, FORMAT, BEAT_MS, STALE_MS, BATCH_MS, STABLE_MS,
  WARMUP_MS, REMEMBER_MS, SETTLED_MS, PRECISE_MS, HOLD_MS };
