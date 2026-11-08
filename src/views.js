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
const { readPlanAt, countOpen, countUnknown, MAX_PLAN_BYTES } = require('./workplan');
const { WorkPlanProvider, ageSince } = require('./workplan-view');
const { ConversationsProvider, questionOf } = require('./conversations-view');
const conversations = require('./conversations');
const conversationsText = require('./conversations-text');
const folders = require('./folders');
const sourceIcons = require('./sourceicons');
const { AnswerView, questionKey } = require('./answer-view');
const answers = require('./answers');
const { sharedHome } = require('./files');

const CONFIG = 'agentWorkPlan';
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
const ZONE_KEY = 'agentWorkPlan.timeZone';
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
  const statOf = (file) => { try { return fs.statSync(file); } catch (_) { return null; } };
  const planOf = (sourceId, session) => {
    const source = registry.get(sourceId);
    const file = source ? sources.planFileOf(source, session) : '';
    if (!file) return { file: '', plan: null };
    const st = statOf(file);
    const had = plans.get(file);
    if (st && had && had.session === session && had.mtimeMs === st.mtimeMs && had.size === st.size) return { file, plan: had.plan };
    const plan = readPlanAt(file, session, MAX_PLAN_BYTES);
    /*
     * The protocol asks nothing of how a plan file is written, so a reader can land in the middle of one. A file that
     * does not parse and was written moments ago is being written right now: the plan that last parsed is shown for a
     * little longer rather than a warning row that will be gone by the next pass, and a conversation that has stopped
     * does not drop out of the list and come back. A file that still does not parse after that says so.
     */
    if (plan && plan.error && had && had.plan && !had.plan.error && st && Date.now() - st.mtimeMs < WRITING_MS) {
      return { file, plan: had.plan };
    }
    if (st) plans.set(file, { session, mtimeMs: st.mtimeMs, size: st.size, plan });
    else plans.delete(file);
    return { file, plan };
  };
  const planMtime = (file) => { const had = plans.get(file); if (had) return had.mtimeMs; const st = statOf(file); return st ? st.mtimeMs : 0; };
  const workplan = new WorkPlanProvider({ read: (session, sourceId) => planOf(sourceId, session).plan });
  workplan.setScoped(true);
  const view = keep(vscode.window.createTreeView('agentWorkPlan.workPlan', { treeDataProvider: workplan }));
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
  const conversationsTree = new ConversationsProvider();
  const conversationsView = keep(vscode.window.createTreeView('agentWorkPlan.conversations', { treeDataProvider: conversationsTree }));
  const conversationsOn = () => cfg().get('conversationsView', true) !== false;
  const conversationsLang = () => conversationsText.language(vscode.env.language);
  const statusEntry = keep(vscode.window.createStatusBarItem('agentWorkPlan.conversations', vscode.StatusBarAlignment.Right, 100));
  statusEntry.name = 'Conversations';
  statusEntry.command = 'agentWorkPlan.showConversations';
  const paintConversations = () => {
    const t = conversationsText.textFor(conversationsTree.lang);
    const asks = conversationsTree.data.asks;
    conversationsView.title = t.view;
    conversationsView.badge = asks ? { value: asks, tooltip: t.badge(asks) } : undefined;
    if (!active || !conversationsOn()) { statusEntry.hide(); return; }
    statusEntry.text = '$(comment-discussion) ' + (asks ? t.status(asks) : t.statusIdle(conversationsTree.data.running.length));
    statusEntry.tooltip = t.statusTip;
    statusEntry.backgroundColor = asks ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    statusEntry.show();
  };

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
      if (st.askAgain) { st.askAgain = false; st.repaint = false; st.askNext = true; refreshConversations(false); }
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
  const rowIcon = (source, state) => {
    if (!trusted()) return undefined;
    const logo = sources.logoOf(source);
    if (!logo) return undefined;
    const files = sourceIcons.iconsFor(logo, state, iconsDir(), rowIcons);
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
        return;
      }
      const asked = registry.list();
      const got = await Promise.all(asked.map((entry) => listFor(entry, cachedOnly)));
      if (closing) return;
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
      const data = conversations.assemble({ lists, folders: roots, planOf, modified: planMtime, inFolder });
      for (const c of data.running.concat(data.stopped)) {
        const source = registry.get(c.sourceId);
        c.source = { id: c.sourceId, label: sources.labelOf(source) || c.sourceId };
        if (several) { try { const icon = rowIcon(source, c.state); if (icon) c.icon = icon; } catch (_) { /* the row keeps the state icon */ } }
      }
      const problem = problems.map(([source, what]) => (several ? sources.labelOf(source) + ': ' + what : what)).join('\n');
      conversationsTree.set(data, problem, conversationsLang());
      answerView.setLanguage(conversationsLang());
      /* The question on screen is only as good as the last pass: the row it is on may have been reworded, finished, or
         its conversation stopped. */
      answerView.revise((key) => questionNow(data, key));
      paintConversations();
    } catch (e) {
      say('conversations: ' + ((e && e.message) || e));
    } finally {
      convBusy = false;
      if (convAgain !== null && !closing) { const cached = convAgain; convAgain = null; refreshConversations(false, cached); }
    }
  };

  /* The question named `key` as the latest list has it, or null when no row is asking it any more. */
  const questionNow = (data, key) => {
    for (const c of data.running.concat(data.stopped)) {
      for (const q of c.questions) if (questionKey(c.sourceId, c.sessionId, q.row) === key) return questionOf(c, q);
    }
    return null;
  };

  const refreshPlans = () => {
    if (closing) return;
    workplan.setTimeZone(readerZone());
    const moved = workplan.setFocus(focus.sessionId, focus.sourceId);
    paintPlanView();
    if (workplan.refresh() || moved) paintBadge();
    refreshConversations(false);
  };
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
  const convSoon = () => {
    if (closing || convTimer) return;
    convTimer = setTimeout(() => { convTimer = 0; refreshConversations(false); }, soon);
  };

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
      try {
        const c = courierNow();
        if (!c) throw new Error('no answer folder');
        const body = answers.message(q.row, q.question, text);
        answerView.setState(q.key, { kind: 'waiting' });
        c.send({ sourceId: q.sourceId, sessionId: q.sessionId, row: q.row, text: body }, { key: q.key });
      } catch (e) {
        say('answer: ' + ((e && e.message) || e));
        Promise.resolve(vscode.env.clipboard.writeText(answers.message(q.row, q.question, text))).catch(() => {});
        answerView.setState(q.key, { kind: 'error' });
      }
    },
  });
  answerView.setLanguage(conversationsLang());
  answerView.setRestricted(!trusted());
  keep(vscode.window.registerWebviewViewProvider('agentWorkPlan.answer', answerView, { webviewOptions: { retainContextWhenHidden: true } }));

  /* Created only once a source is registered and the window is trusted, which is also when the folder is made. */
  let courier = null, answersWatch = null, answersSoon = 0, answersPoll = 0;
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
  const tuneAnswerPoll = () => {
    const want = !!courier && !closing && mayDeliver();
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
        if (result.outcome === 'notReceived') Promise.resolve(vscode.env.clipboard.writeText(sent.text)).catch(() => {});
        answerView.setState(sent.key, { kind: result.outcome, reason: result.reason || '' });
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
  const commands = {
    refreshWorkPlan: () => { plans.clear(); workplan.signature = ''; refreshPlans(); refreshConversations(true); },
    openWorkPlanFile: async (element) => {
      const file = (element && element.plan && element.plan.file) || (workplan.shown() && workplan.shown().file);
      if (!file) { vscode.window.showInformationMessage('Agent Work Plan: the conversation in front is not keeping a work plan.'); return; }
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
      if (row.unknown) head.push('This version of Agent Work Plan does not know this state.');
      const body = row.detail || 'No description was written for this one.';
      await vscode.window.showInformationMessage(row.title, { modal: true, detail: head.concat(['', body]).join('\n') });
    },
    answerQuestion: async (q) => {
      if (!q) return;
      answerView.show(q);
      await vscode.commands.executeCommand('agentWorkPlan.answer.focus');
    },
    showConversations: () => vscode.commands.executeCommand('agentWorkPlan.conversations.focus'),
    /* A conversation row goes to its conversation through its source. An extension cannot bring another window
       forward, so a source answers false for one that is open elsewhere, and then this says so. */
    openConversation: async (target) => {
      if (!target || !target.sessionId) return;
      const source = registry.get(target.sourceId);
      if (!source) return;
      let shown = false;
      const row = { title: typeof target.title === 'string' ? target.title : '', cwd: typeof target.cwd === 'string' ? target.cwd : '' };
      try { shown = (await sources.call(source, 'reveal', [target.sessionId, row], false)) === true; } catch (_) { shown = false; }
      if (shown) return;
      const where = row.cwd ? ` (folder ${row.cwd})` : '';
      vscode.window.showInformationMessage(`"${row.title || target.sessionId}" could not be brought to front from this window${where}. `
        + 'It may be open in another window.');
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
    if (e.affectsConfiguration(`${CONFIG}.conversationsView`) || e.affectsConfiguration(`${CONFIG}.workPlanView`)) refreshConversations(true);
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
    /* For tests. */
    _parts: { workplan, view, conversationsTree, conversationsView, statusEntry, answerView, focus, courier: () => courier },
    dispose() {
      closing = true;
      clearInterval(tick);
      if (answersPoll) { clearInterval(answersPoll); answersPoll = 0; }
      if (plansTimer) clearTimeout(plansTimer);
      if (convTimer) clearTimeout(convTimer);
      if (drawTimer) clearTimeout(drawTimer);
      if (answersSoon) clearTimeout(answersSoon);
      dropWatch();
      if (courier) courier.dispose();
      for (const [t, fn] of waits) { clearTimeout(t); try { fn(); } catch (_) { /* closing anyway */ } }
      waits.clear();
      for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* already disposed */ } }
    },
  };
}

module.exports = { create, REFRESH_MS, LIST_WAIT_MS, SLOW_MS, ZONE_KEY };
