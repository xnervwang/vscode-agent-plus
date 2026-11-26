// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The pen on a row of the Work plan view (agentPlus.writeAboutRow in src/views.js, prefill in src/sources.js): the
 * plan's conversation is asked to put "About row N (title): " in its message box, in the display language. The pen
 * shows only for a conversation whose source lists 'prefill', and not in Restricted Mode.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

const S = 'aaaaaaaa-0000-4000-8000-00000000000a', N = 'bbbbbbbb-0000-4000-8000-00000000000b';
const KEY = 'agentPlus.workPlanCanPrefill';

module.exports = async ({ eq, tmp, root, wait }) => {
  const sources = require(path.join(root, 'src', 'sources.js'));

  /* ── The source's answer, as the core reads it ── */
  {
    const asked = (fn, features = ['prefill']) => sources.prefill({ features, prefill: fn }, S, 'About row 1 (x): ', 40);
    eq([await asked(async () => ({ outcome: 'drafted' })), await asked(async () => ({ outcome: 'notReceived', reason: 'no tab' }))],
      [{ outcome: 'drafted', reason: '' }, { outcome: 'notReceived', reason: 'no tab' }], 'an answer in the protocol\'s words is passed on');
    const odd = await Promise.all([
      asked(async () => ({ outcome: 'submitted' })), asked(async () => 'drafted'), asked(() => { throw new Error('broke'); }),
      asked(async () => { throw new Error('rejected'); }), asked(async () => ({ outcome: 'drafted' }), []),
    ]);
    eq(odd.map((r) => r.outcome), ['notReceived', 'notReceived', 'notReceived', 'notReceived', 'notReceived'],
      'anything other than an answer in the protocol\'s words is notReceived');
    eq([odd[2].reason, odd[3].reason, Object.isFrozen(odd[0])], ['broke', 'rejected', true], 'with the reason the source gave');
    eq((await asked(() => new Promise(() => {}))).outcome, 'uncertain', 'a source that does not answer in time is uncertain');
  }

  /* ── The pen in the Work plan view ── */
  const viewOptions = { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, debounceMs: 20, prefillWaitMs: 200 };
  const b = boot(root, tmp, { viewOptions, config: { 'agentPlus.notifications.enabled': false } });
  const ws = tmp('ws'), dir = tmp('plans');
  b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(ws) }];
  const title = 'Rewrite the parser so that it reads every format the importer has ever written, old ones too';
  for (const id of [S, N]) {
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ nodes: [
      { title: 'Pick the branch', state: 'waiting', waitingOn: 'user', question: 'Main or hotfix?' },
      { title: 'Port it', state: 'doing', children: [{ title, state: 'todo' }] }] }));
  }
  let answer = { outcome: 'drafted' };
  const asks = [];
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', features: ['prefill'], planPath: (id) => path.join(dir, id + '.json'), planDir: () => dir,
    listConversations: async () => [{ sessionId: S, title: 'Port the importer', cwd: ws, state: 'idle', running: true }],
    prefill: async (id, text) => { asks.push([id, text]); return typeof answer === 'function' ? answer() : answer; } });
  b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', planPath: (id) => path.join(dir, id + '.json'), planDir: () => dir,
    listConversations: async () => [{ sessionId: N, title: 'No pen here', cwd: ws, state: 'idle', running: true }] });
  await wait(120);
  const view = b.control.state.views['agentPlus.workPlan'];
  const run = (element) => b.control.state.handlers['agentPlus.writeAboutRow'](element);
  const rowOf = (label) => {
    const walk = (els) => {
      for (const e of els) {
        if (view.provider.getTreeItem(e).label === label) return e;
        const under = walk(view.provider.getChildren(e));
        if (under) return under;
      }
      return null;
    };
    return walk(view.provider.getChildren());
  };

  await b.control.state.handlers['agentPlus.showWorkPlanOf']({ sourceId: 'codex', sessionId: S });
  await wait(40);
  eq(b.control.state.context[KEY], true, 'a source that lists prefill gets the pen');
  b.control.state.said.length = 0;
  await run(rowOf('2.1. ' + title));
  eq([asks.pop(), b.control.state.clipboard, b.control.state.said.length],
    [[S, `About row 2.1 (${title.slice(0, 79)}…): `], '', 0],
    'a click asks the source to put "About row N (title): " in that conversation\'s message box, with the title cut at 80 characters');
  b.vscode.env.language = 'zh-cn';
  await run(rowOf('1. Pick the branch'));
  eq(asks.pop(), [S, '关于第 1 行（Pick the branch）：'], 'with VS Code in Chinese the text is 关于第 N 行（标题）：');
  b.vscode.env.language = 'en';

  answer = { outcome: 'notReceived', reason: 'no tab in this window shows it' };
  await run(rowOf('2. Port it'));
  eq([b.control.state.clipboard, b.control.state.said.map((m) => m.message)],
    ['About row 2 (Port it): ', ['Agent Plus could not put it in the conversation\'s message box: no tab in this window shows it. It is on the clipboard instead.']],
    'when the source could not, the text goes on the clipboard and the user is told why');
  b.control.state.said.length = 0;
  answer = () => new Promise(() => {});
  await run(rowOf('2. Port it'));
  eq(b.control.state.said.map((m) => m.message), ['Agent Plus could not tell whether it reached the conversation\'s message box. It is on the clipboard as well.'],
    'when the source does not answer in time, the text goes on the clipboard as well and the notification says it could not tell');
  b.control.state.said.length = 0;
  answer = { outcome: 'notReceived', reason: 'no tab in this window shows it' };
  const writeText = b.vscode.env.clipboard.writeText;
  b.vscode.env.clipboard.writeText = async () => { throw new Error('no clipboard'); };
  await run(rowOf('2. Port it'));
  b.vscode.env.clipboard.writeText = writeText;
  eq(b.control.state.said.map((m) => m.message),
    ['Agent Plus could not put it in the conversation\'s message box: no tab in this window shows it, nor on the clipboard. The text was: About row 2 (Port it): '],
    'when the clipboard cannot be written either, the notification says so and gives the text');

  await b.control.state.handlers['agentPlus.showWorkPlanOf']({ sourceId: 'claude-code', sessionId: N });
  await wait(40);
  eq(b.control.state.context[KEY], false, 'the Claude Code conversation, whose source does not list prefill, has none');
  b.close();

  /* ── Restricted Mode ── */
  const r = boot(root, tmp, { trusted: false, viewOptions, config: { 'agentPlus.notifications.enabled': false } });
  r.vscode.workspace.workspaceFolders = [{ uri: r.vscode.Uri.file(ws) }];
  const tried = [];
  r.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', features: ['prefill'], planPath: (id) => path.join(dir, id + '.json'), planDir: () => dir,
    listConversations: async () => [{ sessionId: S, title: 'Port the importer', cwd: ws, state: 'idle', running: true }],
    prefill: async (id, text) => { tried.push([id, text]); return { outcome: 'drafted' }; } });
  await wait(120);
  await r.control.state.handlers['agentPlus.showWorkPlanOf']({ sourceId: 'codex', sessionId: S });
  await wait(40);
  eq(r.control.state.context[KEY], false, 'in Restricted Mode no row has the pen');
  const restrictedView = r.control.state.views['agentPlus.workPlan'];
  const pick = restrictedView.provider.getChildren().find((e) => restrictedView.provider.getTreeItem(e).label === '1. Pick the branch');
  await r.control.state.handlers['agentPlus.writeAboutRow'](pick);
  eq([tried.length, r.control.state.clipboard, r.control.state.said.map((m) => m.message)],
    [0, 'About row 1 (Pick the branch): ', ['Agent Plus could not put it in the conversation\'s message box: this workspace is in Restricted Mode. It is on the clipboard instead.']],
    'and the command, run anyway, does not ask the source to type: the text goes on the clipboard');
  r.control.grantTrust();
  await wait(40);
  eq(r.control.state.context[KEY], true, 'once the workspace is trusted, the pen shows');
  r.close();
};
