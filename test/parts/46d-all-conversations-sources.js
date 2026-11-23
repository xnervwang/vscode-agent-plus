// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * allConversations() as sources come and go and fail (src/host.js, src/views.js): a source unregistered leaves the list
 * and that is told as a change; a source whose machine-wide list fails still gives this window's; every listener is
 * told, and the lists are read while any of them listens.
 */
const fake = require('../fake-vscode');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const viewOptions = { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 20, attentionWarmupMs: 0, attentionBatchMs: 10 };
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await wait(20); };
  const ids = () => b.api.allConversations().map((c) => `${c.sourceId}:${c.sessionId.slice(0, 4)}`);
  const b = boot(root, tmp, { viewOptions, config: { 'agentPlus.notifications.enabled': false } });
  const aChanged = new fake.EventEmitter(), bChanged = new fake.EventEmitter();
  let asked = 0;
  b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', onDidChangeConversations: aChanged.event,
    listConversations: async () => [{ sessionId: 'aaaa0000-0000-4000-8000-000000000001', title: 'Here only', cwd: '/w', lastActiveAt: 1 }],
    listAllConversations: async () => { asked++; throw new Error('claude agents failed'); } });
  const second = b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', onDidChangeConversations: bChanged.event,
    listConversations: async () => [{ sessionId: 'bbbb0000-0000-4000-8000-000000000002', title: 'Codex one', cwd: '/w', lastActiveAt: 2 }] });
  const toldA = [], toldB = [];
  const subA = b.api.onDidChangeAllConversations(() => toldA.push(ids()));
  const subB = b.api.onDidChangeAllConversations(() => toldB.push(ids()));
  await until(() => toldA.length && toldB.length);
  eq([toldA, toldB, asked > 0], [[['claude-code:aaaa', 'codex:bbbb']], [['claude-code:aaaa', 'codex:bbbb']], true],
    'a source whose machine-wide list fails still gives the conversations this window lists, and every listener is told');

  second.registration.dispose();
  await until(() => toldA.length > 1);
  eq([toldA.length, ids()], [2, ['claude-code:aaaa']], 'a source unregistered leaves the list, and that is told as a change');

  subA.dispose();
  const before = asked;
  aChanged.fire();
  await until(() => asked > before);
  eq(asked > before, true, 'with one listener gone, the lists are still read for the other');
  subB.dispose();
  const after = asked;
  aChanged.fire();
  await wait(250);
  eq(asked, after, 'and once no listener is left, they are not');
  b.close();
};
