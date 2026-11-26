// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list put into the window (src/views.js builds it): the list itself (src/session-list.js) with what it
 * needs from this window, its webview view (src/session-list-view.js), the commands of its view title and
 * Ctrl+Shift+T, and the context key that gives Ctrl+Shift+T to the list only when a conversation was what this window
 * closed last.
 *
 * A conversation asks the user a question when its plan has a question row put after the user's last message, as for
 * the Conversations view (src/conversations.js activityOf). Plans are read only for conversations active in the last
 * ASKS_DAYS days, since the list may hold thousands; an older question is one the user has seen for that long.
 */
const sources = require('./sources');
const { planQuestions } = require('./folders');
const { createSessionList } = require('./session-list');
const { SessionListView } = require('./session-list-view');
const rules = require('./session-rules');

const VIEW_ID = 'agentPlus.sessions';
const SETTINGS = 'agentPlus.sessions';
const CLOSED_KEY = 'agentPlus.lastClosedWasConversation';
const ASKS_DAYS = 14;

/*
 * `host` is { vscode, context, registry, say, trusted(), shared(name), planOf(sourceId, sessionId), openElsewhere(target) }
 * from src/views.js; `planOf` gives { plan } and `openElsewhere` brings another window's conversation forward.
 */
function startSessionList(host, opts = {}) {
  const { vscode, context, registry, say } = host;
  const now = opts.now || Date.now;
  const subs = [];
  const keep = (d) => { if (d) subs.push(d); return d; };
  const settings = () => {
    const c = vscode.workspace.getConfiguration(SETTINGS);
    const num = (k, d, min, max) => { const v = Number(c.get(k, d)); return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : d; };
    return { archiveAfterDays: num('archiveAfterDays', 14, 0, 3650), deleteArchived: c.get('deleteArchived', true) !== false,
      deleteAfterDays: num('deleteAfterDays', 90, 1, 3650), recentlyClosed: num('recentlyClosed', 10, 0, 50),
      hideBackground: c.get('hideBackground', true) !== false };
  };
  const asksOf = (sourceId, s) => {
    if (!(s.lastUserAt > 0) || now() - (s.lastActiveAt || 0) > ASKS_DAYS * 86400e3) return false;
    const got = host.planOf(sourceId, s.sessionId);
    const plan = got && got.plan;
    if (!plan || plan.error) return false;
    return planQuestions(plan.nodes).some((q) => q.since > s.lastUserAt);
  };
  let lastClosed = false;
  const setClosed = (on) => {
    if (on === lastClosed) return;
    lastClosed = on;
    Promise.resolve(vscode.commands.executeCommand('setContext', CLOSED_KEY, on)).catch(() => {});
  };
  const list = createSessionList({
    vscode, registry, say, trusted: host.trusted, settings, memento: context.workspaceState, globalMemento: context.globalState,
    asksOf, open: host.openElsewhere, shared: host.shared, closed: () => setClosed(true),
  }, opts.list || {});
  const view = new SessionListView(vscode, { list, extensionUri: context.extensionUri, say });
  keep(vscode.window.registerWebviewViewProvider(VIEW_ID, view));
  keep({ dispose: () => view.dispose() });

  /* A tab closed: a conversation's sets the key, anything else's clears it. */
  const groups = vscode.window.tabGroups;
  if (groups && typeof groups.onDidChangeTabs === 'function') {
    keep(groups.onDidChangeTabs((e) => {
      const gone = (e && e.closed) || [];
      if (!gone.length) return;
      const isConversation = (t) => (registry.entries || []).some((en) => sources.supports(en.source, 'sessions')
        && sources.usableId(sources.call(en.source, 'sessionForTab', [t], null)));
      setClosed(gone.some(isConversation));
    }));
  }
  keep(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(SETTINGS)) return;
    list.schedule();
    /* A new rule for archiving or deleting is applied at once rather than at the next hourly pass. */
    if (['archiveAfterDays', 'deleteArchived', 'deleteAfterDays'].some((k) => e.affectsConfiguration(`${SETTINGS}.${k}`))) {
      setTimeout(() => { list.refresh().then(() => list.sweep({ now: true })).catch((err) => say(`session list: sweep: ${(err && err.message) || err}`)); }, 500);
    }
  }));
  keep(vscode.workspace.onDidChangeWorkspaceFolders(() => list.folderChanged()));
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    keep(vscode.workspace.onDidGrantWorkspaceTrust(() => { list.store().flush(); list.schedule(); }));
  }
  const tick = setInterval(() => list.schedule(), Number.isFinite(opts.tickMs) ? opts.tickMs : 30000);
  keep({ dispose: () => clearInterval(tick) });

  const reveal = () => Promise.resolve(vscode.commands.executeCommand(`${VIEW_ID}.focus`)).catch(() => {});
  const commands = {
    searchSessions: async () => { if (!view.visible) await reveal(); view.tell({ type: 'search' }); },
    filterSessions: async () => { if (!view.visible) await reveal(); view.tell({ type: 'filter' }); },
    newSessionGroup: async () => {
      if (!view.visible) await reveal();
      const r = await list.groupAct('newGroup');
      if (r && r.renameGroup) view.tell({ type: 'startRenameGroup', groupId: r.renameGroup });
    },
    /* Find Conversation: the list's conversations of every agent, by title, branch, or four or more characters of the id
       (src/session-rules.js matches); picking one opens it as a click on its row would. */
    findConversation: () => {
      const qp = vscode.window.createQuickPick();
      qp.placeholder = 'Search titles, or four or more characters of a conversation id';
      const labels = new Map((registry.entries || []).map((e) => [e.id, sources.labelOf(e.source)]));
      const items = (q) => list.rows().filter((r) => !r.hidden && rules.matches(r, q)).sort(rules.compare).slice(0, 200)
        .map((r) => ({ label: r.title || '(untitled)', description: `${labels.get(r.sourceId) || r.sourceId}${r.archived ? ' · archived' : ''}`,
          detail: r.sessionId, key: r.key, alwaysShow: true }));
      qp.items = items('');
      if (typeof qp.onDidChangeValue === 'function') qp.onDidChangeValue((q) => { qp.items = items(String(q || '').trim()); });
      qp.onDidAccept(() => { const it = qp.selectedItems[0]; qp.hide(); if (it) list.open(it.key).catch((e) => say(`find: ${(e && e.message) || e}`)); });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    },
    /* Ctrl+Shift+T while a conversation was closed last: the conversation; with none left to reopen, the editor VS Code
       would have reopened. */
    reopenClosedConversation: async () => {
      const r = await list.reopenLast();
      if (r !== null) return;
      setClosed(false);
      await vscode.commands.executeCommand('workbench.action.reopenClosedEditor');
    },
  };

  return {
    list, view, commands,
    attach: () => list.schedule(),
    detach: () => list.schedule(),
    statusLines: () => {
      const p = list.project();
      return [`Session list: project ${p.label} (${p.key}), ${list.rows().length} conversations, ${list.manages() ? 'archives and deletes on its own here' : 'read only here'}`];
    },
    dispose() { for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } list.dispose(); },
  };
}

module.exports = { startSessionList, VIEW_ID, SETTINGS, CLOSED_KEY, ASKS_DAYS };
