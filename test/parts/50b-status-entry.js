// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations entry in the status bar (src/views.js): the number of running conversations with a question for the
 * user, the list of them in its tooltip and its red background, or the number running when none has a question.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const ws = tmp('ws'), plans = tmp('plans');
  const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100 } });
  const { vscode, control } = b;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
  const changed = new vscode.EventEmitter();
  let list = [];
  const plan = (id, questions) => fs.writeFileSync(path.join(plans, id + '.json'), JSON.stringify({ nodes: [{ title: 'build', state: 'doing' }]
    .concat(Array.from({ length: questions }, (_, i) => ({ title: `ask ${i + 1}`, state: 'waiting', waitingOn: 'user', question: `Q${i + 1}?` }))) }));
  /* Each one a second older than the one before, so the list keeps the order they are given in. */
  let age = 0;
  const conv = (id, title, running = true) => ({ sessionId: id, title, cwd: ws, state: 'idle', running, lastActiveAt: Date.now() - 1000 * ++age });
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
    listConversations: async () => list, onDidChangeConversations: changed.event });
  const entry = () => control.state.status.find((i) => i.id === 'agentPlus.conversations');
  /* A change is listed again only after the debounce, so this waits for the entry to say `text`, for up to 5 s. */
  const look = async (convs, text) => {
    list = convs;
    changed.fire();
    for (let t = 0; t < 5000 && entry().text !== '$(comment-discussion) ' + text; t += 50) await wait(50);
    const e = entry();
    return [e.shown, e.text, e.tooltip, e.backgroundColor ? e.backgroundColor.id : null];
  };

  plan('a', 0);
  plan('b', 0);
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta')], 'Conversations 2'),
    [true, '$(comment-discussion) Conversations 2', 'Show the conversations of this workspace', null],
    'with no question, the entry counts the running conversations, with no background');

  plan('a', 2);
  plan('b', 1);
  plan('c', 3);
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta'), conv('c', 'Gamma', false)], '2 conversations need you'),
    [true, '$(comment-discussion) 2 conversations need you', '2 conversations need you:\nAlpha · 2 questions\nBeta · 1 question', 'statusBarItem.errorBackground'],
    'it counts the running conversations with a question, not the questions, lists them in its tooltip, and is red; a stopped one is not counted');

  plan('b', 0);
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta')], '1 conversation needs you'),
    [true, '$(comment-discussion) 1 conversation needs you', '1 conversation needs you:\nAlpha · 2 questions', 'statusBarItem.errorBackground'],
    'one conversation is written in the singular');

  const many = Array.from({ length: 12 }, (_, i) => { plan(`m${i}`, 1); return conv(`m${i}`, `Task ${i + 1}`); });
  const [, text, tip] = await look(many, '12 conversations need you');
  eq([text, tip.split('\n').length, tip.split('\n')[10], tip.split('\n').pop()],
    ['$(comment-discussion) 12 conversations need you', 12, 'Task 10 · 1 question', 'and 2 more'],
    'the tooltip lists ten of them, then says how many more there are');

  vscode.env.language = 'zh-cn';
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta')], '1 个对话等你'),
    [true, '$(comment-discussion) 1 个对话等你', '1 个对话等你：\nAlpha · 2 个问题', 'statusBarItem.errorBackground'],
    'in Chinese it says how many conversations wait for the user');
  b.close();
};
