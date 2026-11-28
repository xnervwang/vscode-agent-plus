// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The conversation source of the window test (test/vscode/ui.js), loaded as a development extension. It goes by Codex
 * Plus's extension id and declares Codex Plus's five feature settings, because Agent Plus's token mode reads those
 * settings only from extensions it knows.
 *
 * Each conversation is a webview tab of its own. Opening a conversation's tab marks its reply as seen, as Claude Code
 * and Codex do. ui.js changes the conversations by calling the object activate() returns, through the helper
 * extension's control folder.
 *
 * The plans are read from AGENT_PLUS_UI_PLANS, one <session id>.json each, which ui.js writes.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const VIEW = 'agentPlusTest.conversation';
/* The session fields a conversation of the window test has unless it gives them: started an hour before its last
   message, its last reply then, and seen unless it is marked unseen. */
const sessionDefaults = (c) => ({ createdAt: (c.lastActiveAt || Date.now()) - 3600e3, lastReplyAt: c.lastActiveAt,
  viewedAt: c.unseen ? 0 : c.lastActiveAt });
const NEW_TITLE = 'New conversation';

function activate(context) {
  const plans = process.env.AGENT_PLUS_UI_PLANS || path.join(context.globalStorageUri.fsPath, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const folder = () => ((vscode.workspace.workspaceFolders || [])[0] || { uri: { fsPath: '' } }).uri.fsPath;
  const changed = new vscode.EventEmitter();
  const focused = new vscode.EventEmitter();
  const noticeChanged = new vscode.EventEmitter();
  context.subscriptions.push(changed, focused, noticeChanged);

  /* sessionId -> conversation as listed, in the order they were added. */
  const list = new Map();
  /* sessionId -> its tab's panel; '' -> a tab with no conversation yet. */
  const panels = new Map();
  const state = { problem: '', notice: null, canDeliver: true, outcome: { outcome: 'submitted' }, answers: [], revealed: [], ran: [], seenOnOpen: true,
    prefilled: [], prefillOutcome: { outcome: 'drafted' },
    /* The session list's part (docs/protocol.md, Session list): what it was asked to do and told, what it imports, its
       Account & usage part and its note. */
    calls: [], seen: [], imported: { archived: [], groups: [], pinned: [], colors: {} }, account: null, sessionsNotice: null, made: 0,
    /* Conversations whose tab gets '' from sessionForTab, as a source answers before it knows which
       conversation a tab shows. */
    unknownTabs: [] };
  const closedEv = new vscode.EventEmitter(), accountEv = new vscode.EventEmitter(), sessionsNoticeEv = new vscode.EventEmitter();
  context.subscriptions.push(closedEv, accountEv, sessionsNoticeEv);

  const html = (title) => `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>`
    + `<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground)">`
    + `<h2>${String(title).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</h2><p>A stand-in conversation of the Agent Plus window test.</p></body></html>`;
  const sessionOfPanel = (panel) => { for (const [id, p] of panels) if (p === panel) return id; return null; };
  const frontTab = () => { const g = vscode.window.tabGroups.activeTabGroup; return g && g.activeTab; };
  /* A temporary conversation's tab title starts with this mark, as the agents' own extensions draw it. */
  const TEMP_MARK = '\u23f3 ';
  const isTemp = (id) => { const c = list.get(id); return !!c && (c.temp === true || (!!core && typeof core.isTemporary === 'function' && core.isTemporary('codex', id))); };
  const tabTitle = (id, c) => (id && isTemp(id) ? TEMP_MARK : '') + c.title;
  const tabSession = (tab) => {
    if (!tab || !(tab.input instanceof vscode.TabInputWebview) || !String(tab.input.viewType).endsWith(VIEW)) return undefined;
    if (tab.label === NEW_TITLE) return '';
    for (const [id, c] of list) if ((c.title === tab.label || TEMP_MARK + c.title === tab.label) && panels.has(id)) return state.unknownTabs.includes(id) ? '' : id;
    return undefined;
  };
  const markSeen = (id) => {
    const c = list.get(id);
    if (!state.seenOnOpen || !c || !c.unseen) return;
    c.unseen = false;
    if (c.state === 'unread') c.state = 'idle';
    changed.fire();
  };
  const openTab = (id, { preserveFocus = false } = {}) => {
    const c = id ? list.get(id) : null;
    if (id && !c) return false;
    const had = panels.get(id);
    if (had) { had.reveal(had.viewColumn, preserveFocus); return true; }
    const panel = vscode.window.createWebviewPanel(VIEW, c ? tabTitle(id, c) : NEW_TITLE, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {});
    panel.webview.html = html(c ? c.title : NEW_TITLE);
    panels.set(id, panel);
    panel.onDidChangeViewState((e) => {
      const sid = sessionOfPanel(e.webviewPanel);
      if (sid === null || !e.webviewPanel.active) return;
      if (sid) markSeen(sid);
      focused.fire({ sessionId: sid });
    });
    panel.onDidDispose(() => { if (panels.get(id) === panel) { panels.delete(id); if (id) closedEv.fire({ sessionId: id, where: 'tab' }); } });
    if (id && !preserveFocus) markSeen(id);
    return true;
  };

  const source = {
    protocol: 1,
    id: 'codex',
    label: 'Codex',
    extensionId: 'xnervwang.codex-plus',
    features: ['brief', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'sessionClose', 'accountInfo', 'sessionsNotice', 'temporary'],
    logo: { light: vscode.Uri.file(path.join(__dirname, 'logo-codex.svg')), dark: vscode.Uri.file(path.join(__dirname, 'logo-codex.svg')) },
    planPath: (id) => path.join(plans, `${id}.json`),
    planDir: () => plans,
    sessionForTab: (tab) => tabSession(tab),
    onDidFocus: focused.event,
    isFocused: (id) => tabSession(frontTab()) === id,
    listConversations: async () => {
      const out = [...list.values()].map((c) => Object.assign({ cwd: folder() }, c));
      if (state.problem) out.problem = state.problem;
      return out;
    },
    onDidChangeConversations: changed.event,
    reveal: async (id) => { state.revealed.push(id); return openTab(id); },
    canDeliver: () => state.canDeliver,
    deliverAnswer: async (id, text, opts) => {
      state.answers.push({ sessionId: id, text, deliveryId: opts && opts.deliveryId });
      return state.outcome;
    },
    planNotice: () => state.notice,
    onDidChangePlanNotice: noticeChanged.event,
    /* The session list. A conversation's session fields are the ones set() gave it, over sessionDefaults(). */
    listSessions: async ({ cursor, limit }) => {
      const all = [...list.values()].map((c) => Object.assign({ cwd: folder() }, sessionDefaults(c), c));
      const from = cursor ? Number(cursor) : 0;
      return { sessions: all.slice(from, from + limit), cursor: from + limit < all.length ? String(from + limit) : null };
    },
    onDidChangeSessions: changed.event,
    sessionActions: { open: ['tab'], create: ['tab'], rename: true, delete: true, own: [{ id: 'goal.pause', title: 'Pause Goal' }] },
    runSessionAction: async (action, ids, args) => {
      state.calls.push([action, ids, args]);
      if (action === 'create') {
        const id = `made-${++state.made}`;
        list.set(id, { sessionId: id, title: `New conversation ${state.made}`, state: 'idle', activity: 'stopped', running: false, lastActiveAt: Date.now(),
          ...(args && args.temporary === true ? { temp: true, lastUserAt: Date.now() } : {}) });
        openTab(id);
        changed.fire();
        return { results: [{ sessionId: id, outcome: 'done' }] };
      }
      const results = ids.map((id) => {
        const c = list.get(id);
        if (!c) return { sessionId: id, outcome: 'failed', reason: 'no such conversation' };
        if (action === 'open') openTab(id);
        else if (action === 'rename') { c.title = String(args.title); const p = panels.get(id); if (p) p.title = c.title; }
        else if (action === 'delete' && args && args.temporary === true) {
          if (!core.isTemporary('codex', id)) return { sessionId: id, outcome: 'refused', reason: 'it is not temporary' };
          if (panels.has(id)) return { sessionId: id, outcome: 'refused', reason: 'it is open in a tab' };
          list.delete(id);
        } else if (action === 'delete') { const p = panels.get(id); if (p) p.dispose(); list.delete(id); }
        return { sessionId: id, outcome: 'done' };
      });
      changed.fire();
      return { results };
    },
    describeDeletion: async (ids) => ids.map((id) => ({ sessionId: id, what: 'its stand-in record' })),
    wantSessionDetail: (ids) => { state.calls.push(['wantDetail', ids]); },
    importSessions: async () => state.imported,
    noteSeen: (ids, seen) => { state.seen.push([ids, seen]); },
    onDidCloseSession: closedEv.event,
    accountInfo: () => state.account,
    onDidChangeAccountInfo: accountEv.event,
    sessionsNotice: () => state.sessionsNotice,
    onDidChangeSessionsNotice: sessionsNoticeEv.event,
    /* configure() sets what this answers for a conversation in its list. */
    prefill: async (id, text) => {
      state.prefilled.push({ sessionId: id, text });
      if (!openTab(id)) return { outcome: 'notReceived', reason: 'no such conversation' };
      return state.prefillOutcome;
    },
  };

  const api = vscode.extensions.getExtension('xnervwang.agent-plus');
  const core = ((api && api.exports) || {}).agentPlus;
  const result = core ? core.registerSource(source) : { accepted: false, reason: 'Agent Plus gave no interface' };
  if (result.registration) context.subscriptions.push(result.registration);
  /* A conversation kept as ordinary loses the mark on its tab. */
  if (core && typeof core.onDidChangeTemporary === 'function') {
    context.subscriptions.push(core.onDidChangeTemporary(() => {
      for (const [id, p] of panels) { const c = id && list.get(id); if (!c) continue; if (c.temp && !core.isTemporary('codex', id)) delete c.temp; p.title = tabTitle(id, c); }
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('agentPlusTest.installPlugin', () => { state.ran.push('installPlugin'); }));

  /* A second source: once two are registered, Agent Plus draws each row with its agent's logo. */
  let other = null;
  const otherList = new Map();
  const otherChanged = new vscode.EventEmitter();
  context.subscriptions.push(otherChanged);
  let third = null;
  const thirdList = new Map();
  const thirdChanged = new vscode.EventEmitter();
  context.subscriptions.push(thirdChanged);
  const otherState = { calls: [], sidebar: [], place: {}, imported: null, account: null, accountEv: new vscode.EventEmitter() };
  const thirdState = { calls: [], sidebar: [], place: {}, imported: null, account: null, accountEv: new vscode.EventEmitter() };
  context.subscriptions.push(otherState.accountEv, thirdState.accountEv);
  /* A source with no tabs of its own: what it is asked to do is recorded, and a conversation opened in the sidebar counts
     as shown there. shownIn gives the test's `place` entry for each conversation, and nothing when none is set; its
     Account & usage part is the state's `account`. */
  const sessionsSource = (id, label, logo, m, ev, st, more) => Object.assign({
    protocol: 1, id, label, extensionId: `xnervwang.${id}-plus`, features: ['sessions', 'sessionImport', 'shows', 'shownIn', 'accountInfo'],
    logo: { light: vscode.Uri.file(path.join(__dirname, logo)), dark: vscode.Uri.file(path.join(__dirname, logo)) },
    planDir: () => plans,
    listSessions: async () => ({ sessions: [...m.values()].map((c) => Object.assign(sessionDefaults(c), c)), cursor: null }),
    importSessions: async () => st.imported,
    onDidChangeSessions: ev.event,
    sessionActions: { open: ['tab', 'sidebar'], create: ['tab', 'sidebar'], rename: true, delete: true, own: [] },
    runSessionAction: async (action, ids, args) => {
      st.calls.push([action, ids, args]);
      if (action === 'open' && args.where === 'sidebar') st.sidebar = ids.slice();
      if (action === 'delete') for (const x of ids) m.delete(x);
      if (action === 'rename') for (const x of ids) if (m.get(x)) m.get(x).title = String(args.title);
      ev.fire();
      return { results: ids.map((x) => ({ sessionId: x, outcome: 'done' })) };
    },
    shows: (x) => st.sidebar.includes(x),
    shownIn: (x) => st.place[x],
    accountInfo: () => st.account,
    onDidChangeAccountInfo: st.accountEv.event,
  }, more);

  return {
    result: { accepted: result.accepted, code: result.code, reason: result.reason },
    plans,
    state,
    /* Replaces the whole list, with rows shaped as in the protocol's Conversations table. */
    set(conversations) {
      list.clear();
      for (const c of conversations) list.set(c.sessionId, Object.assign({}, c));
      changed.fire();
      return [...list.keys()];
    },
    patch(id, fields) {
      const c = list.get(id);
      if (!c) return false;
      Object.assign(c, fields);
      changed.fire();
      return true;
    },
    conversations: () => [...list.values()].map((c) => Object.assign({}, c)),
    open: (id, opts) => openTab(id, opts),
    openNew: () => openTab(''),
    close(id) {
      const p = panels.get(id);
      if (p) p.dispose();
      return !!p;
    },
    closeAll() { for (const p of [...panels.values()]) p.dispose(); return true; },
    tabs: () => [...panels.keys()],
    setNotice(notice) { state.notice = notice; noticeChanged.fire(); return true; },
    setProblem(text) { state.problem = text || ''; changed.fire(); return true; },
    configure(fields) { Object.assign(state, fields); accountEv.fire(); sessionsNoticeEv.fire(); changed.fire(); return true; },
    addOther(conversations) {
      if (other) return true;
      otherList.clear();
      for (const c of conversations) otherList.set(c.sessionId, Object.assign({ cwd: folder() }, c));
      const r = core.registerSource(sessionsSource('claude-code', 'Claude Code', 'logo-claude.svg', otherList, otherChanged, otherState,
        { listConversations: async () => [...otherList.values()], onDidChangeConversations: otherChanged.event, planPath: (id) => path.join(plans, `claude-${id}.json`) }));
      other = r.registration;
      return r.accepted;
    },
    removeOther() { if (other) other.dispose(); other = null; return true; },
    /* A third agent, with conversations for the session list only. */
    addThird(conversations, imported) {
      if (third) return true;
      thirdState.imported = imported || null;
      thirdList.clear();
      for (const c of conversations) thirdList.set(c.sessionId, Object.assign({ cwd: folder() }, c));
      const r = core.registerSource(sessionsSource('opencode', 'OpenCode', 'logo-opencode.svg', thirdList, thirdChanged, thirdState, {}));
      third = r.registration;
      return r.accepted;
    },
    removeThird() { if (third) third.dispose(); third = null; return true; },
    setOther(which, conversations) {
      const [m, ev] = which === 'opencode' ? [thirdList, thirdChanged] : [otherList, otherChanged];
      m.clear();
      for (const c of conversations) m.set(c.sessionId, Object.assign({ cwd: folder() }, c));
      ev.fire();
      return true;
    },
    otherState: (which) => (which === 'opencode' ? thirdState : otherState),
    /* Sets fields on the state of source `which` (its Account & usage part, say) and fires its account change event, so
       that Agent Plus reads it again. */
    configureOther(which, fields) {
      const st = which === 'opencode' ? thirdState : otherState;
      Object.assign(st, fields);
      st.accountEv.fire();
      return true;
    },
    /* Makes sessionForTab answer '' for this conversation's tab until knowTab(), and fires the change event so the list
       looks again. */
    forgetTab(id) { if (!state.unknownTabs.includes(id)) state.unknownTabs.push(id); changed.fire(); return true; },
    knowTab(id) { state.unknownTabs = state.unknownTabs.filter((x) => x !== id); focused.fire({ sessionId: id }); return true; },
    /* Sets which conversations the tabless source's sidebar shows, and what its shownIn answers for each. */
    showIn(which, ids, place) {
      const [st, ev] = which === 'opencode' ? [thirdState, thirdChanged] : [otherState, otherChanged];
      st.sidebar = ids.slice();
      st.place = Object.assign({}, place || {});
      ev.fire();
      return true;
    },
  };
}

module.exports = { activate, deactivate() {} };
