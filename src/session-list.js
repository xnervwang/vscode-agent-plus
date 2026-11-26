// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's host side (docs/protocol.md, Session list). It reads every source that lists 'sessions', page by
 * page; works out which conversations this window shows, which one is in front, and which other windows show
 * (src/session-windows.js); keeps what the user does to them in the project's store (src/session-store.js); and hands
 * the page (src/page/session-list-page.js) a plain model built with the rules in src/session-rules.js.
 *
 * It also records what was closed in this window lately, marks a conversation's newest reply seen while it is in
 * front, imports what each source's own list had the first time the list runs for a project, and archives and deletes
 * on its own once an hour in one window of the project at a time.
 *
 * A source's list is read again when the source fires onDidChangeSessions, and every RELIST_MS besides. A source
 * whose list could not be read keeps its previous list, and the list says so above its rows; nothing of a source
 * whose list is not complete is archived or deleted on its own.
 */
const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const rules = require('./session-rules');
const { createStore, projectOf, keyOf, COLORS } = require('./session-store');
const { elsewhere: otherWindows, windowLabel } = require('./session-windows');
const { sharedHome } = require('./files');
const { withoutMarks } = require('./title-marks');
/* How long ago, as Claude Code's own session list writes it: now, then whole minutes, hours, days, months of 30 days
   and years. The same rule as agentPlusKit.age in shared/page/kit.js, which the package does not carry. */
function age(ms, now) {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24), mo = Math.floor(d / 30), y = Math.floor(d / 365);
  return y > 0 ? `${y}y` : mo > 0 ? `${mo}mo` : d > 0 ? `${d}d` : h > 0 ? `${h}h` : m > 0 ? `${m}m` : 'now';
}

const PAGE = 500;
const MAX_SESSIONS = 20000;
const PAGE_MS = 10000;
const ACTION_MS = 60000;
const RELIST_MS = 60000;
/* How long the conversation in front stays there before it counts as seen. */
const SEEN_AFTER_MS = 1500;
const SWEEP_EVERY_MS = 3600e3;
const SWEEP_LOCK_STALE_MS = 15 * 60e3;
const CLOSED_KEY = 'agentPlus.sessions.closed';
const CLOSED_KEEP = 50;
const LAST_NEW_KEY = 'agentPlus.sessions.lastNew';
const KINDS = ['user', 'background', 'subagent', 'empty'];
/* The theme colour of each title colour, as Claude Code Plus and Codex Plus draw them: VS Code has no chart colour for
   pink or cyan. */
const THEME_COLOR = { red: 'charts.red', blue: 'charts.blue', green: 'charts.green', yellow: 'charts.yellow', purple: 'charts.purple',
  orange: 'charts.orange', pink: 'terminal.ansiBrightMagenta', cyan: 'terminal.ansiCyan' };
const ELSEWHERE_KINDS = ['vscode', 'terminal', 'desktop', 'exec', 'other'];

/* A member the protocol gates on a feature of another name ('sessionImport' gives importSessions), bound to its source;
   null when the source does not list the feature or has no such method. */
function gated(source, feature, name) {
  if (!sources.supports(source, feature)) return null;
  const fn = sources.get(source, name);
  return typeof fn === 'function' ? (...args) => fn.apply(source, args) : null;
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const moment = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) && n > 0 ? n : 0; };
const lines = (v, max, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((x) => x.slice(0, n)) : []);

/* A Session as the protocol has it, with its limits, or null. */
function sessionOf(raw) {
  const c = sources.conversation(raw);
  if (!c) return null;
  const g = (k) => sources.get(raw, k);
  const kind = KINDS.includes(g('kind')) ? g('kind') : 'user';
  const parent = g('parentId');
  const elsewhere = (Array.isArray(g('elsewhere')) ? g('elsewhere') : []).slice(0, 8).map((e) => ({
    kind: ELSEWHERE_KINDS.includes(sources.get(e, 'kind')) ? sources.get(e, 'kind') : 'other',
    label: str(sources.get(e, 'label'), 80) || 'another program',
    detail: lines(sources.get(e, 'detail'), 6, 200), running: sources.get(e, 'running') === true,
  }));
  const badges = (Array.isArray(g('badges')) ? g('badges') : []).slice(0, 20)
    .map((b) => ({ text: str(sources.get(b, 'text'), 40), tooltip: str(sources.get(b, 'tooltip'), 300), dim: sources.get(b, 'dim') === true }))
    .filter((b) => b.text).slice(0, 2);
  const processes = Number(g('processes'));
  return Object.assign(c, {
    createdAt: moment(g('createdAt')), viewedAt: moment(g('viewedAt')), kind,
    parentId: sources.usableId(parent) && parent !== c.sessionId ? parent : '',
    branch: str(g('branch'), 200), worktree: str(g('worktree'), 100), detail: g('detail') !== false,
    elsewhere, processes: Number.isInteger(processes) && processes > 1 ? Math.min(processes, 99) : 0, badges, agentUnseen: g('unseen') === true,
    actions: (Array.isArray(g('actions')) ? g('actions') : []).filter((a) => typeof a === 'string').slice(0, 20),
    hover: lines(g('hover'), 6, 200),
  });
}

/* What `sessionActions` says a source can do, with nothing for what it leaves out. */
function capsOf(source) {
  let a = sources.get(source, 'sessionActions');
  if (typeof a === 'function') { try { a = a.call(source); } catch (_) { a = null; } }
  const places = (v) => (Array.isArray(v) ? v.filter((p) => p === 'tab' || p === 'sidebar') : []);
  const own = (Array.isArray(sources.get(a, 'own')) ? sources.get(a, 'own') : []).slice(0, 12)
    .map((o) => ({ id: str(sources.get(o, 'id'), 60), title: str(sources.get(o, 'title'), 80) })).filter((o) => o.id && o.title);
  return { open: places(sources.get(a, 'open')), create: places(sources.get(a, 'create')), rename: sources.get(a, 'rename') === true,
    delete: sources.get(a, 'delete') === true, own };
}

const settle = (p, ms, fallback) => new Promise((resolve) => {
  let done = false;
  const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
  Promise.resolve(p).then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } }, () => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } });
});

