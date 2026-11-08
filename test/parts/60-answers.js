// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Answers across windows: one window takes each answer, the source gets its delivery id, the four outcomes come back to
 * the sender, a timeout is uncertain rather than a failure, and only a submitted answer clears its draft. Adapted from
 * "answer delivery by source" in vscode-claude-code-extras' test/check.js.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const answers = require(path.join(root, 'src', 'answers.js'));
  const dir = path.join(tmp('shared'), 'answers');
  let clock = 1000000;
  const timers = [];
  const later = (fn, ms) => { timers.push({ at: clock + ms, fn, live: true }); return timers.length; };
  const cancel = (n) => { if (timers[n - 1]) timers[n - 1].live = false; };
  const advance = (ms) => { clock += ms; for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); } };
  const settle = () => new Promise((r) => setImmediate(r));
  const window = (have, claiming = () => true) => {
    const finished = [];
    const via = answers.throughSources((id) => have[id] || null);
    const courier = new answers.Courier({ dir, now: () => clock, later, cancel, claiming, canShow: via.canShow, hand: via.hand,
      finish: (sent, result) => finished.push([sent.key, result.outcome, result.reason]) });
    return { courier, finished };
  };
  const delivered = [];
  const source = (outcome, extra = {}) => ({ canDeliver: (id) => id === 'S',
    deliverAnswer: async (id, text, opts) => { delivered.push([outcome, text, opts && opts.deliveryId]); return Object.assign({ outcome }, extra); } });

  const sender = window({});
  const cases = [
    ['submitted', source('submitted')], ['drafted', source('drafted')], ['notReceived', source('notReceived', { reason: 'the input box already has text' })],
    ['odd', source('thrown away')],
  ];
  const ids = [];
  for (const [name, s] of cases) {
    const w = window({ codex: s });
    const id = sender.courier.send({ sourceId: 'codex', sessionId: 'S', row: '1', text: 'to ' + name }, { key: name });
    ids.push(id);
    w.courier.pump(); await settle(); await settle(); sender.courier.pump();
  }
  const file = JSON.parse(JSON.stringify(sender.finished));
  eq(file, [['submitted', 'submitted', ''], ['drafted', 'drafted', ''], ['notReceived', 'notReceived', 'the input box already has text'],
    ['odd', 'uncertain', '']], 'the sender hears submitted, drafted, notReceived with its reason, and an unknown outcome as uncertain');
  eq(delivered.map((d) => d[2]), ids, 'the source gets the answer\'s id as its delivery id');
  const st = fs.statSync(dir);
  if (process.platform !== 'win32') eq((st.mode & 0o777).toString(8), '700', 'the answer folder is readable by this user alone');

  /* Nobody can deliver it: withdrawn after TAKE_MS, notReceived 'nobody'. */
  const lonely = window({});
  const bare = window({ codex: { canDeliver: () => true } });
  lonely.courier.send({ sourceId: 'codex', sessionId: 'T', row: '2', text: 'x' }, { key: 'nobody' });
  bare.courier.pump(); await settle(); advance(answers.TAKE_MS + 200);
  eq(lonely.finished, [['nobody', 'notReceived', 'nobody']], 'an answer no window can take is withdrawn and reported as not received');

  /* Taken, and the source never answers: the taker settles it as uncertain. */
  const slowSender = window({});
  const hung = window({ codex: { canDeliver: () => true, deliverAnswer: () => new Promise(() => {}) } });
  slowSender.courier.send({ sourceId: 'codex', sessionId: 'S', row: '3', text: 'y' }, { key: 'hung' });
  hung.courier.pump(); await settle();
  advance(answers.TAKE_MS + 200);
  const beforeTimeout = slowSender.finished.slice();
  advance(answers.SEND_MS);
  slowSender.courier.pump();
  eq([beforeTimeout, slowSender.finished], [[], [['hung', 'uncertain', '']]], 'a taken answer with no outcome in time is uncertain, not failed');

  /* The taker went away after taking it. */
  const orphanSender = window({});
  const gone = window({ codex: { canDeliver: () => true, deliverAnswer: () => new Promise(() => {}) } });
  orphanSender.courier.send({ sourceId: 'codex', sessionId: 'S', row: '4', text: 'z' }, { key: 'gone' });
  gone.courier.pump(); await settle(); gone.courier.dispose();
  advance(answers.TAKE_MS + answers.SEND_MS + 5200);
  eq(orphanSender.finished, [['gone', 'uncertain', '']], 'an answer taken by a window that never settles it is uncertain');

  /* Newer formats, malformed files, Restricted Mode. */
  fs.writeFileSync(path.join(dir, 'aa-00000002.json'), JSON.stringify({ id: 'aa-00000002', sourceId: 'codex', sessionId: 'S', text: 'newer', at: clock, format: answers.FORMAT + 1 }));
  fs.writeFileSync(path.join(dir, 'aa-00000003.json'), JSON.stringify({ id: 'aa-00000003', sessionId: 'S', text: 'no source', at: clock, format: 1 }));
  fs.writeFileSync(path.join(dir, 'aa-00000004.json'), JSON.stringify({ id: 'aa-00000004', sourceId: 'codex', sessionId: 'S', text: 'restricted', at: clock, format: 1 }));
  const restricted = window({ codex: source('submitted') }, () => false);
  restricted.courier.pump(); await settle();
  const before = delivered.length;
  const taker = window({ codex: source('submitted') });
  taker.courier.pump(); await settle();
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  eq([left, delivered.slice(before).map((d) => d[1])], [['aa-00000002.json', 'aa-00000003.json'], ['restricted']],
    'a window in Restricted Mode takes nothing; files in a newer format or without a source are left alone');

  /* Through the views: the Answer view, the clipboard and the draft. */
  const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 1e9, refreshMs: 1e9 } });
  const { vscode, control } = b;
  const ws = tmp('ws');
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
  const plans = tmp('plans');
  fs.writeFileSync(path.join(plans, 'S.json'), JSON.stringify({ nodes: [{ title: 'row', state: 'waiting', waitingOn: 'user', question: 'Merge it?' }] }));
  let next = 'notReceived';
  const got = [];
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
    listConversations: async () => [{ sessionId: 'S', title: 'Task', cwd: ws, state: 'idle' }],
    canDeliver: () => true, deliverAnswer: async (id, text, opts) => { got.push([text.split('\n').pop(), !!(opts && opts.deliveryId)]); return { outcome: next, reason: 'busy' }; } });
  await wait(80);
  const conv = control.state.views['agentWorkPlan.conversations'].provider;
  const row = conv.getChildren().find((e) => e.kind === 'conversation');
  const question = conv.getTreeItem(conv.getChildren(row)[0]).command.arguments[0];
  await control.state.handlers['agentWorkPlan.answerQuestion'](question);
  const view = control.state.webviews['agentWorkPlan.answer'];
  const key = view.current.key;
  view.receive({ type: 'send', key, text: 'Yes, merge.' });
  view.receive({ type: 'send', key, text: 'Yes, merge.' });
  await wait(150);
  const first = { state: view.states.get(key), draft: view.drafts.get(key), clipboard: control.state.clipboard, got: got.slice() };
  next = 'submitted';
  view.receive({ type: 'send', key, text: 'Yes, merge.' });
  await wait(150);
  const second = { state: view.states.get(key).kind, draft: view.drafts.has(key) };
  eq([first.got, first.state.kind, first.state.reason, first.draft, /Merge it\?/.test(first.clipboard) && first.clipboard.endsWith('Yes, merge.')],
    [[['Yes, merge.', true]], 'notReceived', 'busy', 'Yes, merge.', true],
    'a second click while one is on its way sends nothing; not received keeps the draft and copies the answer');
  eq(second, { state: 'submitted', draft: false }, 'a submitted answer clears its draft');
  eq(key, 'codex/S/1', 'the question is keyed by source, session and row');
  b.close();
};
