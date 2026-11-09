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

  /* A window that closed before anyone could take its answer leaves the file behind. Another window opening that
     conversation an hour later must not deliver it: the reader was told nothing was sent, and may have typed it again
     by hand. */
  const old = answers.post(dir, { sourceId: 'codex', sessionId: 'S', row: '9', text: 'from a window that closed' },
    clock - answers.TAKE_MS - answers.LATE_MS - 1);
  const wasDelivered = delivered.length;
  const late = window({ codex: source('submitted') });
  late.courier.pump(); await settle(); await settle();
  eq([delivered.length - wasDelivered, fs.existsSync(path.join(dir, old + '.json')), fs.existsSync(path.join(dir, old + '.taken')),
    JSON.parse(fs.readFileSync(path.join(dir, old + '.result'), 'utf8')).outcome],
    [0, false, false, 'notReceived'], 'an answer older than the time it had to be taken is thrown away, not delivered');
  fs.unlinkSync(path.join(dir, old + '.result'));

  /* Closing a window takes back what it sent and nobody took. */
  const leaving = window({});
  const untaken = leaving.courier.send({ sourceId: 'codex', sessionId: 'T', row: '10', text: 'on its way out' }, { key: 'untaken' });
  const there = fs.existsSync(path.join(dir, untaken + '.json'));
  leaving.courier.dispose();
  eq([there, fs.existsSync(path.join(dir, untaken + '.json'))], [true, false],
    'a window closing takes back the answers it sent that no window had taken');

  /* One already taken is left alone: the window that took it is still working on it. */
  const handedOver = window({});
  const working = window({ codex: { canDeliver: () => true, deliverAnswer: () => new Promise(() => {}) } });
  const busyId = handedOver.courier.send({ sourceId: 'codex', sessionId: 'S', row: '11', text: 'in hand' }, { key: 'inhand' });
  working.courier.pump(); await settle();
  handedOver.courier.dispose();
  eq(fs.existsSync(path.join(dir, busyId + '.taken')), true, 'one a window has taken is left with it');
  working.courier.dispose();
  fs.unlinkSync(path.join(dir, busyId + '.taken'));

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
  const conv = control.state.views['agentPlus.conversations'].provider;
  const row = conv.getChildren().find((e) => e.kind === 'conversation');
  const question = conv.getTreeItem(conv.getChildren(row)[0]).command.arguments[0];
  await control.state.handlers['agentPlus.answerQuestion'](question);
  const view = control.state.webviews['agentPlus.answer'];
  const key = view.current.key;
  view.receive({ type: 'send', key, text: 'Yes, merge.' });
  view.receive({ type: 'send', key, text: 'Yes, merge.' });
  await wait(150);
  const first = { state: view.states.get(key), draft: view.drafts.get(key), clipboard: control.state.clipboard, got: got.slice() };
  next = 'submitted';
  view.receive({ type: 'send', key, text: 'Yes, merge.' });
  await wait(150);
  const second = { state: view.states.get(key).kind, draft: view.drafts.get(key) };
  eq([first.got, first.state.kind, first.state.reason, first.draft, /Merge it\?/.test(first.clipboard) && first.clipboard.endsWith('Yes, merge.')],
    [[['Yes, merge.', true]], 'notReceived', 'busy', 'Yes, merge.', true],
    'a second click while one is on its way sends nothing; not received keeps the draft and copies the answer');
  eq(second, { state: 'submitted', draft: '' }, 'a submitted answer clears its draft');

  /* The box is not disabled while an answer is on its way, so the reader can type the next one. Clearing on
     "submitted" clears what was sent, not what they have written since. */
  view.receive({ type: 'draft', key, text: 'and one more thing' });
  next = 'submitted';
  view.receive({ type: 'send', key, text: 'and one more thing' });
  view.receive({ type: 'draft', key, text: 'typed while it was on its way' });
  await wait(150);
  eq(view.drafts.get(key), 'typed while it was on its way', 'what was typed while an answer was on its way is kept when it is submitted');

  /* The page's last keystrokes for one question can arrive after the reader has clicked another. */
  view.drafts.set('codex/other/2', 'half a sent');
  view.receive({ type: 'draft', key: 'codex/other/2', text: 'all of it' });
  eq(view.drafts.get('codex/other/2'), 'all of it', 'a draft that names a question other than the one on screen is still kept');

  /* The row the question is on belongs to a plan another process writes. */
  const stillAsking = view.current.question;
  view.revise(() => null);
  const afterGone = { running: view.current.running, gone: !!view.current.gone };
  view.receive({ type: 'send', key, text: 'too late' });
  const sentAfter = got.length;
  await wait(60);
  view.revise((k) => Object.assign({}, question, { key: k, question: 'Merge it, really?' }));
  eq([stillAsking, afterGone, got.length, view.states.has(key), view.current.question],
    ['Merge it?', { running: false, gone: true }, sentAfter, false, 'Merge it, really?'],
    'a row that stopped asking takes no answer, and a row asking something else drops the last outcome');
  eq(key, 'codex/S/1', 'the question is keyed by source, session and row');
  b.close();

  /*
   * The answers folder is read on its own short interval as well as when the folder changes. An answer that arrives
   * while no conversation it could go to is open leaves nothing further for the watcher to report, and the sender gives
   * up on it after 15 seconds, so waiting for the 30 second tick loses it about half the time.
   */
  {
    const p = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 1e9, refreshMs: 1e9, answerPollMs: 25 } });
    const taken2 = [];
    let ready = false;
    p.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', listConversations: async () => [],
      canDeliver: () => ready, deliverAnswer: async (id, text) => { taken2.push(text); return { outcome: 'submitted' }; } });
    await wait(40);
    answers.post(path.join(p.home, 'answers'), { sourceId: 'codex', sessionId: 'S', row: '1', text: 'waited for' });
    await wait(80);
    const whileClosed = taken2.length;
    ready = true;
    await wait(120);
    eq([whileClosed, taken2], [0, ['waited for']],
      'an answer nothing could take yet is delivered once a source can take it, with no further change to the folder');
    p.close();
  }
};
