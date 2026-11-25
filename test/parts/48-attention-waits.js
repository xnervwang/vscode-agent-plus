// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What a waiting conversation waits for (src/wait-reason.js), named in the notices; no notice for a conversation the
 * focused window shows anywhere; a notice for each conversation, also when they come from different sources; what was
 * kept while no window had the focus, shown once when a window gets it; and announcesWaits(), which a source calls
 * before it leaves out its agent's own notice of a wait.
 */
const path = require('path');
const { boot } = require('../boot');
const fake = require('../fake-vscode');

const waiting = (id, title, waitingFor) => ({ sessionId: id, title, cwd: '/w', state: 'prompt', activity: 'waiting', running: true, waitingFor });
const finishedConv = (id, title) => ({ sessionId: id, title, cwd: '/w', state: 'unread', activity: 'stopped', unseen: true, running: true });
const workingConv = (id, title) => ({ sessionId: id, title, cwd: '/w', state: 'working', activity: 'working', running: true });

module.exports = async ({ eq, tmp, root, wait }) => {
  const at = require(path.join(root, 'src', 'attention.js'));
  const reason = require(path.join(root, 'src', 'wait-reason.js'));
  const src = require(path.join(root, 'src', 'sources.js'));
  const conversations = require(path.join(root, 'src', 'conversations.js'));
  const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  let clock = 5000000;
  const settings = { enabled: true, finished: true, waiting: true };
  const lists = (...cs) => [{ sourceId: 'claude-code', label: 'Claude Code', conversations: src.conversations(cs) }];
  const make = (dir, name, { focused = false, here = [], several = false } = {}) => {
    const w = { focused, here, shown: [], painted: [] };
    w.att = at.createAttention({ dir, windowId: `${name}-00000000`, now: () => clock, focused: () => w.focused,
      shownHere: (it) => w.here.includes(it.sessionId), settings: () => settings, warmupMs: 0, batchMs: 10, several: () => several,
      show: (text, item) => { w.shown.push({ text, id: item.sessionId }); },
      paint: (items) => { w.painted = items.map((it) => `${it.sessionId}:${it.kind}`).sort(); } });
    return w;
  };
  const fresh = (w) => w.shown.splice(0).map((n) => n.text);
  const round = async (...ws) => { for (const w of ws) w.att.refresh(); await settle(); for (const w of ws) w.att.refresh(); };

  /* The words for each reason. */
  const one = (r) => at.message({ kind: 'waiting', title: 'Fix the build', source: 'Claude Code', waitingFor: r }, { several: false });
  eq([one({ kind: 'permission', tool: 'Bash' }), one({ kind: 'permission' }), one({ kind: 'question' }), one({ kind: 'plan' }), one({ kind: 'choice' }),
    one({ kind: 'planQuestion' }), one(null), one({ kind: 'nap' })],
  ['"Fix the build" is waiting for you to approve Bash.', '"Fix the build" is waiting for your approval.', '"Fix the build" has a question for you.',
    '"Fix the build" has a plan for you to review.', '"Fix the build" is waiting for you to choose.', '"Fix the build" has a question for you in its plan.',
    '"Fix the build" is waiting for you.', '"Fix the build" is waiting for you.'],
  'a notice says what the conversation waits for, and without a reason says only that it is waiting');
  eq([at.message({ kind: 'waiting', title: 'A', source: 'Claude Code', waitingFor: { kind: 'permission', tool: 'Edit' } }, { several: true }),
    at.message({ kind: 'finished', title: 'C', source: 'Codex' }, { several: true })],
  ['Claude Code: "A" is waiting for you to approve Edit.', 'Codex: "C" finished.'],
  'with more than one source, a notice puts its source\'s name before the title');
  eq([reason.description({ kind: 'permission', tool: 'Bash' }), reason.description({ kind: 'question' }), reason.description(null)],
    ['waiting for you to approve Bash', 'has a question for you', 'waiting for you'], 'and the list of conversations that need you says the same after a name');

  /* A question in the plan makes the conversation wait for planQuestion, unless the agent itself already waits. */
  const q = { nodes: [{ title: 'Pick one', state: 'waiting', waitingOn: 'user', question: 'A or B?', since: 2000 }] };
  const planned = (c) => { const x = conversations.withPlan(Object.assign({}, c, { lastUserAt: 1000 }), q); return [x.activity, x.waitingFor]; };
  eq([planned(src.conversation(workingConv('a', 'A'))), planned(src.conversation({ sessionId: 'b', state: 'idle', running: true })),
    planned(src.conversation(waiting('c', 'C', { kind: 'permission', tool: 'Bash' }))),
    conversations.withPlan(src.conversation(waiting('d', 'D', { kind: 'question' })), null).waitingFor],
  [['working', null], ['waiting', { kind: 'planQuestion' }], ['waiting', { kind: 'permission', tool: 'Bash' }], { kind: 'question' }],
  'a question in the plan gives planQuestion, and a conversation already waiting on its agent keeps the agent\'s reason');

  /* Two windows report one conversation: the window whose panel shows the prompt knows the tool. */
  {
    const dir = path.join(tmp('merge'), 'attention');
    const a = make(dir, 'ma'), b = make(dir, 'mb'), f = make(dir, 'mf', { focused: true });
    a.att.publish(lists(waiting('x', 'Deploy', { kind: 'permission' })));
    b.att.publish(lists(waiting('x', 'Deploy', { kind: 'permission', tool: 'Bash' })));
    await round(a, b, f);
    eq([fresh(f), [...at.readAll(dir, clock).merged.values()].map((it) => it.waitingFor)],
      [['"Deploy" is waiting for you to approve Bash.'], [{ kind: 'permission', tool: 'Bash' }]],
      'when two windows report one waiting conversation, the reason that names the tool wins, whichever file is read first');
    for (const w of [a, b, f]) w.att.dispose();
  }

  /* Conversations of two sources that start to wait together: a notice for each, with its source's name. */
  {
    const dir = path.join(tmp('sources'), 'attention');
    const a = make(dir, 'sa'), f = make(dir, 'sf', { focused: true, several: true });
    const two = (cc, cx) => [{ sourceId: 'claude-code', label: 'Claude Code', conversations: src.conversations(cc) },
      { sourceId: 'codex', label: 'Codex', conversations: src.conversations(cx) }];
    a.att.publish(two([workingConv('c1', 'Claude one'), workingConv('c2', 'Claude two')], [workingConv('x1', 'Codex one')]));
    await round(a, f);
    a.att.publish(two([waiting('c1', 'Claude one', { kind: 'permission', tool: 'Edit' }), waiting('c2', 'Claude two', null)],
      [waiting('x1', 'Codex one', { kind: 'question' })]));
    await round(a, f);
    eq([f.shown.map((n) => n.id).sort(), fresh(f).sort()], [['c1', 'c2', 'x1'],
      ['Claude Code: "Claude one" is waiting for you to approve Edit.', 'Claude Code: "Claude two" is waiting for you.', 'Codex: "Codex one" has a question for you.']],
    'conversations of two sources that start to wait together get a notice each, with its own source\'s name');
    for (const w of [a, f]) w.att.dispose();
  }

  /* The window that reads a machine-wide list hears of a permission prompt first, without the tool; the window whose
     panel shows it names the tool a moment later, and the notice is held until then. A notice whose tool no window
     names is shown once that wait is over. */
  {
    const dir = path.join(tmp('precise'), 'attention');
    const mk = (name, focused) => {
      const w = { focused, shown: [] };
      w.att = at.createAttention({ dir, windowId: `${name}-00000000`, now: () => clock, focused: () => w.focused, settings: () => settings,
        warmupMs: 0, batchMs: 10, preciseMs: 1000, show: (text) => { w.shown.push(text); } });
      return w;
    };
    const list = mk('pl', true), panel = mk('pp', false);
    list.att.publish(lists(workingConv('x', 'Named later'), workingConv('y', 'Never named')));
    await round(list, panel);
    list.att.publish(lists(waiting('x', 'Named later', { kind: 'permission' }), waiting('y', 'Never named', { kind: 'permission' })));
    await round(list, panel);
    const early = list.shown.splice(0);
    clock += 500;
    panel.att.publish(lists(waiting('x', 'Named later', { kind: 'permission', tool: 'Bash' })));
    await round(list, panel);
    const named = list.shown.splice(0);
    clock += 1000;
    await round(list, panel);
    eq([early, named, list.shown.splice(0)], [[], ['"Named later" is waiting for you to approve Bash.'], ['"Never named" is waiting for your approval.']],
      'when the first report of a permission prompt does not name the tool, the notice waits for a window that names it and then shows the tool; one that no window names is shown once that wait is over');
    for (const w of [list, panel]) w.att.dispose();
  }

  /* The focused window shows a conversation anywhere: no notice there, for a wait or a finished reply; the count stays. */
  {
    const dir = path.join(tmp('same'), 'attention');
    const src1 = make(dir, 'sa'), f = make(dir, 'sf', { focused: true, here: ['mine', 'done'] });
    src1.att.publish(lists(waiting('mine', 'Mine', { kind: 'permission', tool: 'Bash' }), waiting('other', 'Other', { kind: 'question' }),
      waiting('third', 'Third', { kind: 'plan' }), workingConv('done', 'Done')));
    await round(src1, f);
    src1.att.publish(lists(waiting('mine', 'Mine', { kind: 'permission', tool: 'Bash' }), waiting('other', 'Other', { kind: 'question' }),
      waiting('third', 'Third', { kind: 'plan' }), finishedConv('done', 'Done')));
    await round(src1, f);
    clock += at.STABLE_MS;
    await round(src1, f);
    eq([fresh(f), f.painted], [['"Other" has a question for you.', '"Third" has a plan for you to review.'],
      ['done:finished', 'mine:waiting', 'other:waiting', 'third:waiting']],
    'of three that start to wait together, the two the focused window does not show get a notice each; the one it shows behind other tabs or in its side bar gets none, whether waiting or finished, and is still counted');
    for (const w of [src1, f]) w.att.dispose();
  }

  /* No window has the focus: each keeps what it would have shown, and the first to get the focus shows it once. */
  {
    const dir = path.join(tmp('away'), 'attention');
    const a = make(dir, 'aa', { here: ['inA'] }), b = make(dir, 'ab');
    a.att.publish(lists(workingConv('x', 'Release notes'), workingConv('inA', 'Shown in A'), workingConv('gone', 'Answered meanwhile')));
    await round(a, b);
    a.att.publish(lists(waiting('x', 'Release notes', { kind: 'permission', tool: 'Bash' }), waiting('inA', 'Shown in A', { kind: 'question' }),
      waiting('gone', 'Answered meanwhile', { kind: 'choice' })));
    await round(a, b);
    clock += 1000;
    a.att.publish(lists(waiting('x', 'Release notes', { kind: 'permission', tool: 'Bash' }), waiting('inA', 'Shown in A', { kind: 'question' }),
      workingConv('gone', 'Answered meanwhile')));
    await round(a, b);
    eq([fresh(a), fresh(b)], [[], []], 'while no window has the focus, nothing is shown');
    clock += 10000;
    b.focused = true;
    await round(a, b);
    eq([b.shown.map((n) => n.id), fresh(b)], [['x', 'inA'], ['"Release notes" is waiting for you to approve Bash.', '"Shown in A" has a question for you.']],
      'the window that gets the focus shows one notice for each conversation that still waits, leaving out what was answered meanwhile');
    await round(a, b);
    eq(fresh(b), [], 'and does not show it again on its next refresh');
    b.focused = false;
    a.focused = true;
    await round(a, b);
    eq(fresh(a), [], 'the other window, given the focus after it, shows none of it again');
    for (const w of [a, b]) w.att.dispose();
  }
  {
    const dir = path.join(tmp('away-one'), 'attention');
    const a = make(dir, 'oa', { here: ['own'] }), b = make(dir, 'ob');
    a.att.publish(lists(workingConv('x', 'Only one'), workingConv('own', 'Own')));
    await round(a, b);
    a.att.publish(lists(waiting('x', 'Only one', { kind: 'question' }), waiting('own', 'Own', { kind: 'question' })));
    await round(a, b);
    a.focused = true;
    await round(a, b);
    eq(fresh(a), ['"Only one" has a question for you.'], 'one kept conversation comes back as a notice of its own, and not one the window shows itself');
    for (const w of [a, b]) w.att.dispose();
  }
  /* A window with the focus told the user; a window without the focus kept the same conversation, and given the focus
     later it shows nothing. */
  {
    const dir = path.join(tmp('told'), 'attention');
    const a = make(dir, 'ta'), f = make(dir, 'tf', { focused: true });
    a.att.publish(lists(workingConv('x', 'Told')));
    await round(a, f);
    a.att.publish(lists(waiting('x', 'Told', { kind: 'permission', tool: 'Read' })));
    await round(a, f);
    eq(fresh(f), ['"Told" is waiting for you to approve Read.'], 'the focused window shows a notice for it');
    f.focused = false;
    await round(a, f);
    clock += 5000;
    a.focused = true;
    await round(a, f);
    eq(fresh(a), [], 'and the window that kept it meanwhile does not show it again');
    for (const w of [a, f]) w.att.dispose();
  }

  /* In a running window. */
  {
    const prev = process.env.AGENT_PLUS_TEST_FOCUS;
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 20,
      attentionWarmupMs: 0, attentionBatchMs: 10 } });
    const { vscode, control } = b;
    vscode.window.state = { focused: true };
    let listed = [waiting('n', 'Needs you', { kind: 'permission', tool: 'Bash' })];
    const shownHere = new Set(), changed = new fake.EventEmitter();
    b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', features: ['shows'], listConversations: async () => [],
      listAllConversations: async () => listed, shows: (id) => shownHere.has(id), onDidChangeConversations: changed.event });
    const said = () => control.state.said.filter((m) => /need|waiting|question|finished|approve/.test(m.message)).map((m) => m.message);
    for (let i = 0; i < 100 && !said().length; i++) await wait(50);
    const tip = () => { const it = control.state.status.find((s) => s.id === 'agentPlus.conversations'); return it ? it.tooltip : ''; };
    let picked = null;
    vscode.window.showQuickPick = async (items) => { picked = items.map((x) => [x.label, x.description]); return undefined; };
    await vscode.commands.executeCommand('agentPlus.showAttention');
    eq([said(), tip(), picked], [['"Needs you" is waiting for you to approve Bash.'], '1 conversation needs you:\nFinished or waiting for you, not looked at yet:\nWaiting: Needs you (approve Bash)',
      [['Needs you', 'waiting for you to approve Bash']]],
    'a source\'s waitingFor reaches the notice, the hover of the count and the list of conversations that need you');
    control.state.said.length = 0;
    shownHere.add('m');
    listed = listed.concat([waiting('m', 'In a tab behind', { kind: 'question' })]);
    changed.fire();
    for (let i = 0; i < 40 && !/In a tab behind/.test(tip()); i++) await wait(50);
    await wait(200);
    eq([said(), /In a tab behind/.test(tip())], [[], true], 'a conversation the source\'s shows() says this window shows gets no notice, and it is counted');
    eq(b.api.announcesWaits(), true, 'announcesWaits() is true with the notifications and waiting notices on');
    control.state.config['agentPlus.notifications.waiting'] = false;
    const off = b.api.announcesWaits();
    control.state.config['agentPlus.notifications.waiting'] = true;
    control.state.config['agentPlus.notifications.enabled'] = false;
    const allOff = b.api.announcesWaits();
    delete control.state.config['agentPlus.notifications.enabled'];
    eq([off, allOff], [false, false], 'and false with either turned off');
    b.close();

    const r = boot(root, tmp, { trusted: false });
    eq(r.api.announcesWaits(), false, 'and false in Restricted Mode, where the window writes nothing for the others');
    r.close();

    /* The focus a window test sets counts only when the window was started with AGENT_PLUS_TEST_FOCUS=1. */
    globalThis.__agentPlusTestFocused = false;
    const plain = boot(root, tmp, { viewOptions: { attentionMs: 20, attentionWarmupMs: 0, attentionBatchMs: 10, refreshMs: 1e9 } });
    plain.vscode.window.state = { focused: true };
    plain.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', listConversations: async () => [], listAllConversations: async () => [waiting('t', 'T', null)] });
    for (let i = 0; i < 60 && !plain.control.state.said.length; i++) await wait(50);
    const plainSaid = plain.control.state.said.length;
    plain.close();
    process.env.AGENT_PLUS_TEST_FOCUS = '1';
    const tested = boot(root, tmp, { viewOptions: { attentionMs: 20, attentionWarmupMs: 0, attentionBatchMs: 10, refreshMs: 1e9 } });
    tested.vscode.window.state = { focused: true };
    tested.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', listConversations: async () => [], listAllConversations: async () => [waiting('t', 'T', null)] });
    await wait(600);
    const quiet = tested.control.state.said.length;
    globalThis.__agentPlusTestFocused = true;
    for (let i = 0; i < 60 && !tested.control.state.said.length; i++) await wait(50);
    eq([plainSaid, quiet, tested.control.state.said.map((m) => m.message)], [1, 0, ['"T" is waiting for you.']],
      'the focus a window test sets is read only with AGENT_PLUS_TEST_FOCUS=1, and a wait kept while it is false is shown once it is true');
    tested.close();
    delete globalThis.__agentPlusTestFocused;
    if (prev === undefined) delete process.env.AGENT_PLUS_TEST_FOCUS; else process.env.AGENT_PLUS_TEST_FOCUS = prev;
  }

  /* announcesWaits() in shared/host/core-link.js, for each kind of host. */
  {
    const link = require(path.join(root, 'shared', 'host', 'core-link.js'));
    eq([link.announcesWaits({ features: ['waitingFor'], announcesWaits: () => true }), link.announcesWaits({ features: [], announcesWaits: () => true }),
      link.announcesWaits({ features: ['waitingFor'] }), link.announcesWaits({ features: ['waitingFor'], announcesWaits() { throw new Error('x'); } }),
      link.announcesWaits(null)], [true, false, false, false, false],
    'core-link.announcesWaits is true only for a host with waitingFor that says it announces');
  }
};
