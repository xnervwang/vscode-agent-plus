// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The pen on a row of the Work plan view (agentPlus.writeAboutRow in src/views.js, prefill in src/sources.js): the plan's
 * conversation is asked to put "About row N (title): " in its message box, in the display language, and the text goes
 * on the clipboard, with the reason, whenever the source did not say it is there. The pen is shown only while the
 * conversation shown is one whose source lists 'prefill'.
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
      'an outcome it does not know, an answer of another shape, a throw, a rejection and a source not listing prefill are all notReceived');
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
  eq(b.control.state.context[KEY], true, 'the pen shows for a conversation whose source lists prefill');
  b.control.state.said.length = 0;
  await run(rowOf('2.1. ' + title));
  eq([asks.pop(), b.control.state.clipboard, b.control.state.said.length],
    [[S, `About row 2.1 (${title.slice(0, 79)}…): `], '', 0],
    'a click asks the source to put "About row N (title): " in that conversation\'s message box, the title cut at 80 characters, and nothing else happens when it did');
  b.vscode.env.language = 'zh-cn';
  await run(rowOf('1. Pick the branch'));
  eq(asks.pop(), [S, '关于第 1 行（Pick the branch）：'], 'in Chinese the text is 关于第 N 行（标题）：, and a question row has the pen too');
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
    'a source that does not answer in time leaves it on the clipboard as well, saying it could not tell');

  await b.control.state.handlers['agentPlus.showWorkPlanOf']({ sourceId: 'claude-code', sessionId: N });
  await wait(40);
  eq(b.control.state.context[KEY], false, 'a conversation whose source does not list prefill gets no pen');
  b.close();
};
