// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A row that goes on to ask something else while an answer to what it asked before is still on its way. The outcome of
 * the earlier answer belongs to the earlier question, and an earlier answer no window has taken yet is not delivered
 * to a question it was not written for.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const answers = require(path.join(root, 'src', 'answers.js'));
  const asking = (file, question) => fs.writeFileSync(file, JSON.stringify({ nodes: [{ title: 'row', state: 'waiting', waitingOn: 'user', question }] }));
  const start = async (source) => {
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 1e9, refreshMs: 1e9, answerPollMs: 20 } });
    const ws = tmp('ws');
    b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(ws) }];
    const plans = tmp('plans');
    const plan = path.join(plans, 'S.json');
    asking(plan, 'Merge it?');
    b.api.registerSource(Object.assign({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'),
      planDir: () => plans, listConversations: async () => [{ sessionId: 'S', title: 'Task', cwd: ws, state: 'idle', running: true }] }, source));
    await wait(80);
    const conv = b.control.state.views['agentPlus.conversations'].provider;
    const row = conv.getChildren().find((e) => e.kind === 'conversation');
    const question = conv.getTreeItem(conv.getChildren(row)[0]).command.arguments[0];
    await b.control.state.handlers['agentPlus.answerQuestion'](question);
    const view = b.control.state.webviews['agentPlus.answer'];
    return { b, plan, question, view, key: view.current.key };
  };

  /* The first answer is still being typed into the conversation when the row asks something else and the reader
     answers that too. The first one coming back must not say the second was delivered, nor clear its draft. */
  {
    const held = new Map();
    const { b, plan, question, view, key } = await start({ canDeliver: () => true,
      deliverAnswer: (id, text) => new Promise((r) => held.set(text.split('\n').pop(), r)) });
    view.receive({ type: 'send', key, text: 'one' });
    await wait(80);
    asking(plan, 'Squash first?');
    view.revise((k) => Object.assign({}, question, { key: k, question: 'Squash first?' }));
    view.receive({ type: 'send', key, text: 'two' });
    await wait(80);
    if (held.has('one')) held.get('one')({ outcome: 'submitted' });
    await wait(80);
    const mid = [view.states.get(key) && view.states.get(key).kind, view.drafts.get(key)];
    if (held.has('two')) held.get('two')({ outcome: 'submitted' });
    await wait(80);
    const end = [view.states.get(key) && view.states.get(key).kind, view.drafts.get(key)];
    eq([[...held.keys()], mid, end], [['one', 'two'], ['waiting', 'two'], ['submitted', '']],
      'the outcome of the answer to the earlier question does not stand for the answer on its way to the new one');
    b.close();
  }

  /* An answer waiting for the window that shows the conversation: the row asks something else before any window takes
     it, and the window it came from takes it back. */
  {
    const { b, plan, view, key } = await start({ canDeliver: () => false, deliverAnswer: async () => ({ outcome: 'submitted' }) });
    b.control.state.clipboard = 'something of the reader\'s';
    view.receive({ type: 'send', key, text: 'yes' });
    await wait(30);
    asking(plan, 'Squash first?');
    await b.control.state.handlers['agentPlus.refreshWorkPlan']();
    await wait(120);
    const taken = [];
    const other = new answers.Courier({ dir: path.join(b.home, 'answers'), canShow: () => true, finish: () => {},
      hand: (a, report) => { taken.push(a.text.split('\n').pop()); report({ outcome: 'submitted' }); return true; } });
    other.pump();
    await wait(30);
    other.dispose();
    const waitingFiles = fs.readdirSync(path.join(b.home, 'answers')).filter((n) => n.endsWith('.json'));
    eq([taken, waitingFiles, b.control.state.clipboard, view.drafts.get(key)], [[], [], 'something of the reader\'s', 'yes'],
      'an answer nobody took yet is taken back once its row asks something else, no window delivers it, and the draft stays');
    b.close();
  }
};
