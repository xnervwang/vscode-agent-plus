// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversation sources registered by other extensions through `agentWorkPlan.registerSource()` (docs/protocol.md). A
 * source object belongs to another extension but runs in this process, so every read and call on it goes through get()
 * or call(), and nothing it does may throw out of here.
 *
 * No editor API here: the tests load this file directly.
 */

/* The protocol major this build implements, the source majors it accepts, and the optional host capabilities it offers.
   package.json repeats them under "agentWorkPlan" so they can be read without running this code; the tests hold the two
   together. The extension's marketplace major is PROTOCOL. */
const PROTOCOL = 1;
const ACCEPTS = [1];
const FEATURES = [];
/* A source never reports `needs`; the host derives it from the questions in the plan. */
const STATES = ['prompt', 'working', 'unread', 'idle'];
const MAX_ID = 200;
const MAX_CONVERSATIONS = 2000;

/* Why a registration was refused, as `code` in the result of registerSource(). */
const REFUSED = {
  shape: 'shape',
  coreTooOld: 'core-too-old',
  sourceTooOld: 'source-too-old',
  id: 'id',
  duplicate: 'duplicate',
  closing: 'closing',
  failed: 'failed',
};

/* A getter can throw or return a different value on each read, so each property is read once and that value is used. */
const get = (o, key) => { try { return o == null ? undefined : o[key]; } catch (_) { return undefined; } };
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/* Ids are used exactly as given, so one that would need changing is rejected. encodeURIComponent() throws on an
   unpaired surrogate. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const usableId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && v === v.trim() && !LONE_SURROGATE.test(v);
/* encodeURIComponent() never produces "%u", so the fallback output cannot collide with it. */
const keyPart = (v) => {
  const str = String(v);
  try { return encodeURIComponent(str); } catch (_) {
    let out = '';
    for (let i = 0; i < str.length; i++) out += '%u' + str.charCodeAt(i).toString(16).padStart(4, '0');
    return out;
  }
};
/* String() throws for a symbol, or for an object whose toString() throws. */
const say = (v) => {
  try { return typeof v === 'string' ? JSON.stringify(v) : typeof v === 'bigint' ? String(v) + 'n' : String(v); } catch (_) { return 'that value'; }
};

/* Same shape as vscode.Event. */
function emitter() {
  const listeners = new Set();
  return {
    event(listener, thisArgs, disposables) {
      const fn = (v) => listener.call(thisArgs, v);
      listeners.add(fn);
      const d = { dispose: () => { listeners.delete(fn); } };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    },
    fire(v) {
      for (const fn of [...listeners]) { try { fn(v); } catch (_) { /* the other listeners still run */ } }
    },
    dispose() { listeners.clear(); },
  };
}

function idOf(source) {
  const id = get(source, 'id');
  return usableId(id) ? id : '';
}

/*
 * Whether a source speaking `protocol` can register with a host accepting `accepts`, and if not, which side is behind.
 * A protocol above every accepted major is newer than this host; one below them all is a major this host has dropped.
 */
function verdict(protocol, accepts = ACCEPTS) {
  if (!Number.isInteger(protocol) || protocol < 1) return REFUSED.shape;
  if (accepts.includes(protocol)) return '';
  return protocol > Math.max(...accepts) ? REFUSED.coreTooOld : REFUSED.sourceTooOld;
}

/* { code, why }, with an empty code when the source can register. */
function refusal(source, accepts = ACCEPTS, id = idOf(source)) {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return { code: REFUSED.shape, why: 'a source is an object' };
  const protocol = get(source, 'protocol');
  const v = verdict(protocol, accepts);
  if (v === REFUSED.shape) return { code: v, why: `protocol ${say(protocol)} is not a protocol major` };
  if (v) return { code: v, why: `protocol ${say(protocol)} is not one this host accepts (${accepts.join(', ')})` };
  if (!id) return { code: REFUSED.id, why: `a source needs an id: a string of 1 to ${MAX_ID} characters with no space at either end` };
  return { code: '', why: '' };
}

function supports(source, name) {
  const features = get(source, 'features');
  try { return Array.isArray(features) && features.includes(name); } catch (_) { return false; }
}

/* For members added after protocol 1: called only when the source lists them in `features`. */
function optional(source, name) {
  if (!supports(source, name)) return null;
  const fn = get(source, name);
  return typeof fn === 'function' ? (...args) => fn.apply(source, args) : null;
}

function call(source, name, args, fallback) {
  const fn = get(source, name);
  if (typeof fn !== 'function') return fallback;
  try { return fn.apply(source, args || []); } catch (_) { return fallback; }
}

