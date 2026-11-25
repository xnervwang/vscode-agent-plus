// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The interface's allConversations() and onDidChangeAllConversations (src/host.js, src/views.js), for an extension
 * that links to conversations: the list holds each source's machine-wide conversations and this window's, is gathered
 * only while someone listens or the notifications are on, and listeners hear of a change only when a conversation
 * comes, goes, or is retitled. Also how such a link opens its conversation: agentPlus.openConversation with the
 * sourceId, sessionId, title and cwd of a list entry. With the notifications off and someone listening, the window's
 * attention file still lists its running conversations, for the other windows and dependent extensions that read it.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const viewOptions = { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 20, attentionWarmupMs: 0, attentionBatchMs: 10 };
  const C = '2bffe83d-78b2-4e4a-b15d-72b98b724ae2', D = 'aaaaaaaa-0000-4000-8000-000000000001', X = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await wait(20); };
  const b = boot(root, tmp, { viewOptions, config: { 'agentPlus.notifications.enabled': false } });
  const claudeChanged = new fake.EventEmitter(), codexChanged = new fake.EventEmitter();
  let machine = [{ sessionId: C, title: 'Black-box testing of ADV and AUV', cwd: '/w/a', lastActiveAt: 5000, running: true, state: 'working' }];
  const here = [{ sessionId: C, title: 'Black-box testing of ADV and AUV', cwd: '/w/a', lastActiveAt: 5000, running: true, state: 'working' },
    { sessionId: D, title: 'A stopped one with a plan', cwd: '/w/b', lastActiveAt: 1000, running: false, state: 'idle' }];
  let asked = 0;
  const opened = [];
  b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', onDidChangeConversations: claudeChanged.event,
    listConversations: async () => here.map((c) => Object.assign({}, c)),
    listAllConversations: async () => { asked++; return machine.map((c) => Object.assign({}, c)); } });
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', onDidChangeConversations: codexChanged.event,
    listConversations: async () => [{ sessionId: X, title: '\u{1F451} Fix the login redirect', steward: true, cwd: '/w/c', lastActiveAt: 9000 }],
    open: async (id, row) => { opened.push([id, row.title, row.cwd]); return 'here'; } });
  await wait(250);
  eq([asked, b.api.allConversations().length], [0, 0],
    'with the notifications off and nothing listening, no source is asked for its machine-wide list and none is kept');

  const told = [];
  const sub = b.api.onDidChangeAllConversations(() => told.push(b.api.allConversations().map((c) => c.sessionId.slice(0, 4))));
  await until(() => told.length);
  const list = b.api.allConversations();
  eq([told, list.map((c) => [c.sourceId, c.label, c.sessionId, c.title, c.cwd, c.lastActiveAt]), Object.isFrozen(list), Object.isFrozen(list[0])],
    [[['2bff', 'aaaa', '0199']], [['claude-code', 'Claude Code', C, 'Black-box testing of ADV and AUV', '/w/a', 5000],
      ['claude-code', 'Claude Code', D, 'A stopped one with a plan', '/w/b', 1000],
      ['codex', 'Codex', X, 'Fix the login redirect \u{1F451}', '/w/c', 9000]], true, true],
    'when something starts to listen, a pass runs right away and lists each source\'s conversations, machine-wide and in this window, each one a single time with its agent\'s label');

  machine = [Object.assign({}, machine[0], { lastActiveAt: 7000 })];
  claudeChanged.fire();
  await wait(250);
  eq([told.length, b.api.allConversations()[0].lastActiveAt], [1, 7000], 'a conversation that is only active again fires no change, and the list still has its new time');
  machine.push({ sessionId: 'cccccccc-0000-4000-8000-000000000003', title: 'Another window', cwd: '/w/d', lastActiveAt: 8000, running: true });
  claudeChanged.fire();
  await until(() => told.length > 1);
  here[1].title = 'Renamed';
  claudeChanged.fire();
  await until(() => told.length > 2);
  eq([told.length, b.api.allConversations().map((c) => c.title)], [3, ['Black-box testing of ADV and AUV', 'Another window', 'Renamed', 'Fix the login redirect \u{1F451}']],
    'a new conversation and a renamed one each fire a change');

  const codex = b.api.allConversations().find((c) => c.sourceId === 'codex');
  await b.control.state.handlers['agentPlus.openConversation']({ sourceId: codex.sourceId, sessionId: codex.sessionId, title: codex.title, cwd: codex.cwd });
  eq(opened, [[X, 'Fix the login redirect \u{1F451}', '/w/c']],
    'a link built from the list opens its conversation with agentPlus.openConversation, which calls the source\'s own open()');

  sub.dispose();
  sub.dispose();
  const before = asked;
  claudeChanged.fire();
  await wait(250);
  eq(asked, before, 'once nothing listens and the notifications are off, no source is asked for its machine-wide list again');
  let threw = false;
  try { b.api.onDidChangeAllConversations(null); } catch (_) { threw = true; }
  eq(threw, true, 'a listener that is not a function is refused');
  b.close();

  {
    const W = 'dddddddd-0000-4000-8000-000000000004';
    const items = (home) => {
      const d = path.join(home, 'attention');
      let names = [];
      try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
      return names.flatMap((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')).items || []).map((it) => [it.sourceId, it.sessionId, it.activity]);
    };
    const q = boot(root, tmp, { viewOptions, config: { 'agentPlus.notifications.enabled': false } });
    q.api.registerSource({ protocol: 1, id: 'opencode-plus', label: 'OpenCode', listConversations: async () => [{ sessionId: W,
      title: 'Waits for approval', cwd: '/w/e', lastActiveAt: 3000, running: true, state: 'prompt', activity: 'waiting',
      waitingFor: { kind: 'permission', tool: 'bash' } }] });
    await wait(250);
    const before = items(q.home);
    const listening = q.api.onDidChangeAllConversations(() => {});
    await until(() => items(q.home).length);
    await wait(150);
    eq([before, items(q.home), q.control.state.said.filter((m) => String(m.message).includes('Waits for approval')).length,
      /need you/.test(q.control.state.status.find((x) => x.id === 'agentPlus.conversations').text)], [[], [['opencode-plus', W, 'waiting']], 0, false],
      'with the notifications off, the attention file lists the running conversations once something listens, and this window still shows no notification and no count');
    listening.dispose();
    q.close();
  }
};
