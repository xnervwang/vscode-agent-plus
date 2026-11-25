// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The views and what keeps them current: the work plan of the conversation in front, the Conversations tree with its
 * status bar entry, and the Answer view with the delivery of answers. From the host part of extension.js in
 * vscode-claude-code-extras bb28f51, with no source built in: every conversation comes from a registered source.
 *
 * Built by src/host.js once something uses this extension. In Restricted Mode they read and draw only: no answer is
 * sent or taken, no icon is written, VS Code's files are left alone.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const { readPlanAt, closedFileOf, countOpen, countUnknown, MAX_PLAN_BYTES } = require('./workplan');
const { WorkPlanProvider, ageSince } = require('./workplan-view');
const { ConversationsProvider, questionOf, briefOf, briefKey } = require('./conversations-view');
const conversations = require('./conversations');
const conversationsText = require('./conversations-text');
const folders = require('./folders');
const sourceIcons = require('./sourceicons');
const { AnswerView, questionKey } = require('./answer-view');
const answers = require('./answers');
const { sharedHome } = require('./files');
const attention = require('./attention');
const waitReason = require('./wait-reason');
const windowOpen = require('./window-open');
const planSummary = require('./plan-summary');

const CONFIG = 'agentPlus';
const REFRESH_MS = 30000;
/*
 * How often the answers folder is read when nothing has told this window to look. It has to be well under the 15
 * seconds a sender waits (src/answers.js TAKE_MS) or an answer is withdrawn as undelivered while a window that could
 * have delivered it sits waiting for its next turn. fs.watch() is the normal way this window hears about one, and this
 * is what covers the cases where it hears nothing: the server out of inotify watches, the folder removed and made
 * again, a home folder on a network file system, or a file that arrived while no conversation it could go to was open.
 */
const ANSWER_POLL_MS = 2000;
/* How long events that each ask for the same redraw are gathered up for. */
const DEBOUNCE_MS = 250;
/* A plan file that does not parse and was written this recently is taken to be half-written rather than broken. */
const WRITING_MS = 2000;
/* How long a pass of the Conversations tree waits for a source's list before drawing that source's previous one, and
   after how long a list still outstanding is shown as a problem. */
const LIST_WAIT_MS = 3000;
const SLOW_MS = 20000;
const ZONE_KEY = 'agentPlus.timeZone';
/* A window shows a few conversations at a time, so the limit is far above what is ever in use. */
const MAX_SUMMARIES = 200;
const EMPTY_LIST = { list: [], problem: '' };
const NO_CONVERSATIONS = { running: [], stopped: [], asks: 0 };

/*
 * `host` is what src/host.js passes: vscode, context, say, registry, trusted(). `opts.home` replaces the shared folder,
 * `opts.limit` is the webview request limit (src/request-limit.js), started once the window is trusted, and
 * `opts.listWaitMs`, `opts.slowMs` and `opts.refreshMs` replace the timings, in tests.
 */
