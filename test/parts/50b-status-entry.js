// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations entry in the status bar (src/views.js): the number of conversations that need the user, the list of
 * them in its tooltip and its warning background, or the number running when none does. It counts the running
 * conversations with a question in their plan and those the attention watcher counts (src/attention.js), each once.
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
  /* The list puts the most recently active first, so this keeps them in the order they are given in. */
  let age = 0;
  const conv = (id, title, running = true) => ({ sessionId: id, title, cwd: ws, state: 'idle', running, lastActiveAt: Date.now() - 1000 * ++age });
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
    listConversations: async () => list, onDidChangeConversations: changed.event });
  const entry = () => control.state.status.find((i) => i.id === 'agentPlus.conversations');
  /* A change is listed again only after the debounce. */
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
    'with no question waiting, the entry shows how many conversations run, on the plain status bar');

  plan('a', 2);
  plan('b', 1);
  plan('c', 3);
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta'), conv('c', 'Gamma', false)], '2 conversations need you'),
    [true, '$(comment-discussion) 2 conversations need you', '2 conversations need you:\nWaiting for your answer to a question in their plan:\nAlpha · 2 questions\nBeta · 1 question', 'statusBarItem.warningBackground'],
    'two running conversations with three questions between them are counted as 2, listed in the tooltip, on a yellow background; the stopped one is left out');

  plan('b', 0);
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta')], '1 conversation needs you'),
    [true, '$(comment-discussion) 1 conversation needs you', '1 conversation needs you:\nWaiting for your answer to a question in their plan:\nAlpha · 2 questions', 'statusBarItem.warningBackground'],
    'for one conversation the entry says 1 conversation needs you');

  const many = Array.from({ length: 12 }, (_, i) => { plan(`m${i}`, 1); return conv(`m${i}`, `Task ${i + 1}`); });
  const [, text, tip] = await look(many, '12 conversations need you');
  eq([text, tip.split('\n').length, tip.split('\n')[11], tip.split('\n').pop()],
    ['$(comment-discussion) 12 conversations need you', 13, 'Task 10 · 1 question', 'and 2 more'],
    'the tooltip lists ten of them, then says how many more there are');

  vscode.env.language = 'zh-cn';
  eq(await look([conv('a', 'Alpha'), conv('b', 'Beta')], '1 个对话等你'),
    [true, '$(comment-discussion) 1 个对话等你', '1 个对话等你：\n在等你回答计划里问题的：\nAlpha · 2 个问题', 'statusBarItem.warningBackground'],
    'with VS Code in Chinese, the entry and its tooltip are in Chinese');
  b.close();

  /* With the attention watcher counting too. */
  {
    const ws2 = tmp('ws2'), plans2 = tmp('plans2');
    let views = null;
    const q = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 20,
      attentionWarmupMs: 0, attentionBatchMs: 10, debounceMs: 10 }, views: (h, o) => (views = require(path.join(root, 'src', 'views.js')).create(h, o)) });
    q.vscode.workspace.workspaceFolders = [{ uri: q.vscode.Uri.file(ws2) }];
    const ask = (id) => fs.writeFileSync(path.join(plans2, id + '.json'), JSON.stringify({ nodes: [{ title: 'build', state: 'doing' },
      { title: 'ask', state: 'waiting', waitingOn: 'user', question: 'Which one?' }] }));
    ask('a');
    ask('b');
    const at = Date.now() - 60e3;
    const listed = [
      { sessionId: 'a', title: 'Alpha', cwd: ws2, state: 'prompt', activity: 'waiting', running: true, lastActiveAt: at, waitingFor: { kind: 'permission', tool: 'Bash' } },
      { sessionId: 'b', title: 'Beta', cwd: ws2, state: 'idle', running: true, lastActiveAt: at - 1000 },
      { sessionId: 'c', title: 'Gamma', cwd: ws2, state: 'prompt', activity: 'waiting', running: true, lastActiveAt: at - 2000 },
      { sessionId: 'd', title: 'Delta', cwd: ws2, state: 'unread', activity: 'stopped', unseen: true, running: true, lastActiveAt: at - 3000 },
    ];
    const moved = new q.vscode.EventEmitter();
    q.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans2, id + '.json'), planDir: () => plans2,
      listConversations: async () => listed.map((c) => Object.assign({}, c)), onDidChangeConversations: moved.event });
    const it = () => q.control.state.status.find((i) => i.id === 'agentPlus.conversations');
    const settle = async (want) => { for (let t = 0; t < 5000 && !(it().shown && it().text.includes(want)); t += 50) await wait(50); return it(); };
    const both = await settle('3 conversations need you');
    eq([both.text, both.tooltip, both.command, both.backgroundColor && both.backgroundColor.id],
      ['$(comment-discussion) 3 conversations need you',
        '3 conversations need you:\nWaiting for your answer to a question in their plan:\nAlpha · 1 question\nBeta · 1 question'
        + '\nWaiting for you to approve something or answer:\nAlpha (approve Bash)\nGamma',
        'agentPlus.showConversations', 'statusBarItem.warningBackground'],
      'one entry counts the conversations with a question in their plan and those waiting for the user, a conversation of both kinds once, and lists the two kinds apart');
    eq(views._parts.needs.items().filter((it) => it.sessionId === 'd').map((it) => it.kind), ['finished'],
      'one that stopped with a reply not read is known to need the user, and is left to its notification rather than counted');
    q.control.state.config['agentPlus.conversationsView'] = false;
    q.control.changeConfig(['agentPlus.conversationsView']);
    const off = await settle('2 conversations need you');
    eq([off.text, off.tooltip.split('\n')[1], off.command],
      ['$(comment-discussion) 2 conversations need you', 'Waiting for you to approve something or answer:', 'agentPlus.showAttention'],
      'with the Conversations view turned off, it counts only the waiting ones and opens their list');
    q.close();
  }
};
