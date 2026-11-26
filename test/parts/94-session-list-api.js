// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the core tells sources about the session list (docs/protocol.md, What the core tells sources): 'sessionList' among
 * its features, sessionListManages() true while the list archives and deletes on its own in this window and false in
 * Restricted Mode, sessionDeletionDue() saying when each conversation will be deleted, and its event when that changes,
 * here because the user turned deleting on its own off.
 */
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const DAY = 86400e3;
  const at = Date.now() - 30 * DAY;
  const source = (vscode) => {
    const ev = new vscode.EventEmitter();
    return { protocol: 1, id: 'codex', label: 'Codex', features: ['sessions', 'sessionImport'], onDidChangeSessions: ev.event,
      listConversations: async () => [], onDidChangeConversations: ev.event,
      listSessions: async () => ({ sessions: [{ sessionId: 'a', title: 'A', cwd: '/w', running: false, activity: 'stopped', lastActiveAt: at, lastReplyAt: at }], cursor: null }),
      sessionActions: { open: ['tab'], create: [], rename: false, delete: true, own: [] }, runSessionAction: async (a, ids) => ({ results: ids.map((x) => ({ sessionId: x, outcome: 'done' })) }),
      importSessions: async () => ({ archived: [{ sessionId: 'a', at }], groups: [], pinned: [], colors: {} }) };
  };

  {
    const b = boot(root, tmp, { config: { 'agentPlus.sessions.deleteAfterDays': 90 } });
    b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(tmp('ws')) }];
    const r = b.api.registerSource(source(b.vscode));
    await wait(600);
    const due = b.api.sessionDeletionDue('codex');
    eq([r.accepted, b.api.features.includes('sessionList'), b.api.sessionListManages(), Object.isFrozen(due), Math.round((due.a - at) / DAY)], [true, true, true, true, 90],
      'with the session list here, sessionListManages() is true, and sessionDeletionDue() says when each conversation goes: 90 days after it was archived');
    const heard = [];
    b.api.onDidChangeSessionDeletionDue((e) => heard.push(e));
    b.control.state.config['agentPlus.sessions.deleteArchived'] = false;
    b.control.changeConfig(['agentPlus.sessions.deleteArchived']);
    await wait(1200);
    eq([heard.slice(0, 1), b.api.sessionDeletionDue('codex').a, b.api.sessionDeletionDue('nobody')], [[{ sourceId: 'codex' }], null, {}],
      'turning deleting on its own off is told, and then nothing is due; a source with no conversations in the list has none');
    b.close();
  }
  {
    const b = boot(root, tmp, { trusted: false });
    b.api.registerSource(source(b.vscode));
    await wait(400);
    eq(b.api.sessionListManages(), false, 'in Restricted Mode the list archives and deletes nothing, so a source keeps its own clean-up');
    b.close();
  }
  {
    const b = boot(root, tmp, { views: false });
    eq([b.api.sessionListManages(), b.api.sessionDeletionDue('codex')], [false, {}], 'and without the views, neither does the core');
    b.close();
  }
};