function create(host, opts = {}) {
  const { context, registry, say } = host;
  const trusted = () => host.trusted();
  const listWait = Number.isFinite(opts.listWaitMs) ? opts.listWaitMs : LIST_WAIT_MS;
  const slowAfter = Number.isFinite(opts.slowMs) ? opts.slowMs : SLOW_MS;
  const cfg = () => vscode.workspace.getConfiguration(CONFIG);
  const subs = [];
  const keep = (d) => { if (d) subs.push(d); return d; };
  let closing = false;
  let active = true;
  /* On close each pending timeout's callback runs at once, so no promise waiting on one is left pending. */
  const waits = new Map();
  const after = (fn, ms) => { const t = setTimeout(() => { waits.delete(t); fn(); }, ms); waits.set(t, fn); return t; };
  const cancel = (t) => { clearTimeout(t); waits.delete(t); };

  /* ── The work plan of the conversation in front ── */
  const focus = new sources.Focus();
  /*
   * Plans are read again for every conversation of this workspace on every pass, and a plan file can be 8 MB. A file
   * whose modification time and size are both what they were last time is the same file, so the parse is kept. The
   * modification time is in milliseconds, so a writer that replaced a file within the same millisecond and kept its
   * size exactly would not be noticed; the refresh command drops the whole cache for that.
   */
  const plans = new Map();
  /* Each pass of the Conversations tree is numbered and every plan read stamped with it; one not read for two passes
     is let go, so a window open for weeks does not keep every plan it was ever shown. */
  let pass = 0;
  const statOf = (file) => { try { return fs.statSync(file); } catch (_) { return null; } };
  const planOf = (sourceId, session) => {
    const source = registry.get(sourceId);
    const file = source ? sources.planFileOf(source, session) : '';
    if (!file) return { file: '', plan: null };
    const st = statOf(file);
    /* The rows moved to the archive beside the plan are part of it (src/workplan.js), so a change to that file is one. */
    const ast = statOf(closedFileOf(file));
    const also = ast ? `${ast.mtimeMs}:${ast.size}` : '';
    const had = plans.get(file);
    if (had) had.pass = pass;
    if (st && had && had.session === session && had.mtimeMs === st.mtimeMs && had.size === st.size && had.also === also) {
      return { file, plan: had.plan };
    }
    const plan = readPlanAt(file, session, MAX_PLAN_BYTES);
    /*
     * The protocol asks nothing of how a plan file is written, so a reader can land in the middle of one. A file that
     * does not parse and was written moments ago is being written right now: the plan that last parsed is shown for a
     * little longer rather than a warning row that will be gone by the next pass, and a conversation that has stopped
     * does not drop out of the list and come back. A file that still does not parse after that says so.
     */
    if (plan && plan.error && had && had.plan && !had.plan.error && st && Date.now() - st.mtimeMs < WRITING_MS) {
      rereadAfter(WRITING_MS - (Date.now() - st.mtimeMs) + 50);
      return { file, plan: had.plan };
    }
    if (st) plans.set(file, { session, mtimeMs: st.mtimeMs, size: st.size, also, plan, pass });
    else plans.delete(file);
    return { file, plan };
  };
  /* A half-written file shows its last good parse for a moment; since no file event may follow, the file is read again
     once that moment is over. */
  let rereadTimer = 0;
  const rereadAfter = (ms) => {
    if (rereadTimer || closing) return;
    rereadTimer = setTimeout(() => { rereadTimer = 0; refreshPlans(); }, Math.max(0, ms));
  };
  const letGo = () => { for (const [file, had] of plans) if (had.pass < pass - 1) plans.delete(file); };
  const planMtime = (file) => { const had = plans.get(file); if (had) return had.mtimeMs; const st = statOf(file); return st ? st.mtimeMs : 0; };
  const workplan = new WorkPlanProvider({ read: (session, sourceId) => planOf(sourceId, session).plan });
  workplan.setScoped(true);
  const view = keep(vscode.window.createTreeView('agentPlus.workPlan', { treeDataProvider: workplan }));
  let viewSays;
  const paintPlanView = () => {
    const s = focus.sourceId ? registry.get(focus.sourceId) : null;
    const says = s ? sources.labelOf(s) : undefined;
    if (says !== viewSays) { viewSays = says; view.description = says; }
    workplan.setProblem(s ? sources.noticeOf(s) : null);
  };
  /* Badge: the discussing and todo rows of the plan shown. */
  const paintBadge = () => {
    const plan = workplan.shown();
    const n = plan ? countOpen(plan.nodes) : {};
    const open = (n.todo || 0) + (n.discussing || 0);
    view.badge = open ? { value: open, tooltip: `${open} still open in this conversation` } : undefined;
  };
  /* The reader's zone: what the Answer view's page reported, else what a source knows. */
  const readerZone = () => {
    const own = context.globalState && context.globalState.get(ZONE_KEY, '');
    if (own) return own;
    for (const s of registry.all()) { const z = sources.timeZoneOf(s); if (z) return z; }
    return '';
  };

  /* ── Conversations ── */
  const conversationsTree = keep(new ConversationsProvider());
  const conversationsView = keep(vscode.window.createTreeView('agentPlus.conversations', { treeDataProvider: conversationsTree }));
  keep(vscode.window.registerFileDecorationProvider(conversationsTree.decorations));
  const conversationsOn = () => cfg().get('conversationsView', true) !== false;
  const conversationsLang = () => conversationsText.language(vscode.env.language);
  const statusEntry = keep(vscode.window.createStatusBarItem('agentPlus.conversations', vscode.StatusBarAlignment.Right, 100));
  statusEntry.name = 'Conversations';
  statusEntry.command = 'agentPlus.showConversations';
  const paintConversations = () => {
    const t = conversationsText.textFor(conversationsTree.lang);
    const asks = conversationsTree.data.asks;
    conversationsView.title = t.view;
    conversationsView.badge = asks ? { value: asks, tooltip: t.badge(asks) } : undefined;
    if (!active || !conversationsOn()) { statusEntry.hide(); return; }
    /* It counts conversations, not questions: the plan bar a feature extension draws counts the questions of one. */
    const running = conversationsTree.data.running, asking = running.filter((c) => c.questions.length);
    statusEntry.text = '$(comment-discussion) ' + (asking.length ? t.status(asking.length) : t.statusIdle(running.length));
    statusEntry.tooltip = asking.length
      ? [t.statusWho(asking.length), ...asking.slice(0, 10).map((c) => `${c.title} · ${t.questions(c.questions.length)}`)]
        .concat(asking.length > 10 ? [t.statusMore(asking.length - 10)] : []).join('\n')
      : t.statusTip;
    statusEntry.backgroundColor = asking.length ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    statusEntry.show();
  };

  /* ── Conversations that need the user, in any window (src/attention.js) ── */
  const windowId = `${Date.now().toString(36)}-${require('crypto').randomBytes(4).toString('hex')}`;
  const shared = (name) => path.join(opts.home || sharedHome(), name);
  const notifySettings = () => ({ enabled: cfg().get('notifications.enabled', true) !== false,
    finished: cfg().get('notifications.finished', true) !== false, waiting: cfg().get('notifications.waiting', true) !== false });
  const attentionEntry = keep(vscode.window.createStatusBarItem('agentPlus.attention', vscode.StatusBarAlignment.Right, 101));
  attentionEntry.name = 'Conversations that need you';
  attentionEntry.command = 'agentPlus.showAttention';
  const paintAttention = (items) => {
    if (!active || !items.length) { attentionEntry.hide(); return; }
    attentionEntry.text = `$(bell-dot) ${items.length}`;
    const why = (it) => { const b = it.kind === 'waiting' ? waitReason.brief(it.waitingFor) : ''; return b ? ` (${b})` : ''; };
    attentionEntry.tooltip = `${items.length === 1 ? '1 conversation needs' : `${items.length} conversations need`} you:\n`
      + items.slice(0, 10).map((it) => `${it.kind === 'waiting' ? 'Waiting' : 'Finished'}: ${it.title}${why(it)}`).join('\n')
      + (items.length > 10 ? `\nand ${items.length - 10} more` : '');
    attentionEntry.show();
  };
  /* A plain message, since a progress notification can have only one button. */
  const notify = (text, it) => {
    Promise.resolve(vscode.window.showInformationMessage(text, 'Open', 'Dismiss'))
      .then((pick) => (pick === 'Open' ? commands.openAttention(it.sourceId, it.sessionId) : undefined))
      .catch((e) => say('attention: ' + ((e && e.message) || e)));
  };
  /* Under a display with no window manager, VS Code reports every window it has focused once as focused from then on.
     A window test therefore sets a global of this process to say whether this window has the focus; it is read only
     when the window was started with AGENT_PLUS_TEST_FOCUS=1. */
  const testFocus = process.env.AGENT_PLUS_TEST_FOCUS === '1';
  const windowFocused = () => {
    if (testFocus && typeof globalThis.__agentPlusTestFocused === 'boolean') return globalThis.__agentPlusTestFocused;
    try { return vscode.window.state.focused === true; } catch (_) { return false; }
  };
  const lookedAt = (it) => {
    const source = registry.get(it.sourceId);
    return !!source && windowFocused() && sources.call(source, 'isFocused', [it.sessionId], false) === true;
  };
  const needs = keep(attention.createAttention({ dir: shared(attention.ATTENTION_DIR), windowId, focused: windowFocused,
    lookedAt, shownHere: (it) => showsHere(it.sourceId, it.sessionId), settings: notifySettings, canWrite: trusted, show: notify,
    paint: paintAttention, several: () => registry.size > 1, log: say,
    warmupMs: Number.isFinite(opts.attentionWarmupMs) ? opts.attentionWarmupMs : attention.WARMUP_MS,
    batchMs: Number.isFinite(opts.attentionBatchMs) ? opts.attentionBatchMs : attention.BATCH_MS }));
  const showsHere = (sourceId, sessionId) => {
    const source = registry.get(sourceId);
    if (!source) return false;
    if (sources.call(source, 'isFocused', [sessionId], false) === true) return true;
    const shows = sources.optional(source, 'shows');
    if (shows) { try { if (shows(sessionId) === true) return true; } catch (_) { /* not shown */ } }
    for (const g of (vscode.window.tabGroups || {}).all || []) for (const t of g.tabs || []) if (sources.call(source, 'sessionForTab', [t], null) === sessionId) return true;
    return false;
  };
  const revealHere = async (sourceId, sessionId, row) => {
    const source = registry.get(sourceId);
    if (!source) return false;
    try { return (await sources.call(source, 'reveal', [sessionId, row], false)) === true; } catch (_) { return false; }
  };
  const opener = keep(windowOpen.createWindowOpen({ dir: shared(windowOpen.OPEN_DIR), windowId, here: showsHere, reveal: revealHere,
    front: () => windowOpen.bringToFront(vscode, say), log: say, waitMs: Number.isFinite(opts.openWaitMs) ? opts.openWaitMs : windowOpen.WAIT_MS }));
  /* Opens a conversation from wherever the user is: through the source's own open() when it has one, else in this
     window or the window that shows it. Says so when no window has it. */
  const openAnywhere = async (target) => {
    const source = registry.get(target.sourceId);
    if (!source) return 'nowhere';
    const row = { title: String(target.title || ''), cwd: String(target.cwd || '') };
    let r;
    if (typeof sources.get(source, 'open') === 'function') {
      try { r = await sources.call(source, 'open', [target.sessionId, row], 'nowhere'); } catch (_) { r = 'nowhere'; }
    } else r = await opener.open(Object.assign({}, target, row));
    if (r !== 'nowhere') return r;
    const text = `"${row.title || target.sessionId}" is not open in any VS Code window on this machine.`;
    const openHere = sources.optional(source, 'openHere');
    if (!openHere) { vscode.window.showInformationMessage(text); return r; }
    const go = 'Open it here';
    Promise.resolve(vscode.window.showInformationMessage(text, go))
      .then((pick) => (pick === go ? openHere(target.sessionId, row) : undefined))
      .catch((e) => say('open: ' + ((e && e.message) || e)));
    return r;
  };
  let attentionLists = [];
  const listAll = async (entry, fallback) => {
    if (typeof sources.get(entry.source, 'listAllConversations') !== 'function') return fallback;
    try { return sources.conversations(await Promise.race([sources.call(entry.source, 'listAllConversations', [], []),
      new Promise((r) => after(() => r(null), listWait))])) || fallback; } catch (_) { return fallback; }
  };
  /* A question put after the user last wrote makes a conversation wait for them in every window, so the plan of each
     running conversation whose source gives lastUserAt is read here, whichever folder it is in. */
  const withQuestions = (sourceId, list) => list.map((c) => (c.running && c.lastUserAt > 0
    ? conversations.withPlan(c, planOf(sourceId, c.sessionId).plan) : c));
  /* The list given to a dependent extension that links to conversations (src/host.js): each source's machine-wide list
     and this window's, each conversation once. Listeners hear of a change only when a conversation comes, goes, or
     changes its title or folder. */
  const everyone = host.everyone || { wanted: () => false, set() {} };
  let everyoneKey = JSON.stringify([]);
  const publishEveryone = (gathered) => {
    const out = [], seen = new Set();
    for (const { entry, list, all } of gathered) {
      const label = sources.labelOf(entry.source);
      for (const c of all.concat(list)) {
        const key = entry.id + '\n' + c.sessionId;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sourceId: entry.id, label, sessionId: c.sessionId, title: c.title, steward: c.steward, cwd: c.cwd, lastActiveAt: c.lastActiveAt });
      }
    }
    const key = JSON.stringify(out.map((c) => [c.sourceId, c.sessionId, c.title, c.cwd]));
    everyone.set(out, key !== everyoneKey);
    everyoneKey = key;
  };
  /* After each list pass: what every source lists, through listAllConversations() where a source has it. Once gathered
     it goes into this window's attention file whether or not the notifications are on here: other windows and dependent
     extensions read that file, and showing a notification or a count is decided separately (src/attention.js). */
  const publishAttention = async (pairs) => {
    const notifying = notifySettings().enabled, linking = everyone.wanted();
    if (!notifying && !linking) { attentionLists = []; needs.publish([]); needs.refresh(); return; }
    const gathered = await Promise.all(pairs.map(async ({ entry, list }) => ({ entry, list, all: await listAll(entry, list) })));
    if (closing) return;
    if (linking) publishEveryone(gathered.filter((g) => registry.has(g.entry)));
    attentionLists = gathered.map(({ entry, all }) => ({ sourceId: entry.id, label: sources.labelOf(entry.source),
      conversations: withQuestions(entry.id, all) }));
    needs.publish(attentionLists);
    needs.refresh();
  };
  const attentionTick = setInterval(() => {
    try { needs.refresh(); } catch (e) { say('attention: ' + ((e && e.message) || e)); }
    opener.take().catch((e) => say('open: ' + ((e && e.message) || e)));
  }, Number.isFinite(opts.attentionMs) ? opts.attentionMs : 1000);
  keep({ dispose: () => clearInterval(attentionTick) });
  /* What was kept while no window had the focus is shown the moment this window gets it. */
  if (typeof vscode.window.onDidChangeWindowState === 'function') {
    keep(vscode.window.onDidChangeWindowState(() => { try { needs.refresh(); } catch (e) { say('attention: ' + ((e && e.message) || e)); } }));
  }

  /* Each source's list is asked for when it registers, when it fires onDidChangeConversations, on the tick and on a
     folder or settings change. A pass waits LIST_WAIT_MS for it and otherwise draws its previous list; a list that
     arrives later triggers one repaint from the cached lists, which asks no source. A call still outstanding is never
     abandoned: no other call goes to that source until it settles, however long it takes, and after SLOW_MS the tree
     says it is still waiting. */
  let convBusy = false, convAgain = null;
  const said = (e) => {
    const m = sources.get(e, 'message');
    if (typeof m === 'string' && m) return m;
    try { return String(e); } catch (_) { return 'it failed'; }
  };
  /* Never rejects: a failing source must not stop the other sources' lists from being drawn. */
  const listOf = (source) => {
    let answer;
    try { answer = Promise.resolve(sources.call(source, 'listConversations', [], [])); } catch (e) { answer = Promise.reject(e); }
    return answer.then((got) => {
      const problem = sources.get(got, 'problem');
      return { list: sources.conversations(got), problem: typeof problem === 'string' ? problem.slice(0, 500) : '' };
    }, (e) => ({ list: [], problem: said(e) })).catch(() => ({ list: [], problem: 'its list could not be read' }));
  };
  const listState = (entry) => entry.list
    || (entry.list = { last: null, pending: null, askNext: true, askAgain: false, repaint: false, slow: false });
  const ask = (entry) => {
    const st = listState(entry);
    if (st.pending) { st.askAgain = true; return st.pending; }
    st.askNext = false;
    st.slow = false;
    st.askedAt = Date.now();
    let asking = null;
    const slowTimer = after(() => {
      if (st.pending !== asking || closing) return;
      st.slow = true;
      refreshConversations(false, true);
    }, slowAfter);
    asking = listOf(entry.source).then((r) => {
      cancel(slowTimer);
      if (st.pending === asking) st.pending = null;
      st.slow = false;
      if (closing || !registry.has(entry)) return r;
      st.last = r;
      /* No sooner than the debounce after this list was asked for: a source that reports a change from inside every
         list it gives would otherwise be listed again the moment each list settles, for as long as the window is open.
         A list that took longer than that is followed at once. */
      if (st.askAgain) {
        st.askAgain = false; st.repaint = false; st.askNext = true;
        const left = soon - (Date.now() - st.askedAt);
        if (left > 0) convAfter(left); else refreshConversations(false);
      }
      else if (st.repaint) { st.repaint = false; refreshConversations(false, true); }
      return r;
    });
    st.pending = asking;
    return asking;
  };
  const listFor = (entry, cachedOnly) => {
    const st = listState(entry);
    if (cachedOnly || !st.askNext || st.pending) {
      if (st.pending && !cachedOnly) st.repaint = true;
      return Promise.resolve(st.last || EMPTY_LIST);
    }
    const asking = ask(entry);
    return new Promise((resolve) => {
      let done = false;
      const timer = after(() => { if (done) return; done = true; st.repaint = true; resolve(st.last || EMPTY_LIST); }, listWait);
      asking.then((r) => { if (done) return; done = true; cancel(timer); resolve(r); });
    });
  };
  const askAll = () => { for (const entry of registry.list()) listState(entry).askNext = true; };
  /*
   * The folder test resolves symbolic links, and it is asked about the folder of every conversation on every pass, so
   * the answers are kept. It is built again, with nothing kept, whenever the workspace folders change; a symbolic link
   * repointed while the window stays open is not noticed.
   */
  let folderKey = null, folderIn = null;
  const folderTestFor = (list) => {
    const key = JSON.stringify(list);
    if (key !== folderKey || !folderIn) { folderKey = key; folderIn = folders.folderTest(list, new Map()); }
    return folderIn;
  };
  const rowIcons = new Map(), rowIconUris = new Map();
  const iconsDir = () => path.join(context.globalStorageUri.fsPath, 'conversation-icons');
  const rowIcon = (source, activity) => {
    if (!trusted()) return undefined;
    const logo = sources.logoOf(source);
    if (!logo) return undefined;
    const files = sourceIcons.iconsFor(logo, activity, iconsDir(), rowIcons);
    if (!files) return undefined;
    const uri = (f) => { if (!rowIconUris.has(f)) rowIconUris.set(f, vscode.Uri.file(f)); return rowIconUris.get(f); };
    return { light: uri(files.light), dark: uri(files.dark) };
  };
  const refreshConversations = async (askAgain, cachedOnly = false) => {
    if (closing) return;
    if (askAgain) askAll();
    if (convBusy) { convAgain = convAgain === null ? !!cachedOnly : convAgain && !!cachedOnly; return; }
    convBusy = true;
    try {
      if (!conversationsOn()) {
        conversationsTree.set(NO_CONVERSATIONS, '', conversationsLang());
        paintConversations();
        if (notifySettings().enabled || everyone.wanted()) {
          const asked = registry.list();
          const got = await Promise.all(asked.map((entry) => listFor(entry, cachedOnly)));
          if (!closing) await publishAttention(asked.map((entry, i) => ({ entry, list: got[i].list })).filter((x) => registry.has(x.entry)));
        }
        return;
      }
      const asked = registry.list();
      const got = await Promise.all(asked.map((entry) => listFor(entry, cachedOnly)));
      if (closing) return;
      publishAttention(asked.map((entry, i) => ({ entry, list: got[i].list })).filter((x) => registry.has(x.entry)))
        .catch((e) => say('attention: ' + ((e && e.message) || e)));
      const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      const lists = [], problems = [];
      const inFolder = folderTestFor(roots);
      asked.forEach((entry, i) => {
        if (!registry.has(entry)) return;
        lists.push({ sourceId: entry.id, conversations: got[i].list });
        if (got[i].problem) problems.push([entry.source, got[i].problem]);
        if (listState(entry).slow) problems.push([entry.source, `it has not listed its conversations for ${Math.round(slowAfter / 1000)} seconds; still waiting`]);
      });
      const several = registry.size > 1;
      pass++;
      const data = conversations.assemble({ lists, folders: roots, planOf, modified: planMtime, inFolder });
      letGo();
      for (const c of data.running.concat(data.stopped)) {
        const source = registry.get(c.sourceId);
        c.source = { id: c.sourceId, label: sources.labelOf(source) || c.sourceId };
        c.briefs = sources.supports(source, 'brief');
        if (several) { try { const icon = rowIcon(source, c.activity); if (icon) c.icon = icon; } catch (_) { /* the row keeps the plain dot */ } }
      }
      const problem = problems.map(([source, what]) => (several ? sources.labelOf(source) + ': ' + what : what)).join('\n');
      conversationsTree.set(data, problem, conversationsLang());
      answerView.setLanguage(conversationsLang());
      /* The question on screen is only as good as the last pass: the row it is on may have been reworded, finished, or
         its conversation stopped. */
      answerView.revise((key) => questionNow(data, key));
      answerView.reviseBrief((key) => briefNow(data, key));
      if (courier) courier.recall((sent) => stillAsked(data, sent.target));
      paintConversations();
    } catch (e) {
      say('conversations: ' + ((e && e.message) || e));
    } finally {
      convBusy = false;
      if (convAgain !== null && !closing) { const cached = convAgain; convAgain = null; refreshConversations(false, cached); }
    }
  };

  /* The question named `key` as the latest list has it, or null when no row is asking it any more. A question opened
     from a plan bar for a conversation the list leaves out is read from its plan. */
  const questionNow = (data, key) => {
    for (const c of data.running.concat(data.stopped)) {
      for (const q of c.questions) if (questionKey(c.sourceId, c.sessionId, q.row) === key) return questionOf(c, q);
    }
    const aside = asideQuestions.get(key);
    if (!aside) return null;
    const c = conversationOf(aside.sourceId, aside.sessionId);
    const q = c && c.questions.find((x) => x.row === aside.row);
    return q ? questionOf(c, q) : null;
  };

  /*
   * One conversation in the shape the Conversations view gives it, with its questions and `doing` rows, from its plan
   * as it is now and its source's last list. The list alone will not do for a plan bar: it may be older than the plan,
   * or leave the conversation out for being outside this window's folders. A conversation its source has not listed
   * counts as not running. Null when the source is not registered.
   */
  const asideQuestions = new Map();
  const listedNow = (sourceId, sessionId) => {
    const data = conversationsTree.data;
    return data.running.concat(data.stopped).some((x) => x.sourceId === sourceId && x.sessionId === sessionId);
  };
  const listedBy = (entry, sessionId) => {
    const st = listState(entry);
    return ((st.last && st.last.list) || []).find((x) => x.sessionId === sessionId) || null;
  };
  const conversationOf = (sourceId, sessionId) => {
    const entry = registry.entry(sourceId);
    if (!entry) return null;
    const raw = listedBy(entry, sessionId) || { sessionId, cwd: '', title: '', state: 'idle', running: false };
    const { plan, file } = planOf(sourceId, sessionId);
    return Object.assign(conversations.entry(raw, plan, !!file), { sourceId });
  };

  /* The conversation whose brief is named `key`, as the latest list has it, or null when it is not in the list. */
  const briefNow = (data, key) => {
    const c = data.running.concat(data.stopped).find((x) => briefKey(x.sourceId, x.sessionId) === key);
    return c ? briefOf(c) : null;
  };

  /*
   * Whether the row an answer was written for still asks what it was answering. True whenever the latest pass cannot
   * tell: its conversation is not in the list (a source whose list failed this pass) or its plan did not parse.
   */
  const stillAsked = (data, target) => {
    if (!target) return true;
    const c = data.running.concat(data.stopped).find((x) => x.sourceId === target.sourceId && x.sessionId === target.sessionId);
    if (!c || !c.hasPlan) return true;
    const q = c.questions.find((x) => x.row === target.row);
    return !!q && (q.question || '') === target.question;
  };

  const refreshPlans = () => {
    if (closing) return;
    workplan.setTimeZone(readerZone());
    const moved = workplan.setFocus(focus.sessionId, focus.sourceId);
    paintPlanView();
    if (workplan.refresh() || moved) paintBadge();
    recheckSummaries();
    refreshConversations(false);
  };

  /*
   * ── Plan summaries (planSummary in docs/protocol.md) ──
   *
   * Whenever the plans are read again (a plan folder changed, the tick, a source registered or went) and something
   * listens, each summary asked for is worked out again from the same cached parse, and a listener hears
   * { sourceId, sessionId } for each that changed.
   */
  const summaryBus = host.planSummaries || { wanted: () => false, fire() {} };
  const summaries = new Map();
  const summaryKey = (sourceId, sessionId) => keyOf(sourceId) + '/' + keyOf(sessionId);
  const keyOf = (v) => sources.keyPart(v);
  const summaryNow = (sourceId, sessionId) => (registry.get(sourceId) ? planSummary.summarize(planOf(sourceId, sessionId).plan) : null);
  const freeze = (v) => {
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) freeze(v[k]); Object.freeze(v); }
    return v;
  };
  const summaryFor = (sourceId, sessionId) => {
    if (closing || !sources.usableId(sourceId) || !sources.usableId(sessionId)) return null;
    const now = summaryNow(sourceId, sessionId);
    const key = summaryKey(sourceId, sessionId);
    summaries.delete(key);
    summaries.set(key, { sourceId, sessionId, last: now });
    while (summaries.size > MAX_SUMMARIES) summaries.delete(summaries.keys().next().value);
    return now ? freeze(JSON.parse(JSON.stringify(now))) : null;
  };
  function recheckSummaries() {
    if (closing || !summaries.size || !summaryBus.wanted()) return;
    for (const s of summaries.values()) {
      let now = null;
      try { now = summaryNow(s.sourceId, s.sessionId); } catch (e) { say('plan summary: ' + ((e && e.message) || e)); continue; }
      if (planSummary.same(now, s.last)) continue;
      s.last = now;
      summaryBus.fire(Object.freeze({ sourceId: s.sourceId, sessionId: s.sessionId }));
    }
  }
  /*
   * One write of one plan file arrives as several create and change events, and a source that keeps its conversation
   * list current can fire onDidChangeConversations as fast as it likes. Each pass reads the plan file of every
   * conversation of this workspace, on the extension host thread the Claude Code and Codex panels share, so the events
   * are gathered up first and the work is done once.
   */
  const soon = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEBOUNCE_MS;
  let plansTimer = 0, convTimer = 0;
  const plansSoon = () => {
    if (closing || plansTimer) return;
    plansTimer = setTimeout(() => { plansTimer = 0; refreshPlans(); }, soon);
  };
  const convAfter = (ms) => {
    if (closing || convTimer) return;
    convTimer = setTimeout(() => { convTimer = 0; refreshConversations(false); }, ms);
  };
  const convSoon = () => convAfter(soon);

  /* ── Answers ── */
  const answersDir = () => path.join(opts.home || sharedHome(), 'answers');
  const localClock = (ms) => {
    const zone = readerZone() || undefined;
    try { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone }); }
    catch (_) { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  };
  const answerView = new AnswerView({
    age: (since) => ageSince(since),
    clock: localClock,
    open: (target) => commands.openConversation(target),
    onTimeZone: (zone) => {
      if (!zone || !context.globalState || context.globalState.get(ZONE_KEY, '') === zone) return;
      Promise.resolve(context.globalState.update(ZONE_KEY, zone)).catch(() => {});
      if (workplan.setTimeZone(zone)) workplan.refresh();
    },
    send: (q, text) => {
      if (!trusted()) { answerView.setRestricted(true); return; }
      let ticket;
      try {
        const c = courierNow();
        if (!c) throw new Error('no answer folder');
        const body = answers.message(q.row, q.question, text);
        ticket = answerView.begin(q.key);
        const target = { sourceId: q.sourceId, sessionId: q.sessionId, row: q.row, question: q.question || '' };
        c.send({ sourceId: q.sourceId, sessionId: q.sessionId, row: q.row, text: body }, { key: q.key, ticket, target });
      } catch (e) {
        say('answer: ' + ((e && e.message) || e));
        Promise.resolve(vscode.env.clipboard.writeText(answers.message(q.row, q.question, text))).catch(() => {});
        answerView.setState(q.key, { kind: 'error' }, ticket);
      }
    },
  });
  answerView.setLanguage(conversationsLang());
  answerView.setRestricted(!trusted());
  keep(vscode.window.registerWebviewViewProvider('agentPlus.answer', answerView, { webviewOptions: { retainContextWhenHidden: true } }));

  /* Created only once a source is registered and the window is trusted, which is also when the folder is made. */
  let courier = null, answersWatch = null, answersSoon = 0, answersPoll = 0;
  /* deliver() calls waiting for their outcome. */
  const deliveries = new Set();
  const answerPollMs = Number.isFinite(opts.answerPollMs) ? opts.answerPollMs : ANSWER_POLL_MS;
  const delivery = answers.throughSources((id) => registry.get(id));
  const pumpSoon = () => {
    if (answersSoon || !courier) return;
    answersSoon = setTimeout(() => {
      answersSoon = 0;
      try { if (courier) courier.pump(); } catch (e) { say('answer: ' + ((e && e.message) || e)); }
    }, 50);
  };
  /* Whether any registered source could take an answer at all. canDeliver() needs a conversation to ask about, so this
     is as close as this window can get without one: no source that can be handed an answer, nothing to poll for. */
  const mayDeliver = () => {
    for (const s of registry.all()) if (typeof sources.get(s, 'deliverAnswer') === 'function') return true;
    return false;
  };
  const dropWatch = () => {
    if (!answersWatch) return;
    try { answersWatch.close(); } catch (_) { /* closed already */ }
    answersWatch = null;
  };
  const watchAnswers = (dir) => {
    dropWatch();
    try {
      const w = fs.watch(dir, pumpSoon);
      answersWatch = w;
      /* A watcher that errors is gone for good; the poll makes a new one. */
      w.on('error', () => { if (answersWatch === w) dropWatch(); });
    } catch (e) { say('answer folder: ' + ((e && e.message) || e)); }
  };
  const pollAnswers = () => {
    if (closing || !courier) return;
    if (!answersWatch) {
      try { require('./files').privateDir(answersDir()); } catch (_) { /* tried again next time */ }
      watchAnswers(answersDir());
    }
    try { courier.pump(); } catch (e) { say('answer: ' + ((e && e.message) || e)); }
  };
  /* The interval also runs while a deliver() call waits, so that a watcher that stopped working cannot hold its
     outcome back until the last check. */
  const tuneAnswerPoll = () => {
    const want = !!courier && !closing && (mayDeliver() || deliveries.size > 0);
    if (want && !answersPoll) answersPoll = setInterval(pollAnswers, answerPollMs);
    else if (!want && answersPoll) { clearInterval(answersPoll); answersPoll = 0; }
  };
  const courierNow = () => {
    if (courier) return courier;
    if (closing || !trusted() || !registry.size) return null;
    const dir = answersDir();
    courier = new answers.Courier({
      dir,
      canShow: delivery.canShow,
      hand: delivery.hand,
      claiming: () => trusted() && !closing,
      finish: (sent, result) => {
        if (sent.delivery) { sent.delivery.resolve(result); return; }
        if (result.closing) return;
        /* One taken back because its row asks something else is not shown in the view, which has moved on to the new
           question with the draft still in the box, so nothing is put on the clipboard behind the reader's back. */
        if (result.outcome === 'notReceived' && !result.recalled) Promise.resolve(vscode.env.clipboard.writeText(sent.text)).catch(() => {});
        answerView.setState(sent.key, { kind: result.outcome, reason: result.reason || '' }, sent.ticket);
        say(`answer ${sent.id}: ${result.outcome}${result.reason ? ' (' + result.reason + ')' : ''}`);
      },
    });
    try {
      require('./files').privateDir(dir);
      courier.sweep();
      watchAnswers(dir);
    } catch (e) { say('answer folder: ' + ((e && e.message) || e)); }
    tuneAnswerPoll();
    return courier;
  };
  /*
   * A message from a dependent extension into a conversation (deliver in docs/protocol.md). Never rejects.
   */
  const deliver = (target) => new Promise((resolve) => {
    const end = (outcome, reason) => resolve(Object.freeze({ outcome, reason: reason || '' }));
    try {
      const sourceId = sources.get(target, 'sourceId'), sessionId = sources.get(target, 'sessionId'), text = sources.get(target, 'text');
      if (!sources.usableId(sourceId) || !sources.usableId(sessionId)) { end('notReceived', 'the target has no usable sourceId and sessionId'); return; }
      if (typeof text !== 'string' || !text.trim() || text.length > answers.MAX_MESSAGE) {
        end('notReceived', `there is no text, or it is longer than ${answers.MAX_MESSAGE} characters`);
        return;
      }
      if (closing) { end('notReceived', 'this window is closing'); return; }
      if (!trusted()) { end('notReceived', 'Agent Plus sends nothing in Restricted Mode'); return; }
      const c = courierNow();
      if (!c) { end('notReceived', 'the answers folder cannot be used in this window'); return; }
      const pending = {
        resolve: (r) => {
          if (!deliveries.delete(pending)) return;
          tuneAnswerPoll();
          const o = answers.deliveryOutcome(r);
          say(`message for ${sourceId}: ${o.outcome}${o.reason ? ' (' + o.reason + ')' : ''}`);
          end(o.outcome, o.reason);
        },
      };
      deliveries.add(pending);
      try { c.send({ sourceId, sessionId, text }, { delivery: pending }); }
      catch (e) {
        deliveries.delete(pending);
        end('notReceived', 'the message could not be written: ' + String((e && e.message) || e).slice(0, 160));
        return;
      }
      tuneAnswerPoll();
    } catch (e) {
      end('notReceived', String((e && e.message) || e).slice(0, 200));
    }
  });

  /* ── Which conversation is in front ── */
  /* Focus can change inside another extension's message handler, so the redraw is deferred to read no file there.
     `focus` is updated at once, so the deferred redraw shows the latest signal. */
  let drawTimer = 0;
  const drawFocus = () => {
    if (closing) return;
    paintPlanView();
    if (!workplan.setFocus(focus.sessionId, focus.sourceId)) return;
    say('active conversation: ' + (focus.sourceId ? `${focus.sourceId} ${focus.sessionId || '(no session yet)'}` : '(none)'));
    workplan.refresh();
    paintBadge();
  };
  const showFocus = () => {
    if (closing || drawTimer) return;
    drawTimer = setTimeout(() => { drawTimer = 0; drawFocus(); }, 0);
  };
  const claimTab = (again) => {
    const groups = vscode.window.tabGroups;
    const group = groups && groups.activeTabGroup;
    if (focus.claim(group ? group.activeTab : undefined, registry.list(), again)) showFocus();
  };
  {
    const groups = vscode.window.tabGroups;
    for (const name of ['onDidChangeTabs', 'onDidChangeTabGroups']) {
      if (groups && typeof groups[name] === 'function') keep(groups[name](() => claimTab(false)));
    }
  }

  /* ── Sources coming and going ── */
  const changed = (e) => {
    /* A source that registers late is offered the tab already in front even when another source has the focus: that
       tab may be its own, opened before its extension had finished starting, and nothing else would offer it again
       until the reader switched tabs and back. */
    let again = !focus.sourceId || !!e.added;
    if (e.removed && focus.drop(e.removed)) { showFocus(); again = true; }
    if (again) claimTab(true);
    if (e.added) listState(e.entry).askNext = true;
    paintPlanView();
    recheckSummaries();
    refreshConversations(false);
    if (e.added) { courierNow(); pumpSoon(); }
    tuneAnswerPoll();
  };
  const attach = (entry) => {
    const { id, source } = entry;
    const hold = (d) => { if (d) entry.subs.push(d); };
    /* A focus report is taken a moment later, and only if the source still says that conversation is in front: the
       report can describe a moment that has already passed. */
    hold(sources.listen(source, 'onDidFocus', (e) => {
      if (!registry.has(entry)) return;
      const sessionId = sources.get(e, 'sessionId');
      if (sessionId !== undefined && sessionId !== '' && !sources.usableId(sessionId)) return;
      /* The tab in front is offered round again first. A source fires this when a tab that answered '' has a
         conversation at last, and there may be no tab event to go with it. The report is taken after, so a source
         reporting a conversation of its own that is not in a tab still has the last word. */
      claimTab(true);
      const mine = focus.mark();
      after(() => {
        if (closing || !registry.has(entry)) return;
        /* The reader has switched tabs since this report was made, and that is the later signal. */
        if (focus.newerThan(mine)) return;
        if (sessionId && typeof sources.get(source, 'isFocused') === 'function'
          && sources.call(source, 'isFocused', [sessionId], false) !== true) return;
        if (focus.report(id, sessionId || '')) showFocus();
      }, 0);
      /* A conversation coming to the front is the usual reason this window can now deliver an answer that arrived
         while it could not. */
      pumpSoon();
    }));
    hold(sources.listen(source, 'onDidChangeConversations', () => {
      if (!registry.has(entry)) return;
      const st = listState(entry);
      if (st.pending) st.askAgain = true; else st.askNext = true;
      convSoon();
      pumpSoon();
    }));
    hold(sources.listen(source, 'onDidChangePlanNotice', () => { if (registry.has(entry)) paintPlanView(); }));
    /*
     * The plan directory itself is the base and the pattern has no path separator in it. A pattern that has one, as
     * `<directory>/*.json` relative to the parent would, makes VS Code watch the base recursively
     * (extHostFileSystemEventService.ts ensureWatching turns `recursive` on for a pattern containing GLOB_SPLIT, which
     * is '/'), and the parent of a plan directory is a conversation store holding a transcript per conversation. A
     * directory that does not exist yet is not a reason to watch the parent: a non-recursive request for a missing path
     * is suspended and polled until it appears, then resumed (baseWatcher.ts suspendWatchRequest). Watchers outside the
     * workspace are not guaranteed to fire at all, which is what the tick is for.
     */
    const dir = sources.planDirOf(source);
    if (dir) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.json'));
        watcher.onDidCreate(plansSoon);
        watcher.onDidChange(plansSoon);
        watcher.onDidDelete(plansSoon);
        hold(watcher);
      } catch (e) { say('work plan watcher not available: ' + ((e && e.message) || e)); }
    }
    changed({ added: id, entry });
  };
  const detach = (entry) => changed({ removed: entry.id, entry });

  /* ── Commands, called through src/host.js ── */
  /* The two ids of a plan bar command's argument, or null when either is unusable. */
  const targetOf = (v) => {
    const sourceId = sources.get(v, 'sourceId'), sessionId = sources.get(v, 'sessionId');
    return sources.usableId(sourceId) && sources.usableId(sessionId) ? { sourceId, sessionId } : null;
  };
  const commands = {
    refreshWorkPlan: () => { plans.clear(); workplan.signature = ''; refreshPlans(); refreshConversations(true); },
    openWorkPlanFile: async (element) => {
      const file = (element && element.plan && element.plan.file) || (workplan.shown() && workplan.shown().file);
      if (!file) { vscode.window.showInformationMessage('Agent Plus: the conversation in front is not keeping a work plan.'); return; }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    },
    /* Modal, because the description is the thing being read. It shows the whole description, which is bounded where it
       is read in (src/workplan.js). */
    showWorkPlanDetail: async (row) => {
      if (!row) return;
      const head = [[row.state, row.note].filter(Boolean).join(' · ')];
      if (row.question) head.push('Question: ' + row.question);
      if (row.times) head.push(row.times);
      if (row.path && row.path.length) head.push('in: ' + row.path.join(' › '));
      if (row.children) head.push(row.children + ' of its own to finish first');
      if (row.unknown) head.push('This version of Agent Plus does not know this state.');
      const body = row.detail || 'No description was written for this one.';
      await vscode.window.showInformationMessage(row.title, { modal: true, detail: head.concat(['', body]).join('\n') });
    },
    answerQuestion: async (q) => {
      if (!q) return;
      answerView.show(q);
      await vscode.commands.executeCommand('agentPlus.answer.focus');
    },
    showBrief: async (b) => {
      if (!b) return;
      answerView.showBrief(b);
      await vscode.commands.executeCommand('agentPlus.answer.focus');
    },
    /* The arrow on a conversation's row, which VS Code hands the tree element. */
    goToConversation: (element) => {
      const c = element && element.c;
      if (!c) return undefined;
      return commands.openConversation({ sourceId: (c.source && c.source.id) || c.sourceId || '', sessionId: c.sessionId, cwd: c.cwd, title: c.title });
    },
    showConversations: () => vscode.commands.executeCommand('agentPlus.conversations.focus'),
    /* A row of the Conversations view opens through openAnywhere, so a conversation in another window comes to the front
       there. */
    openConversation: async (target) => {
      if (!target || !target.sessionId || !registry.get(target.sourceId)) return;
      await openAnywhere({ sourceId: target.sourceId, sessionId: target.sessionId,
        title: typeof target.title === 'string' ? target.title : '', cwd: typeof target.cwd === 'string' ? target.cwd : '' });
    },
    openAttention: async (sourceId, sessionId) => {
      if (typeof sourceId !== 'string' || typeof sessionId !== 'string') return;
      const it = needs.items().find((x) => x.sourceId === sourceId && x.sessionId === sessionId) || {};
      await openAnywhere({ sourceId, sessionId, title: it.title, cwd: it.cwd });
    },
    /* The work plan view moves to that conversation, as a focus report would move it, and comes into view; the next tab
       change moves it on as usual. */
    showWorkPlanOf: async (target) => {
      const t = targetOf(target);
      if (!t || !registry.get(t.sourceId)) return;
      focus.mark();
      if (focus.set(t.sourceId, t.sessionId)) showFocus();
      await vscode.commands.executeCommand('agentPlus.workPlan.focus');
    },
    /* For the red part of a plan bar: shows the first question of that conversation's plan in the Answer view, in the
       order the Conversations view lists them. */
    answerQuestionOf: async (target) => {
      const t = targetOf(target);
      if (!t) return;
      /* The source's last list may be older than the conversation. Ask the source once more, waiting as long as a pass
         of the Conversations view waits for a list. */
      const entry = registry.entry(t.sourceId);
      if (entry && !listedBy(entry, t.sessionId)) {
        await Promise.race([ask(entry), new Promise((r) => after(r, listWait))]).catch(() => {});
      }
      const c = conversationOf(t.sourceId, t.sessionId);
      const q = c && c.questions[0];
      if (!q) { vscode.window.showInformationMessage('Agent Plus: no question in that conversation\'s plan is waiting for your answer.'); return; }
      if (!listedNow(t.sourceId, t.sessionId)) {
        asideQuestions.set(questionKey(t.sourceId, t.sessionId, q.row), { sourceId: t.sourceId, sessionId: t.sessionId, row: q.row });
        while (asideQuestions.size > 50) asideQuestions.delete(asideQuestions.keys().next().value);
      }
      await commands.answerQuestion(questionOf(c, q));
    },
    showAttention: async () => {
      const items = needs.items();
      if (!items.length) { vscode.window.showInformationMessage('No conversation needs you now.'); return; }
      const several = registry.size > 1;
      const pick = await vscode.window.showQuickPick(items.map((it) => ({ label: it.title,
        description: `${it.kind === 'waiting' ? waitReason.description(it.waitingFor) : 'finished'}${several ? ' · ' + it.source : ''}`,
        detail: it.cwd || undefined, it })),
      { placeHolder: 'Conversations that need you' });
      if (pick) await commands.openAttention(pick.it.sourceId, pick.it.sessionId);
    },
    statusLines: () => [
      `Answers folder: ${answersDir()} (${courier ? 'in use' : 'not made yet'})`,
      `In front: ${focus.sourceId ? `${focus.sourceId} ${focus.sessionId || '(no session yet)'}` : 'nothing'}`,
      ...registry.list().map((e) => `Source ${e.id}: ${sources.labelOf(e.source)}, from ${sources.extensionOf(e.source) || 'an unnamed extension'}, `
        + `plans in ${sources.planDirOf(e.source) || '(none given)'}`),
    ],
  };

  /* ── Trust, settings, folders, the tick ── */
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    keep(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      answerView.setRestricted(false);
      courierNow();
      pumpSoon();
      refreshConversations(false);
      if (opts.limit) opts.limit.start();
    }));
  }
  keep(vscode.workspace.onDidChangeWorkspaceFolders(() => refreshConversations(true)));
  keep(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CONFIG}.conversationsView`) || e.affectsConfiguration(`${CONFIG}.workPlanView`)
      || e.affectsConfiguration(`${CONFIG}.notifications`)) refreshConversations(true);
  }));
  const tick = setInterval(() => {
    askAll();
    refreshPlans();
    try { if (courier) { courier.sweep(); courier.pump(); } } catch (e) { say('answer: ' + ((e && e.message) || e)); }
  }, Number.isFinite(opts.refreshMs) ? opts.refreshMs : REFRESH_MS);
  if (opts.limit && trusted()) opts.limit.start();
  claimTab(true);
  refreshPlans();
  paintBadge();

  return {
    attach,
    detach,
    commands,
    setActive(on) { active = !!on; paintConversations(); },
    /* A dependent started listening for every conversation, so a pass runs at once. */
    listSoon() { askAll(); convSoon(); },
    planSummary: (sourceId, sessionId) => summaryFor(sourceId, sessionId),
    deliver,
    /* Whether this window tells the user when a conversation starts to wait. While it does, a source can leave out its
       agent's own notice of the wait. */
    announcesWaits() { const s = notifySettings(); return !closing && !!active && trusted() && s.enabled && s.waiting; },
    /* For tests. */
    _parts: { workplan, view, conversationsTree, conversationsView, statusEntry, attentionEntry, needs, opener, answerView, focus, courier: () => courier,
      deliveries: () => deliveries.size,
      plans: () => [...plans.keys()], summaries: () => [...summaries.values()].map((s) => [s.sourceId, s.sessionId]) },
    dispose() {
      closing = true;
      clearInterval(tick);
      if (answersPoll) { clearInterval(answersPoll); answersPoll = 0; }
      if (plansTimer) clearTimeout(plansTimer);
      if (convTimer) clearTimeout(convTimer);
      if (drawTimer) clearTimeout(drawTimer);
      if (rereadTimer) clearTimeout(rereadTimer);
      if (answersSoon) clearTimeout(answersSoon);
      dropWatch();
      if (courier) courier.dispose();
      for (const [t, fn] of waits) { clearTimeout(t); try { fn(); } catch (_) { /* closing anyway */ } }
      waits.clear();
      for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* already disposed */ } }
    },
  };
}

module.exports = { create, REFRESH_MS, LIST_WAIT_MS, SLOW_MS, ZONE_KEY, MAX_SUMMARIES };