/* The results of an action in the protocol's shape, one per id asked about; anything missing is failed. */
function resultsOf(answer, ids, why) {
  const got = new Map();
  const list = sources.get(answer, 'results');
  for (const r of Array.isArray(list) ? list : []) {
    const id = sources.get(r, 'sessionId'), outcome = sources.get(r, 'outcome');
    if (typeof id !== 'string') continue;
    got.set(id, { sessionId: id, outcome: ['done', 'refused', 'failed'].includes(outcome) ? outcome : 'failed', reason: str(sources.get(r, 'reason'), 300) });
  }
  if (!ids.length) return [...got.values()];
  return ids.map((id) => got.get(id) || { sessionId: id, outcome: 'failed', reason: why || 'the agent did not answer' });
}

/*
 * `host` is { vscode, registry, say, trusted(), settings(), memento, globalMemento, asksOf(sourceId, session), open(target),
 * shared(name) }. `asksOf` says whether the conversation's plan asks the user a question put after their last
 * message; `open` brings another window's conversation forward (src/window-open.js).
 */
function createSessionList(host, { now = Date.now, pageMs = PAGE_MS, actionMs = ACTION_MS, relistMs = RELIST_MS } = {}) {
  const { vscode, registry, say = () => {} } = host;
  const shared = host.shared || ((name) => path.join(sharedHome(), name));
  const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => { try { return fs.realpathSync(f.uri.fsPath); } catch (_) { return f.uri.fsPath; } });
  const workspaceFile = () => { const f = vscode.workspace.workspaceFile; return f && f.scheme === 'file' ? f.fsPath : ''; };
  let project = projectOf(folders(), workspaceFile());
  let store = createStore({ dir: shared('session-list'), key: project.key, label: project.label, now, log: say, writable: () => !host.trusted || host.trusted() });
  const lists = new Map();
  const listeners = new Set();
  const dueListeners = new Set();
  const dueSig = new Map();
  let look = { here: new Set(), front: '', where: new Map() };
  /* sourceId -> the session id of that source last in front in this window, for its Account & usage part. */
  const lastFront = new Map();
  let rows = new Map();
  let modelValue = null;
  let closed = false;
  let timer = null;
  let pendingGroup = null;
  let elsewhereByKey = new Map();
  const queues = new Map();

  const settings = () => Object.assign({ archiveAfterDays: 14, deleteArchived: true, deleteAfterDays: 90, recentlyClosed: 10, hideBackground: true }, host.settings ? host.settings() : {});
  const entries = () => (registry.entries || []).filter((e) => sources.supports(e.source, 'sessions'));
  const fire = () => { for (const fn of listeners) { try { fn(); } catch (_) { /* the listener's own trouble */ } } };

  /* ── what this window shows ── */
  /*
   * The conversation in front is the active tab's, unless the source of that tab says another of its conversations is
   * (isFocused), as Codex Plus does for its sidebar shown after the tab; with no conversation tab active, the one a
   * source says is focused.
   */
  function lookNow() {
    const here = new Set(), where = new Map();
    let front = '', tabFront = null;
    const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
    const active = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;
    for (const e of entries()) {
      for (const g of groups) for (const t of g.tabs || []) {
        const id = sources.call(e.source, 'sessionForTab', [t], null);
        if (!sources.usableId(id)) continue;
        const k = keyOf(e.id, id);
        here.add(k); where.set(k, 'tab');
        if (g === active && t.isActive && !front) { front = k; tabFront = { e, id }; }
      }
      const list = lists.get(e.id);
      const shows = sources.optional(e.source, 'shows');
      for (const s of (list && list.sessions) || []) {
        const k = keyOf(e.id, s.sessionId);
        if (shows && !here.has(k)) { try { if (shows(s.sessionId) === true) { here.add(k); where.set(k, 'sidebar'); } } catch (_) { /* not shown */ } }
        if (!front && sources.call(e.source, 'isFocused', [s.sessionId], false) === true) front = k;
      }
    }
    if (tabFront && sources.call(tabFront.e.source, 'isFocused', [tabFront.id], true) === false) {
      const list = lists.get(tabFront.e.id);
      const other = ((list && list.sessions) || []).find((s) => s.sessionId !== tabFront.id && sources.call(tabFront.e.source, 'isFocused', [s.sessionId], false) === true);
      if (other) front = keyOf(tabFront.e.id, other.sessionId);
    }
    return { here, front, where };
  }

  /* Closed here: shown at the last look and not now, at the place it was shown; or as a source that tells its closings
     (onDidCloseSession) says. */
  function remember(gone, whereOf) {
    if (!gone.length) return;
    const list = (host.memento && host.memento.get(CLOSED_KEY)) || [];
    const at = now();
    const add = gone.map((k) => { const r = rows.get(k); const [s, id] = JSON.parse(k); return { k, s, id, title: r ? r.title : '', where: whereOf(k) || 'tab', at }; });
    const keep = add.concat(list.filter((c) => !gone.includes(c.k))).slice(0, CLOSED_KEEP);
    if (host.memento) Promise.resolve(host.memento.update(CLOSED_KEY, keep)).catch(() => {});
    if (host.closed) { try { host.closed(gone); } catch (_) { /* the host's own trouble */ } }
  }
  const tellsClosings = (sourceId) => { const e = entryOf(sourceId); return !!e && sources.supports(e.source, 'sessionClose'); };
  function noteClosed(was, next) {
    const gone = [...was.here].filter((k) => !next.here.has(k) && !tellsClosings(JSON.parse(k)[0]));
    remember(gone, (k) => was.where.get(k));
  }
  const closedList = () => ((host.memento && host.memento.get(CLOSED_KEY)) || []).filter((c) => c && typeof c.k === 'string');

  /* ── reading the sources ── */
  async function listOne(e) {
    const fn = gated(e.source, 'sessions', 'listSessions');
    if (!fn) return;
    const st = lists.get(e.id) || { sessions: [], problem: '', complete: false, at: 0, dirty: true };
    lists.set(e.id, st);
    st.dirty = false;
    const out = [];
    let cursor = null, pages = 0, problem = '';
    while (out.length < MAX_SESSIONS) {
      let answer;
      try { answer = await settle(fn({ folders: folders(), cursor, limit: PAGE }), pageMs, null); } catch (_) { answer = null; }
      const list = sources.get(answer, 'sessions');
      if (!Array.isArray(list)) { problem = `${sources.labelOf(e.source)} did not list its conversations in time`; break; }
      for (const raw of list) { const s = sessionOf(raw); if (s) out.push(s); if (out.length >= MAX_SESSIONS) break; }
      const next = sources.get(answer, 'cursor');
      cursor = typeof next === 'string' && next ? next : null;
      pages++;
      if (!cursor || pages >= 1000) break;
    }
    if (problem && out.length === 0 && st.sessions.length) { st.problem = problem; st.complete = false; return; }
    st.sessions = out;
    st.problem = problem;
    st.complete = !problem;
    st.at = now();
    await importOnce(e);
  }

  async function importOnce(e) {
    if (store.imported(e.id)) return;
    const fn = gated(e.source, 'sessionImport', 'importSessions');
    if (fn) {
      let got = null;
      try { got = await settle(fn({ folders: folders() }), pageMs, null); } catch (_) { got = null; }
      if (!got) return;
      /* Any id the source names, listed yet or not: one the source has not read yet when the list first sees it, as an
         archived conversation in a folder read later, would otherwise miss the one import it has. */
      const mine = (id) => sources.usableId(id);
      for (const a of Array.isArray(sources.get(got, 'archived')) ? sources.get(got, 'archived') : []) {
        const id = sources.get(a, 'sessionId');
        if (mine(id)) store.archive([[e.id, id]], true, { since: moment(sources.get(a, 'at')), keepPin: true });
      }
      const byName = new Map(store.groups().map((g) => [g.name.toLowerCase(), g.id]));
      for (const g of Array.isArray(sources.get(got, 'groups')) ? sources.get(got, 'groups') : []) {
        const name = str(sources.get(g, 'name'), 100).trim();
        const members = (Array.isArray(sources.get(g, 'sessionIds')) ? sources.get(g, 'sessionIds') : []).filter(mine);
        if (!name || !members.length) continue;
        let id = byName.get(name.toLowerCase());
        if (!id) { id = store.newGroup(name); if (!id) continue; byName.set(name.toLowerCase(), id); }
        const archived = new Set(members.filter((m) => store.record(e.id, m).archived));
        store.setGroup(members.filter((m) => !archived.has(m)).map((m) => [e.id, m]), id);
      }
      const pinned = (Array.isArray(sources.get(got, 'pinned')) ? sources.get(got, 'pinned') : []).filter(mine);
      if (pinned.length) store.pin(pinned.map((m) => [e.id, m]), true);
      const colors = sources.get(got, 'colors');
      if (colors && typeof colors === 'object') for (const id of Object.keys(colors)) if (mine(id) && COLORS.includes(colors[id])) store.color([[e.id, id]], colors[id]);
    }
    store.markImported(e.id);
  }

  /* ── rows ── */
  function build() {
    const next = new Map();
    const closedAt = new Map(closedList().map((c) => [c.k, c.at]));
    const s = settings();
    for (const e of entries()) {
      const st = lists.get(e.id);
      for (const x of (st && st.sessions) || []) {
        const k = keyOf(e.id, x.sessionId);
        const rec = store.record(e.id, x.sessionId);
        const others = elsewhereByKey.get(k) || [];
        /* A VS Code window the source names is one whose entry this window cannot see; one it can see is named here. */
        const elsewhere = others.map((w) => ({ kind: 'vscode', label: windowLabel(w), detail: [], running: false, known: true }))
          .concat(x.elsewhere.filter((y) => y.kind !== 'vscode' || !others.length));
        let asks = false;
        try { asks = !!(host.asksOf && host.asksOf(e.id, x)); } catch (_) { asks = false; }
        next.set(k, Object.assign({}, x, { key: k, sourceId: e.id, asks, here: look.here.has(k), elsewhere: look.here.has(k) ? [] : elsewhere,
          group: rec.group, archived: rec.archived, archivedAt: rec.archivedAt, pinned: rec.pinned, color: rec.color,
          seenAt: rec.seenAt, unreadMark: rec.unreadMark, closedAt: look.here.has(k) ? 0 : closedAt.get(k) || 0,
          hidden: s.hideBackground && x.kind !== 'user' }));
      }
    }
    rows = next;
  }

  /* When the list will delete each conversation, by source; a change is told (onDidChangeSessionDeletionDue). */
  function dueOf(sourceId) {
    const s = settings();
    const out = {};
    for (const r of rows.values()) if (r.sourceId === sourceId) out[r.sessionId] = rules.deleteDueAt(r, { days: +s.deleteAfterDays, on: s.deleteArchived !== false });
    return Object.freeze(out);
  }
  function tellDue() {
    for (const e of entries()) {
      const sig = JSON.stringify(dueOf(e.id));
      if (dueSig.get(e.id) === sig) continue;
      const had = dueSig.has(e.id);
      dueSig.set(e.id, sig);
      if (had) for (const fn of dueListeners) { try { fn({ sourceId: e.id }); } catch (_) { /* the listener's own trouble */ } }
    }
  }

  /* A source that keeps its own record of what was read hears what the list records (noteSeen). */
  function tellSeen(list, seen) {
    for (const e of entries()) {
      const ids = list.filter((r) => r.sourceId === e.id).map((r) => r.sessionId);
      const fn = ids.length ? gated(e.source, 'sessionSeen', 'noteSeen') : null;
      if (fn) { try { Promise.resolve(fn(ids, !!seen)).catch(() => {}); } catch (_) { /* the source keeps its own record as it is */ } }
    }
  }
  /* The conversation in front has been seen. */
  /*
   * The conversation in front is seen once it has stayed in front SEEN_AFTER_MS: a tab brought forward for a moment, as
   * a loader does to every restored tab, or passed over on the way to another, is not read. One the user marked unread
   * while it was in front stays unread until another comes to the front. A source's own `unseen` is the source's to
   * clear, as it does when the user looks at the conversation in its agent.
   */
  let frontKey = '', frontSince = 0, seenTimer = 0;
  const heldUnread = new Set();
  function markSeen() {
    const k = look.front || '';
    if (k !== frontKey) { frontKey = k; frontSince = now(); heldUnread.clear(); }
    const r = k && rows.get(k);
    if (!r || !r.detail || heldUnread.has(k) || !(r.lastReplyAt > r.seenAt || r.unreadMark)) return;
    const wait = SEEN_AFTER_MS - (now() - frontSince);
    if (wait > 0) {
      if (!seenTimer) seenTimer = setTimeout(() => { seenTimer = 0; schedule(0); }, wait + 20);
      return;
    }
    store.seen(r.sourceId, r.sessionId, r.lastReplyAt || 0);
    Object.assign(r, { seenAt: Math.max(+r.seenAt || 0, +r.lastReplyAt || 0), unreadMark: false });
    tellSeen([r], true);
  }

  /* A new conversation started for a group is put there once it shows in this window. */
  function placeNew() {
    if (!pendingGroup) return;
    if (now() - pendingGroup.at > 30 * 60e3) { pendingGroup = null; return; }
    const fresh = [...rows.values()].filter((r) => r.sourceId === pendingGroup.sourceId && r.createdAt >= pendingGroup.at - 2000 && !r.group && !r.archived)
      .sort((a, b) => (b.here - a.here) || (a.createdAt - b.createdAt));
    if (!fresh.length) return;
    store.setGroup([[fresh[0].sourceId, fresh[0].sessionId]], pendingGroup.groupId);
    pendingGroup = null;
  }

  /* ── archiving and deleting on their own ── */
  let sweeping = null;
  function sweepLock() {
    const dir = shared('session-list');
    const p = path.join(dir, `${project.key}.sweep`);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* the mkdir below says */ }
    try { fs.mkdirSync(p); return () => { try { fs.rmdirSync(p); } catch (_) { /* gone */ } }; } catch (_) { /* taken */ }
    try { if (now() - fs.statSync(p).mtimeMs > SWEEP_LOCK_STALE_MS) { fs.rmdirSync(p); fs.mkdirSync(p); return () => { try { fs.rmdirSync(p); } catch (_) { /* gone */ } }; } } catch (_) { /* another took it */ }
    return null;
  }
  /* `now` skips the hour since the last pass, as when the user has just changed when to archive or delete. */
  async function sweep({ now: soon = false } = {}) {
    if (sweeping || closed || !(host.trusted ? host.trusted() : true)) return { ran: false, why: 'busy or not trusted' };
    if (!soon && now() - store.sweepAt() < SWEEP_EVERY_MS) return { ran: false, why: 'done lately' };
    const release = sweepLock();
    if (!release) return { ran: false, why: 'another window is on it' };
    sweeping = (async () => {
      try {
        const s = settings();
        const groupIds = new Set(store.groups().map((g) => g.id));
        const archived = [], deleted = [], refused = [];
        for (const e of entries()) {
          const st = lists.get(e.id);
          if (!st || !st.complete) continue;
          const mine = [...rows.values()].filter((r) => r.sourceId === e.id);
          const due = mine.filter((r) => rules.archiveDue(r, { days: +s.archiveAfterDays, now: now(), groups: groupIds }));
          if (due.length) { store.archive(due.map((r) => [r.sourceId, r.sessionId]), true, { keepPin: true }); archived.push(...due); }
          const gone = mine.filter((r) => rules.deleteDue(r, { days: +s.deleteAfterDays, on: s.deleteArchived !== false, now: now() }));
          if (gone.length && capsOf(e.source).delete) {
            const results = await runAction(e, 'delete', gone.map((r) => r.sessionId), {});
            for (const r of results) (r.outcome === 'done' ? deleted : refused).push(Object.assign({ title: (rows.get(keyOf(e.id, r.sessionId)) || {}).title || r.sessionId }, r));
          }
        }
        store.swept();
        store.flush();
        if (archived.length) say(`session list: archived ${archived.length} conversation${archived.length === 1 ? '' : 's'} inactive for ${s.archiveAfterDays} days or more`);
        if (deleted.length) say(`session list: deleted ${deleted.length} archived conversation${deleted.length === 1 ? '' : 's'}: ${deleted.map((d) => `"${d.title}"`).join(', ')}`);
        if (refused.length) say(`session list: left alone ${refused.map((d) => `"${d.title}" (${d.reason || d.outcome})`).join(', ')}`);
        return { ran: true, archived: archived.length, deleted: deleted.length, refused: refused.length };
      } finally { release(); }
    })();
    try { return await sweeping; } finally { sweeping = null; }
  }

  /* ── actions ── */
  function runAction(e, action, ids, args) {
    const fn = sources.get(e.source, 'runSessionAction');
    /* Opening only reads; every other action waits for the workspace to be trusted. */
    if (typeof fn !== 'function' || (action !== 'open' && host.trusted && !host.trusted())) return Promise.resolve(resultsOf(null, ids, 'Agent Plus does nothing in Restricted Mode'));
    const prev = queues.get(e.id) || Promise.resolve();
    const go = prev.then(() => settle(Promise.resolve().then(() => fn.call(e.source, action, ids, args || {})), actionMs, null))
      .then((answer) => resultsOf(answer, ids, answer ? '' : 'the agent did not answer in time'));
    queues.set(e.id, go.catch(() => {}));
    return go;
  }

  const entryOf = (sourceId) => entries().find((e) => e.id === sourceId) || null;
  const tell = (text) => { try { vscode.window.showInformationMessage(text); } catch (_) { /* nothing to show it in */ } };
  const warn = (text) => { try { vscode.window.showWarningMessage(text); } catch (_) { /* nothing to show it in */ } };

  async function openRow(key, where) {
    const r = rows.get(key);
    if (!r) return 'gone';
    const e = entryOf(r.sourceId);
    if (!e) return 'gone';
    if (r.here) { await sources.call(e.source, 'reveal', [r.sessionId, { title: r.title, cwd: r.cwd }], false); return 'here'; }
    /* One another window shows is brought forward there. When that window does not answer it is not opened here as well,
       since two windows would then write the same conversation. */
    const vs = r.elsewhere.find((x) => x.kind === 'vscode');
    if (vs) {
      const got = host.open ? await host.open({ sourceId: r.sourceId, sessionId: r.sessionId, title: r.title, cwd: r.cwd }) : 'nowhere';
      if (got && got !== 'nowhere') return 'sent';
      tell(`"${r.title || r.sessionId}" is open in ${vs.label}, which did not answer. Close it there, or reload that window, to open it here.`);
      return 'elsewhere';
    }
    const out = r.elsewhere.find((x) => x.kind !== 'vscode');
    if (out) {
      tell(`"${r.title || r.sessionId}" is open in ${out.label}. Close it there first, so that two programs do not write the same conversation.`);
      return 'elsewhere';
    }
    const caps = capsOf(e.source);
    const closedWhere = (closedList().find((c) => c.k === key) || {}).where;
    const at = caps.open.includes(where) ? where : caps.open.includes(closedWhere) ? closedWhere : caps.open[0];
    if (!at) { warn(`${sources.labelOf(e.source)} cannot open conversations from this list.`); return 'nowhere'; }
    const [res] = await runAction(e, 'open', [r.sessionId], { where: at });
    if (res.outcome !== 'done') warn(`"${r.title || r.sessionId}" could not be opened: ${res.reason || res.outcome}`);
    return res.outcome;
  }

  async function create(sourceId, where, groupId) {
    const e = entryOf(sourceId);
    if (!e) return 'gone';
    const caps = capsOf(e.source);
    const at = caps.create.includes(where) ? where : caps.create[0];
    if (!at) return 'nowhere';
    if (host.globalMemento) Promise.resolve(host.globalMemento.update(LAST_NEW_KEY, { sourceId, where: at })).catch(() => {});
    const res = await runAction(e, 'create', [], { where: at });
    const made = res.find((x) => x.outcome === 'done');
    if (!made) { warn(`No new conversation: ${(res[0] && res[0].reason) || 'the agent did not start one'}`); return 'failed'; }
    if (groupId) {
      if (made.sessionId) store.setGroup([[sourceId, made.sessionId]], groupId);
      else pendingGroup = { sourceId, groupId, at: now() };
    }
    schedule();
    return 'done';
  }

  /* The agent and the half of the New bar picked last, without starting a conversation. */
  function chooseNew(sourceId, where) {
    if (!entryOf(sourceId) || !host.globalMemento) return;
    Promise.resolve(host.globalMemento.update(LAST_NEW_KEY, { sourceId, where: where === 'sidebar' ? 'sidebar' : 'tab' })).then(() => schedule(0), () => {});
  }

  async function rename(key, title) {
    const r = rows.get(key);
    const e = r && entryOf(r.sourceId);
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    if (!r || !e || !clean || clean === r.title) return 'nothing';
    const out = r.elsewhere.find((x) => x.running || x.kind !== 'vscode');
    if (out && rules.busy(r)) { tell(`"${r.title}" runs in ${out.label}, which would write its old title back. Rename it there.`); return 'refused'; }
    const [res] = await runAction(e, 'rename', [r.sessionId], { title: clean });
    if (res.outcome !== 'done') warn(`"${r.title}" was not renamed: ${res.reason || res.outcome}`);
    schedule();
    return res.outcome;
  }

  async function remove(keys) {
    const want = keys.map((k) => rows.get(k)).filter(Boolean);
    const blocked = want.map((r) => [r, rules.deleteBlocker(r)]).filter(([, why]) => why);
    const go = want.filter((r) => !rules.deleteBlocker(r));
    if (!go.length) { if (blocked.length) tell(`Not deleted: "${blocked[0][0].title}": ${blocked[0][1]}.`); return 'nothing'; }
    const lines2 = [];
    for (const e of entries()) {
      const mine = go.filter((r) => r.sourceId === e.id);
      if (!mine.length) continue;
      let what = null;
      const fn = sources.get(e.source, 'describeDeletion');
      if (typeof fn === 'function') { try { what = await settle(fn.call(e.source, mine.map((r) => r.sessionId)), pageMs, null); } catch (_) { what = null; } }
      const said = new Map((Array.isArray(what) ? what : []).map((w) => [sources.get(w, 'sessionId'), str(sources.get(w, 'what'), 300)]));
      for (const r of mine) lines2.push(`"${r.title || r.sessionId}" (${sources.labelOf(e.source)})${said.get(r.sessionId) ? `: ${said.get(r.sessionId)}` : ''}`);
    }
    if (blocked.length) lines2.push('', ...blocked.map(([r, why]) => `Left alone: "${r.title}": ${why}`));
    lines2.push('', 'This cannot be undone.');
    let pick;
    try {
      pick = await vscode.window.showWarningMessage(go.length === 1 ? `Delete "${go[0].title || go[0].sessionId}" from disk?` : `Delete ${go.length} conversations from disk?`,
        { modal: true, detail: lines2.join('\n') }, 'Delete');
    } catch (_) { pick = undefined; }
    if (pick !== 'Delete') return 'cancelled';
    const failed = [];
    for (const e of entries()) {
      const mine = go.filter((r) => r.sourceId === e.id && !rules.deleteBlocker(rows.get(r.key) || r));
      if (!mine.length) continue;
      for (const res of await runAction(e, 'delete', mine.map((r) => r.sessionId), {})) if (res.outcome !== 'done') failed.push(`"${(rows.get(keyOf(e.id, res.sessionId)) || {}).title || res.sessionId}": ${res.reason || res.outcome}`);
    }
    if (failed.length) warn(`Not deleted: ${failed.join('; ')}`);
    schedule();
    return failed.length ? 'partly' : 'done';
  }

  /* What the page asks for, by name. `keys` are the rows it acts on. */
  async function act(name, keys, pick) {
    const list = (keys || []).filter((k) => rows.has(k));
    const pairs = list.map((k) => JSON.parse(k));
    const ro = host.trusted && !host.trusted();
    switch (name) {
      case 'openTab': return list[0] && openRow(list[0], 'tab');
      case 'openSidebar': return list[0] && openRow(list[0], 'sidebar');
      case 'pin': if (!ro) store.pin(pairs, true); break;
      case 'unpin': if (!ro) store.pin(pairs, false); break;
      case 'color': if (!ro) store.color(pairs, COLORS.includes(pick) ? pick : null); break;
      case 'markUnread': store.markUnread(pairs, true); for (const k of list) if (k === look.front) heldUnread.add(k); tellSeen(list.map((k) => rows.get(k)), false); break;
      case 'markRead': for (const k of list) { const r = rows.get(k); store.seen(r.sourceId, r.sessionId, r.lastReplyAt || 0); } tellSeen(list.map((k) => rows.get(k)), true); break;
      case 'archive': if (!ro) store.archive(pairs, true); break;
      case 'unarchive': if (!ro) store.archive(pairs, false); break;
      case 'delete': if (!ro) return remove(list); break;
      case 'addToGroup': if (!ro && pick && store.groupKnown(pick)) store.setGroup(pairs.filter((p) => !store.record(...p).archived), pick); break;
      case 'removeFromGroup': if (!ro) store.setGroup(pairs, null); break;
      case 'newGroupFrom': if (!ro) { const id = store.newGroup('New group'); if (id) { store.setGroup(pairs.filter((p) => !store.record(...p).archived), id); fire(); return { renameGroup: id }; } } break;
      default:
        if (!ro && name.startsWith('own:')) {
          const id = name.slice(4);
          for (const e of entries()) {
            const mine = list.map((k) => rows.get(k)).filter((r) => r.sourceId === e.id && r.actions.includes(id));
            if (!mine.length) continue;
            for (const res of await runAction(e, id, mine.map((r) => r.sessionId), {})) if (res.outcome !== 'done') warn(`${res.reason || `"${id}" did not work`}`);
          }
        }
        break;
    }
    schedule(0);
    return 'done';
  }

  async function groupAct(name, groupId, pick) {
    if (host.trusted && !host.trusted()) return 'refused';
    const order = store.groups();
    const at = order.findIndex((g) => g.id === groupId);
    switch (name) {
      case 'newGroup': { const id = store.newGroup('New group'); schedule(0); return id ? { renameGroup: id } : 'full'; }
      case 'renameGroup': return 'rename';
      case 'moveGroupUp': if (at > 0) store.moveGroup(groupId, order[at - 1].id); break;
      case 'moveGroupDown': if (at >= 0 && at < order.length - 1) store.moveGroup(groupId, order[at + 2] ? order[at + 2].id : null); break;
      case 'deleteGroup': store.deleteGroup(groupId); break;
      case 'newInGroup': {
        const last = (host.globalMemento && host.globalMemento.get(LAST_NEW_KEY)) || {};
        return create(pick || last.sourceId, last.where, groupId);
      }
      default: return 'nothing';
    }
    schedule(0);
    return 'done';
  }

  /* ── the model ── */
  function menuItems() {
    const own = [];
    for (const e of entries()) for (const o of capsOf(e.source).own) own.push({ name: `own:${o.id}`, title: o.title, group: '7_own', when: `row && own_${o.id}` });
    return [
      { name: 'openTab', title: 'Open in Tab', group: '1_open', when: 'row && !here && canTab' },
      { name: 'openSidebar', title: 'Open in Sidebar', group: '1_open', when: 'row && !here && canSidebar' },
      { name: 'rename', title: 'Rename', group: '2_edit', when: 'row && renamable && !archived' },
      { name: 'color', title: 'Text Color', group: '2_edit', when: 'row', submenu: 'color' },
      { name: 'pin', title: 'Pin', group: '3_pin', when: 'row && !pinned && !archived', rows: 'pinnable', plural: 'Pin {n} Conversations' },
      { name: 'unpin', title: 'Unpin', group: '3_pin', when: 'row && pinned', rows: 'pinned', plural: 'Unpin {n} Conversations' },
      { name: 'newGroupFrom', title: 'New Group from Conversation', group: '4_group', when: 'row && !archived', plural: 'New Group from {n} Conversations', rows: 'groupable' },
      { name: 'addToGroup', title: 'Add to Group', group: '4_group', when: 'row && !archived', submenu: 'group' },
      { name: 'removeFromGroup', title: 'Remove from Group', group: '4_group', when: 'row && grouped', rows: 'grouped', plural: 'Remove {n} Conversations from Group' },
      { name: 'markUnread', title: 'Mark as Unread', group: '5_read', when: 'row && !unread' },
      { name: 'markRead', title: 'Mark as Read', group: '5_read', when: 'row && unread' },
      ...own,
      { name: 'archive', title: 'Archive', group: '8_archive', when: 'row && !archived', rows: 'archivable', plural: 'Archive {n} Conversations' },
      { name: 'unarchive', title: 'Unarchive', group: '8_archive', when: 'row && archived', rows: 'archived', plural: 'Unarchive {n} Conversations' },
      { name: 'delete', title: 'Delete...', group: '9_delete', when: 'row && archived', rows: 'deletable', plural: 'Delete {n} Conversations...' },
      { name: 'newInGroup', title: 'New Conversation in This Group', group: '1_new', when: 'group && made', submenu: 'agent' },
      { name: 'newGroup', title: 'New Group', group: '1_new', when: 'group' },
      { name: 'renameGroup', title: 'Rename Group', group: '2_group', when: 'group && made' },
      { name: 'moveGroupUp', title: 'Move Up', group: '2_group', when: 'group && made && !first' },
      { name: 'moveGroupDown', title: 'Move Down', group: '2_group', when: 'group && made && !last' },
      { name: 'deleteGroup', title: 'Delete Group', group: '9_delete', when: 'group && made' },
    ];
  }

  const DOT_WORDS = { blue: 'A dialog waits for you', red: 'Asked you a question and stopped', redRing: 'Asked you a question and is still working',
    green: 'A turn is running', greenRing: 'Background work is running', '': '' };

  function rowView(r, sectionLabel, depth) {
    const e = entryOf(r.sourceId);
    const caps = e ? capsOf(e.source) : { open: [], rename: false, delete: false };
    const dot = r.detail ? rules.dotOf(r) : '';
    const unread = r.detail && rules.unread(r);
    const why = rules.deleteBlocker(r);
    const span = r.lastActiveAt ? `${age(r.lastActiveAt, now())}` : '';
    const where = [];
    if (r.here) where.push(`Open in this window${look.where.get(r.key) === 'sidebar' ? ', in the sidebar' : ''}`);
    for (const x of r.elsewhere) { where.push(`${x.running ? 'Runs' : 'Open'} in ${x.label}`); for (const d of x.detail) where.push(`  ${d}`); }
    const hover = [`${sources.labelOf(e ? e.source : null)} · ${sectionLabel}`, `Session ID: ${r.sessionId}`,
      r.createdAt ? `Started ${stampOf(r.createdAt)}` : '', r.lastActiveAt ? `Last active ${stampOf(r.lastActiveAt)}` : '',
      DOT_WORDS[dot], ...where, r.processes ? `Open in ${r.processes} processes at once` : '', ...r.badges.map((b) => b.tooltip).filter(Boolean),
      ...r.hover].filter(Boolean);
    return {
      key: r.key, s: r.sourceId, id: r.sessionId, title: withoutMarks(r.title) || '(untitled)', time: span, detail: r.detail, dot, stripe: rules.stripeOf(r),
      color: THEME_COLOR[r.color] || '', pinned: r.pinned, unread, steward: r.steward,
      badges: r.badges, branch: r.branch, worktree: r.worktree, processes: r.processes, depth: depth || 0, hover: hover.join('\n'),
      archived: r.archived, grouped: !!(r.group && store.groupKnown(r.group) && store.groups().some((g) => g.id === r.group)),
      here: r.here, elsewhere: r.elsewhere.length > 0, away: awayOf(r.elsewhere), runs: rules.runs(r), needs: !!r.detail && rules.needsYou(r),
      ctx: { row: true, here: r.here, archived: r.archived, pinned: r.pinned, unread, renamable: caps.rename,
        grouped: !!r.group, canTab: caps.open.includes('tab'), canSidebar: caps.open.includes('sidebar'),
        ...Object.fromEntries(r.actions.map((a) => [`own_${a}`, true])) },
      archivable: !r.archived, pinnable: !r.pinned && !r.archived, groupable: !r.archived,
      deletable: !why && caps.delete, deleteWhy: why,
    };
  }

  /* What the row's end shows for where else it is open: 'window' for another VS Code window, 'terminal' for anything
     else (a terminal, a command-line run, a desktop app), '' for nowhere. */
  const awayOf = (places) => (!places.length ? '' : places.some((x) => x.kind === 'vscode') ? 'window' : 'terminal');
  function stampOf(ms) {
    if (!ms) return '?';
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* Background conversations, when shown, go straight under the conversation that started them. */
  function nest(list) {
    const byParent = new Map();
    const keys = new Set(list.map((r) => r.sessionId + '\n' + r.sourceId));
    const top = [];
    for (const r of list) {
      if (r.kind !== 'user' && r.parentId && keys.has(r.parentId + '\n' + r.sourceId)) {
        const k = r.parentId + '\n' + r.sourceId;
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(r);
      } else top.push(r);
    }
    const out = [];
    const walk = (r, depth) => { out.push([r, depth]); for (const c of (byParent.get(r.sessionId + '\n' + r.sourceId) || []).sort((a, b) => a.createdAt - b.createdAt)) walk(c, Math.min(depth + 1, 3)); };
    for (const r of top) walk(r, 0);
    return out;
  }

  function buildModel() {
    const s = settings();
    const visible = [...rows.values()].filter((r) => !r.hidden);
    const groups = store.groups().map((g, i, all) => ({ id: g.id, name: g.name, made: true, first: i === 0, last: i === all.length - 1 }));
    const parts = rules.sections(visible, { groups, recent: +s.recentlyClosed || 0 });
    const sections = parts.map((p) => ({
      key: p.key, label: p.label, kind: p.key.startsWith('group:') ? 'group' : p.key, groupId: p.groupId || '',
      made: !!p.made, first: !!(groups.find((g) => g.id === p.groupId) || {}).first, last: !!(groups.find((g) => g.id === p.groupId) || {}).last,
      rows: (p.key === 'closed' ? p.rows.map((r) => [r, 0]) : nest(p.rows)).map(([r, d]) => Object.assign(rowView(r, p.label, d),
        p.key === 'closed' ? { time: `closed ${age(r.closedAt, now())}` } : {})),
    }));
    const srcs = entries().map((e) => ({ id: e.id, label: sources.labelOf(e.source), logo: sources.logoOf(e.source), create: capsOf(e.source).create }));
    const accounts = [];
    for (const e of entries()) {
      const info = accountRaw(e);
      if (info && typeof info === 'object') accounts.push({ id: e.id, label: sources.labelOf(e.source), info: accountOf(info) });
    }
    const last = (host.globalMemento && host.globalMemento.get(LAST_NEW_KEY)) || {};
    return {
      sections, counts: rules.counts(visible), groups: groups.map((g) => ({ id: g.id, name: g.name })), sources: srcs, accounts,
      newSource: srcs.some((x) => x.id === last.sourceId) ? last.sourceId : (srcs[0] || {}).id || '', newWhere: last.where === 'sidebar' ? 'sidebar' : 'tab',
      problems: entries().map((e) => ({ id: e.id, label: sources.labelOf(e.source), text: (lists.get(e.id) || {}).problem || '' })).filter((p) => p.text),
      notices: entries().map((e) => { const n = noticeOf(e); return n ? Object.assign({ id: e.id, label: sources.labelOf(e.source) }, n) : null; }).filter(Boolean),
      front: look.front, restricted: !!(host.trusted && !host.trusted()), menu: menuItems(),
      colors: COLORS.map((name) => ({ name, color: THEME_COLOR[name] })), empty: visible.length === 0,
    };
  }

  /* accountInfo() and sessionsNotice() answer at once. A source that returns a Promise instead gets no part and no
     note, rather than a part drawn from the Promise, which has no rows. */
  const settled = (v) => {
    if (v && typeof v.then === 'function') { Promise.resolve(v).catch(() => { /* not used */ }); return null; }
    return v;
  };
  function accountRaw(e) {
    const fn = e && sources.optional(e.source, 'accountInfo');
    if (!fn) return null;
    try { return settled(fn({ sessionId: lastFront.get(e.id) || '' })); } catch (_) { return null; }
  }

  function accountOf(info) {
    const rowsOf = (v) => (Array.isArray(v) ? v : []).slice(0, 12).map((r) => ({ label: str(sources.get(r, 'label'), 60), value: str(String(sources.get(r, 'value') ?? ''), 120), tooltip: str(sources.get(r, 'tooltip'), 300) })).filter((r) => r.label);
    return {
      rows: rowsOf(sources.get(info, 'rows')),
      bars: (Array.isArray(sources.get(info, 'bars')) ? sources.get(info, 'bars') : []).slice(0, 4).map((b) => ({ label: str(sources.get(b, 'label'), 60),
        percent: Math.max(0, Math.min(100, Number(sources.get(b, 'percent')) || 0)), resetsAt: moment(sources.get(b, 'resetsAt')), tooltip: str(sources.get(b, 'tooltip'), 300) })).filter((b) => b.label),
      links: (Array.isArray(sources.get(info, 'links')) ? sources.get(info, 'links') : []).slice(0, 3).map((l, i) => ({ i, label: str(sources.get(l, 'label'), 60) })).filter((l) => l.label),
      conversation: sources.get(info, 'conversation') ? { title: str(sources.get(sources.get(info, 'conversation'), 'title'), 120), rows: rowsOf(sources.get(sources.get(info, 'conversation'), 'rows')) } : null,
    };
  }

  /* A source's note above the list (feature 'sessionsNotice'), as { text, actions: [{ i, label }] }, or null. */
  function rawNotice(e) {
    const fn = sources.optional(e.source, 'sessionsNotice');
    if (!fn) return null;
    try { return settled(fn()); } catch (_) { return null; }
  }
  function noticeOf(e) {
    const n = rawNotice(e);
    const text = str(sources.get(n, 'text'), 300).trim();
    if (!text) return null;
    const acts = sources.get(n, 'actions');
    return { text, actions: (Array.isArray(acts) ? acts : []).slice(0, 3).map((a, i) => ({ i, label: str(sources.get(a, 'label'), 40) }))
      .filter((a) => a.label) };
  }
  /* Runs one of the buttons of a source's note. */
  function noticeAction(sourceId, i) {
    const e = entryOf(sourceId);
    const acts = e ? sources.get(rawNotice(e), 'actions') : null;
    const a = Array.isArray(acts) ? acts[i] : null;
    const command = str(sources.get(a, 'command'), 200);
    if (!command) return;
    const args = sources.get(a, 'arguments');
    Promise.resolve(vscode.commands.executeCommand(command, ...(Array.isArray(args) ? args : []))).catch((err) => say(`session list: ${command}: ${(err && err.message) || err}`));
  }

  /* Runs one of the links of a source's Account & usage part. */
  function accountLink(sourceId, i) {
    const info = accountRaw(entryOf(sourceId));
    const links = sources.get(info, 'links');
    const l = Array.isArray(links) ? links[i] : null;
    const command = str(sources.get(l, 'command'), 200);
    if (!command) return;
    const args = sources.get(l, 'arguments');
    Promise.resolve(vscode.commands.executeCommand(command, ...(Array.isArray(args) ? args : []))).catch((err) => say(`session list: ${command}: ${(err && err.message) || err}`));
  }

  /* ── refreshing ── */
  let refreshing = null, again = false;
  async function refresh({ relist = false } = {}) {
    if (closed) return;
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      const t = now();
      for (const e of entries()) {
        const st = lists.get(e.id);
        if (relist || !st || st.dirty || t - st.at >= relistMs) await listOne(e);
      }
      for (const id of [...lists.keys()]) if (!entries().some((e) => e.id === id)) lists.delete(id);
      const was = look;
      look = lookNow();
      if (look.front) { const [fs0, fid] = JSON.parse(look.front); lastFront.set(fs0, fid); }
      noteClosed(was, look);
      elsewhereByKey = otherWindows(entries().map((e) => ({ sourceId: e.id, planDir: sources.planDirOf(e.source) })), { now: now() });
      build();
      tellDue();
      markSeen();
      placeNew();
      modelValue = buildModel();
      fire();
      sweep().catch((err) => say(`session list: sweep: ${(err && err.message) || err}`));
    })();
    try { await refreshing; } finally { refreshing = null; }
    if (again) { again = false; return refresh(); }
  }

  function schedule(ms = 300) {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refresh().catch((err) => say(`session list: ${(err && err.message) || err}`)); }, ms);
  }

  const subs = [];
  const watch = (e) => {
    const d = sources.listen(e.source, 'onDidChangeSessions', () => { const st = lists.get(e.id); if (st) st.dirty = true; schedule(); });
    if (d) subs.push(d);
    const a = sources.listen(e.source, 'onDidChangeAccountInfo', () => schedule());
    if (a) subs.push(a);
    if (sources.supports(e.source, 'sessionsNotice')) { const n = sources.listen(e.source, 'onDidChangeSessionsNotice', () => schedule()); if (n) subs.push(n); }
    if (sources.supports(e.source, 'sessionClose')) {
      const c = sources.listen(e.source, 'onDidCloseSession', (ev) => {
        const id = sources.get(ev, 'sessionId'), where = sources.get(ev, 'where');
        if (sources.usableId(id)) { remember([keyOf(e.id, id)], () => (where === 'sidebar' ? 'sidebar' : 'tab')); schedule(); }
      });
      if (c) subs.push(c);
    }
  };
  const watched = new Set();
  function attach() { for (const e of entries()) if (!watched.has(e)) { watched.add(e); watch(e); const st = lists.get(e.id); if (st) st.dirty = true; } }
  subs.push(store.onDidChange(() => schedule(30)));
  if (vscode.window.tabGroups && typeof vscode.window.tabGroups.onDidChangeTabs === 'function') subs.push(vscode.window.tabGroups.onDidChangeTabs(() => schedule(50)));

  return {
    refresh: (o) => { attach(); return refresh(o); },
    schedule: () => { attach(); schedule(); },
    model: () => modelValue || buildModel(),
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    act, groupAct, create, chooseNew, rename, open: openRow, accountLink, noticeAction, sweep,
    renameGroup: (id, name) => { if (store.renameGroup(id, name)) schedule(0); },
    moveTo: (keys, groupKey) => {
      if (host.trusted && !host.trusted()) return;
      const pairs = keys.filter((k) => rows.has(k) && !rows.get(k).archived).map((k) => JSON.parse(k));
      if (groupKey === 'ungrouped') store.setGroup(pairs, null);
      else if (groupKey.startsWith('group:') && store.groupKnown(groupKey.slice(6))) store.setGroup(pairs, groupKey.slice(6));
      schedule(0);
    },
    wantDetail(keys) {
      for (const e of entries()) {
        const ids = keys.map((k) => rows.get(k)).filter((r) => r && r.sourceId === e.id && !r.detail).map((r) => r.sessionId);
        const fn = sources.get(e.source, 'wantSessionDetail');
        if (ids.length && typeof fn === 'function') { try { fn.call(e.source, ids.slice(0, 200)); } catch (_) { /* the rows keep no dot */ } }
      }
    },
    reopenLast() { const c = closedList().find((x) => !look.here.has(x.k) && rows.has(x.k)); if (c) return openRow(c.k, c.where); return null; },
    /* Rows and their keys, for the find command and the tests. */
    rows: () => [...rows.values()],
    manages: () => !closed && (host.trusted ? host.trusted() : true),
    deletionDue: dueOf,
    onDidChangeDeletionDue(fn) { dueListeners.add(fn); return { dispose: () => dueListeners.delete(fn) }; },
    folderChanged() {
      const next = projectOf(folders(), workspaceFile());
      if (next.key === project.key) return;
      store.dispose();
      project = next;
      store = createStore({ dir: shared('session-list'), key: project.key, label: project.label, now, log: say, writable: () => !host.trusted || host.trusted() });
      subs.push(store.onDidChange(() => schedule(30)));
      for (const st of lists.values()) st.dirty = true;
      schedule(0);
    },
    store: () => store,
    project: () => project,
    dispose() { closed = true; if (timer) clearTimeout(timer); if (seenTimer) clearTimeout(seenTimer); for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } store.dispose(); },
  };
}

module.exports = { createSessionList, sessionOf, capsOf, resultsOf, PAGE, MAX_SESSIONS, PAGE_MS, ACTION_MS, RELIST_MS, SWEEP_EVERY_MS, CLOSED_KEY, LAST_NEW_KEY };