function listen(source, name, listener) {
  const ev = get(source, name);
  if (typeof ev !== 'function') return null;
  try {
    const d = ev.call(source, listener);
    const dispose = get(d, 'dispose');
    return typeof dispose === 'function' ? { dispose: () => { try { dispose.call(d); } catch (_) { /* already disposed */ } } } : null;
  } catch (_) { return null; }
}

function labelOf(source) {
  return text(get(source, 'label'), 80) || idOf(source);
}

function extensionOf(source) {
  const id = get(source, 'extensionId');
  return typeof id === 'string' && /^[\w-]+\.[\w-]+$/.test(id) ? id : '';
}

function logoOf(source) {
  const logo = get(source, 'logo');
  const file = (u) => { const f = get(u, 'fsPath'); return typeof f === 'string' && f ? f : ''; };
  const light = file(get(logo, 'light')), dark = file(get(logo, 'dark'));
  if (!light && !dark) return null;
  return { light: light || dark, dark: dark || light };
}

function planFileOf(source, sessionId) {
  const f = call(source, 'planPath', [sessionId], null);
  return typeof f === 'string' && f ? f : '';
}

function planDirOf(source) {
  const d = call(source, 'planDir', [], null);
  return typeof d === 'string' && d ? d : '';
}

/* The notice a source wants above its plan (a missing plugin, no Python), or null. */
function noticeOf(source) {
  const n = call(source, 'planNotice', [], null);
  if (!n || typeof n !== 'object') return null;
  const title = text(get(n, 'title'), 120);
  if (!title) return null;
  const command = get(n, 'command');
  const args = get(n, 'arguments');
  return {
    title,
    description: text(get(n, 'description'), 120),
    detail: text(get(n, 'detail'), 2000),
    command: typeof command === 'string' && command.length <= 200 ? command : '',
    arguments: Array.isArray(args) ? args.slice(0, 8) : [],
  };
}

/* The reader's IANA time zone as the source knows it, or ''. */
function timeZoneOf(source) {
  const z = call(source, 'timeZone', [], '');
  return typeof z === 'string' && z.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(z) ? z : '';
}

function conversation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = get(raw, 'sessionId');
  if (!usableId(sessionId)) return null;
  const title = get(raw, 'title'), cwd = get(raw, 'cwd'), state = get(raw, 'state'), running = get(raw, 'running');
  const hasPlan = get(raw, 'hasPlan');
  let at = get(raw, 'lastActiveAt');
  if (typeof at === 'string') at = Date.parse(at);
  return {
    sessionId,
    title: typeof title === 'string' ? title.slice(0, 500) : '',
    cwd: typeof cwd === 'string' ? cwd : '',
    state: STATES.includes(state) ? state : 'idle',
    running: running !== false,
    lastActiveAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0,
    hasPlan: hasPlan === true,
  };
}

function conversations(list, max = MAX_CONVERSATIONS) {
  const out = [];
  let n = 0;
  try { n = Array.isArray(list) ? Math.min(list.length, max) : 0; } catch (_) { n = 0; }
  for (let i = 0; i < n; i++) {
    let c = null;
    try { c = conversation(list[i]); } catch (_) { c = null; }
    if (c) out.push(c);
  }
  return out;
}

/*
 * Each registration gets its own entry object, so a result for an earlier registration of the same source can be told
 * apart. reserve() takes the id before the host calls into the source, so a source that registers itself again from one
 * of its own getters is rejected as a duplicate.
 */
class Registry {
  constructor({ accepts = ACCEPTS } = {}) {
    this.accepts = accepts;
    this.entries = [];
    this.reserved = new Map();
    this.changes = emitter();
    this.onDidChange = this.changes.event;
  }

  reserve(source, id = idOf(source)) {
    const r = refusal(source, this.accepts, id);
    if (r.code) return { ok: false, code: r.code, why: r.why, entry: null };
    if (this.get(id) || this.reserved.has(id)) {
      return { ok: false, code: REFUSED.duplicate, why: `a source with the id ${say(id)} is registered already`, entry: null };
    }
    const entry = { id, source, subs: [], list: null };
    this.reserved.set(id, entry);
    return { ok: true, code: '', why: '', entry };
  }

  release(entry) {
    if (this.reserved.get(entry.id) === entry) this.reserved.delete(entry.id);
  }

