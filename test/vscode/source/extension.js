// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The conversation source of the window test (test/vscode/ui.js), loaded as a development extension. It goes by Codex
 * Plus's extension id and declares Codex Plus's six feature settings, because Agent Plus's token mode reads those
 * settings only from extensions it knows.
 *
 * Each conversation is a webview tab of its own. Opening a conversation's tab
 * marks its reply as seen, as Claude Code and Codex do. ui.js changes the conversations through the object activate()
 * returns, from the extension host, by way of the helper extension's control folder.
 *
 * The plans are read from AGENT_PLUS_UI_PLANS, one <session id>.json each, which ui.js writes.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const VIEW = 'agentPlusTest.conversation';
const NEW_TITLE = 'New conversation';

function activate(context) {
  const plans = process.env.AGENT_PLUS_UI_PLANS || path.join(context.globalStorageUri.fsPath, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const folder = () => ((vscode.workspace.workspaceFolders || [])[0] || { uri: { fsPath: '' } }).uri.fsPath;
  const changed = new vscode.EventEmitter();
  const focused = new vscode.EventEmitter();
  const noticeChanged = new vscode.EventEmitter();
  context.subscriptions.push(changed, focused, noticeChanged);

  /* sessionId -> conversation as listed; the order is the order they were added. */
  const list = new Map();
  /* sessionId -> its tab's panel; '' -> a tab with no conversation yet. */
  const panels = new Map();
  const state = { problem: '', notice: null, canDeliver: true, outcome: { outcome: 'submitted' }, answers: [], revealed: [], ran: [], seenOnOpen: true };

  const html = (title) => `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>`
    + `<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground)">`
    + `<h2>${String(title).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</h2><p>A stand-in conversation of the Agent Plus window test.</p></body></html>`;
  const sessionOfPanel = (panel) => { for (const [id, p] of panels) if (p === panel) return id; return null; };
  const frontTab = () => { const g = vscode.window.tabGroups.activeTabGroup; return g && g.activeTab; };
  const tabSession = (tab) => {
    if (!tab || !(tab.input instanceof vscode.TabInputWebview) || !String(tab.input.viewType).endsWith(VIEW)) return undefined;
    if (tab.label === NEW_TITLE) return '';
    for (const [id, c] of list) if (c.title === tab.label && panels.has(id)) return id;
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
    const panel = vscode.window.createWebviewPanel(VIEW, c ? c.title : NEW_TITLE, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {});
    panel.webview.html = html(c ? c.title : NEW_TITLE);
    panels.set(id, panel);
    panel.onDidChangeViewState((e) => {
      const sid = sessionOfPanel(e.webviewPanel);
      if (sid === null || !e.webviewPanel.active) return;
      if (sid) markSeen(sid);
      focused.fire({ sessionId: sid });
    });
    panel.onDidDispose(() => { if (panels.get(id) === panel) panels.delete(id); });
    if (id && !preserveFocus) markSeen(id);
    return true;
  };

  const source = {
    protocol: 1,
    id: 'codex',
    label: 'Codex',
    extensionId: 'xnervwang.codex-plus',
    features: ['brief'],
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
  };

  const api = vscode.extensions.getExtension('xnervwang.agent-plus');
  const core = ((api && api.exports) || {}).agentPlus;
  const result = core ? core.registerSource(source) : { accepted: false, reason: 'Agent Plus gave no interface' };
  if (result.registration) context.subscriptions.push(result.registration);
  context.subscriptions.push(vscode.commands.registerCommand('agentPlusTest.installPlugin', () => { state.ran.push('installPlugin'); }));

  /* A second source, for the rows Agent Plus draws with each agent's logo once more than one is registered. */
  let other = null;
  const otherList = new Map();
  const otherChanged = new vscode.EventEmitter();
  context.subscriptions.push(otherChanged);

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
    configure(fields) { Object.assign(state, fields); return true; },
    addOther(conversations) {
      if (other) return true;
      otherList.clear();
      for (const c of conversations) otherList.set(c.sessionId, Object.assign({ cwd: folder() }, c));
      const r = core.registerSource({
        protocol: 1, id: 'claude-code', label: 'Claude Code', extensionId: 'xnervwang.claude-code-plus',
        logo: { light: vscode.Uri.file(path.join(__dirname, 'logo-claude.svg')), dark: vscode.Uri.file(path.join(__dirname, 'logo-claude.svg')) },
        planPath: (id) => path.join(plans, `claude-${id}.json`),
        listConversations: async () => [...otherList.values()],
        onDidChangeConversations: otherChanged.event,
      });
      other = r.registration;
      return r.accepted;
    },
    removeOther() { if (other) other.dispose(); other = null; return true; },
  };
}

module.exports = { activate, deactivate() {} };