  commit(entry) {
    if (this.reserved.get(entry.id) !== entry) return () => {};
    this.reserved.delete(entry.id);
    this.entries.push(entry);
    this.changes.fire({ added: entry.id, entry });
    return () => {
      const i = this.entries.indexOf(entry);
      if (i < 0) return;
      this.entries.splice(i, 1);
      this.changes.fire({ removed: entry.id, entry });
    };
  }

  add(source, id = idOf(source)) {
    const r = this.reserve(source, id);
    if (!r.ok) return { ok: false, code: r.code, why: r.why, id: '', entry: null, remove() {} };
    return { ok: true, code: '', why: '', id, entry: r.entry, remove: this.commit(r.entry) };
  }

  clear() {
    this.entries = [];
    this.reserved.clear();
  }

  has(entry) {
    return this.entries.includes(entry);
  }

  get(id) {
    const e = this.entries.find((x) => x.id === id);
    return e ? e.source : null;
  }

  entry(id) {
    return this.entries.find((x) => x.id === id) || null;
  }

  all() {
    return this.entries.map((e) => e.source);
  }

  list() {
    return this.entries.slice();
  }

  get size() {
    return this.entries.length;
  }
}

/*
 * The conversation the work plan view shows: (sourceId, sessionId). The latest signal wins.
 *
 * sessionForTab() answers one of three ways: a session id (the tab is that conversation), '' (the tab is this source's
 * but has no conversation yet, such as a new one before its first message: the view shows nothing rather than the plan
 * of the conversation before), or anything else (not this source's tab, such as a file or a terminal: the view stays
 * where it was).
 */
class Focus {
  constructor() {
    this.sourceId = '';
    this.sessionId = '';
    this.tab = undefined;
    this.tabLabel = '';
    /* Set when the tab in front is a source's but has no conversation yet, so it is asked about again. */
    this.waiting = false;
    /* Every signal in the order it arrived. A focus report a source makes is taken a moment later, by which time a tab
       change may have happened, and the older report must not win. */
    this.signals = 0;
  }

  /** The number of the signal arriving now. Pass it to newerThan() when acting on it later. */
  mark() {
    return ++this.signals;
  }

  newerThan(n) {
    return this.signals !== n;
  }

  set(sourceId, sessionId) {
    const s = String(sourceId || ''), id = String(sessionId || '');
    if (s === this.sourceId && id === this.sessionId) return false;
    this.sourceId = s;
    this.sessionId = id;
    return true;
  }

  /* An empty session id means the source's front conversation went away. It clears the focus only if the focus belongs
     to that source: a tab of one agent closing behind another's leaves the other one in front. */
  report(sourceId, sessionId) {
    if (!sessionId && this.sourceId && this.sourceId !== sourceId) return false;
    return this.set(sourceId, sessionId);
  }

  /*
   * VS Code fires onDidChangeTabs for every label and state change. Offering the same tab each time would pull the focus
   * back to it after the user had switched to a sidebar conversation, so a tab is offered again only with `again`, or
   * when something about it says there is a new answer to be had.
   *
   * "The same tab" cannot stand on its own as "nothing to ask about": the extension host keeps one object per tab and
   * updates it in place, so a tab is the same object for its whole life (extHostEditorTabs.ts acceptTabOperation finds
   * the existing tab by id and only hands it a new dto; its frozen apiObject is built once). A new conversation's tab
   * answers '' until its first message and an id after it, without ever becoming a different object. So a tab is asked
   * again when its label has changed, and whenever the last answer about it was ''.
   */
  claim(tab, entries, again = false) {
    const label = (() => { const l = get(tab, 'label'); return typeof l === 'string' ? l : ''; })();
    if (!again && tab === this.tab && label === this.tabLabel && !this.waiting) return false;
    this.tab = tab;
    this.tabLabel = label;
    this.waiting = false;
    this.mark();
    if (!tab) return false;
    for (const { id: sourceId, source } of entries) {
      const id = call(source, 'sessionForTab', [tab], null);
      if (id === '') { this.waiting = true; return this.set(sourceId, ''); }
      if (usableId(id)) return this.set(sourceId, id);
    }
    return false;
  }

  drop(sourceId) {
    if (this.sourceId !== sourceId) return false;
    return this.set('', '');
  }
}

module.exports = {
  PROTOCOL, ACCEPTS, FEATURES, STATES, MAX_ID, MAX_CONVERSATIONS, REFUSED,
  emitter, get, idOf, usableId, keyPart, verdict, refusal, supports, optional, call, listen, labelOf, extensionOf, logoOf,
  planFileOf, planDirOf, noticeOf, timeZoneOf, conversation, conversations, Registry, Focus,
};
