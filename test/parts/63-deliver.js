// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * deliver() and planPathOf() on the interface (src/host.js, src/views.js, src/answers.js): a dependent extension's
 * message goes through the answers folder to whichever window can type it into the conversation, and its outcome comes
 * back to the caller.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const answers = require(path.join(root, 'src', 'answers.js'));
  const viewOptions = { listWaitMs: 40, slowMs: 1e9, refreshMs: 1e9, answerPollMs: 25 };
  const until = async (fn) => { for (let i = 0; i < 150 && !fn(); i++) await wait(20); };
  const within = (p, ms = 5000) => Promise.race([p, wait(ms).then(() => 'still waiting')]);
  const files = (dir) => { try { return fs.readdirSync(dir).filter((n) => !n.endsWith('.tmp')).sort(); } catch (_) { return []; } };
  const start = (over = {}) => {
    let views = null;
    /* src/views.js needs the stand-in VS Code, which boot() installs before it builds the views. */
    const b = boot(root, tmp, Object.assign({ viewOptions, views: (h, o) => (views = require(path.join(root, 'src', 'views.js')).create(h, o)) }, over));
    b.views = () => views;
    b.dir = path.join(b.home, 'answers');
    return b;
  };
  /* Another window on this machine: a Courier over the same folder, with its own source. */
  const elsewhere = (dir, source) => {
    const via = answers.throughSources((id) => (id === 'opencode-plus' ? source : null));
    const courier = new answers.Courier({ dir, canShow: via.canShow, hand: via.hand, finish: () => {} });
    const t = setInterval(() => courier.pump(), 10);
    return { courier, dispose() { clearInterval(t); courier.dispose(); } };
  };

  /* ── The conversation is open in this window ── */
  {
    const b = start();
    const got = [];
    let next = { outcome: 'submitted' };
    b.api.registerSource({ protocol: 1, id: 'opencode-plus', label: 'OpenCode Agent Plus', listConversations: async () => [],
      canDeliver: (id) => id === 'ses_A',
      deliverAnswer: async (id, text, opts) => { got.push([id, text, opts && opts.deliveryId]); return next; } });
    await wait(60);
    const r = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'Please rebase on main.' }));
    const view = b.control.state.webviews['agentPlus.answer'];
    eq([r, Object.isFrozen(r), got.map((g) => [g[0], g[1]]), /^[0-9a-z]+-[0-9a-f]{8}$/.test(got[0] && got[0][2]), files(b.dir), view.states.size,
      b.control.state.clipboard, b.views()._parts.deliveries()],
      [{ outcome: 'submitted', reason: '' }, true, [['ses_A', 'Please rebase on main.']], true, [], 0, '', 0],
      'a message to a conversation open in this window is typed into it, with a delivery id; the caller gets a frozen submitted, and the folder, the Answer view and the clipboard are left as they were');
    next = { outcome: 'notReceived', reason: 'it is waiting for approval of bash in its window' };
    const no = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'And then run the tests.' }));
    eq([no, b.control.state.clipboard], [{ outcome: 'notReceived', reason: 'it is waiting for approval of bash in its window' }, ''],
      'the source\'s reason for not taking it reaches the caller, and nothing is put on the clipboard');
    const longest = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'x'.repeat(answers.MAX_MESSAGE) }));
    eq([longest.outcome, got.length], ['notReceived', 3], `a message of exactly ${answers.MAX_MESSAGE} characters is sent`);
    const twice = [await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'same' })),
      await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'same' }))];
    eq([twice.map((x) => x.outcome), got.slice(-2).map((g) => g[1]), got[got.length - 1][2] !== got[got.length - 2][2]],
      [['notReceived', 'notReceived'], ['same', 'same'], true], 'the same text sent twice is two messages, each with its own delivery id');

    const before = got.length;
    const thrower = { get sourceId() { throw new Error('no'); }, sessionId: 'ses_A', text: 'x' };
    const bad = await within(Promise.all([
      b.api.deliver({ sourceId: 'opencode-plus', text: 'no session' }),
      b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: '' }),
      b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: '   ' }),
      b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 42 }),
      b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'x'.repeat(answers.MAX_MESSAGE + 1) }),
      b.api.deliver({ sourceId: ' opencode-plus', sessionId: 'ses_A', text: 'x' }),
      b.api.deliver(thrower),
      b.api.deliver(null),
      b.api.deliver(),
    ]), 500);
    eq([bad.map((x) => x.outcome), bad.every((x) => typeof x.reason === 'string' && x.reason.length > 0 && Object.isFrozen(x)), got.length - before, files(b.dir)],
      [Array(9).fill('notReceived'), true, 0, []],
      'a missing session, no text, text that is not a string or is too long, an id with a space, a getter that throws, or no target at all: notReceived at once with a reason, and nothing written');
    b.close();
    const after = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'late' }));
    eq(after, { outcome: 'notReceived', reason: 'this window is closing' }, 'once the window is closing, deliver() says so');
  }

  /* ── The conversation is open in another window ── */
  {
    const b = start();
    b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', listConversations: async () => [] });
    await wait(60);
    const typed = [];
    const other = elsewhere(b.dir, { canDeliver: (id) => id === 'ses_B',
      deliverAnswer: async (id, text) => { typed.push(text); return { outcome: 'notReceived', reason: 'it is waiting for approval of bash in its window' }; } });
    const r = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_B', text: 'Please rebase.' }));
    eq([r, typed, b.views()._parts.deliveries()], [{ outcome: 'notReceived', reason: 'it is waiting for approval of bash in its window' }, ['Please rebase.'], 0],
      'the window that has the conversation takes the message, and the reason its source gives comes back to the caller here');
    other.dispose();

    /* A refresh of the Conversations view takes back an answer whose question changed, never a message. */
    const c = b.views()._parts.courier();
    let recalls = 0;
    const recall = c.recall.bind(c);
    c.recall = (keep) => { recalls++; return recall(keep); };
    const pending = b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_C', text: 'After the refresh.' });
    await b.control.state.handlers['agentPlus.refreshWorkPlan']();
    await until(() => recalls > 0);
    const kept = files(b.dir).filter((n) => n.endsWith('.json')).length;
    const late = elsewhere(b.dir, { canDeliver: (id) => id === 'ses_C', deliverAnswer: async () => ({ outcome: 'submitted' }) });
    eq([recalls > 0, kept, await within(pending)], [true, 1, { outcome: 'submitted', reason: '' }],
      'a refresh of the Conversations view leaves a message where it is, and a window can still take it');
    late.dispose();

    /* The sender closes while it waits. */
    const hung = elsewhere(b.dir, { canDeliver: (id) => id === 'ses_H', deliverAnswer: () => new Promise(() => {}) });
    const waiting = b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_N', text: 'nobody has this one' });
    const inHand = b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_H', text: 'taken, never settled' });
    await until(() => files(b.dir).some((n) => n.endsWith('.taken')));
    b.close();
    eq([await within(waiting), await within(inHand), files(b.dir).filter((n) => n.endsWith('.json'))],
      [{ outcome: 'notReceived', reason: 'this window closed before any window took it' },
        { outcome: 'uncertain', reason: 'this window closed before the outcome came back' }, []],
      'a window that closes while it waits answers every call: not received for one no window took, which it takes back, and uncertain for one already taken');
    hung.dispose();
  }

  /* With fs.watch() failing, as it does once the inotify watches run out, the outcome is read on the interval that runs
     while a call waits, not at the sender's next check 15 seconds on. */
  {
    const watch = fs.watch;
    fs.watch = () => { throw new Error('ENOSPC: System limit for number of file watchers reached'); };
    try {
      const b = start();
      b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', listConversations: async () => [] });
      await wait(60);
      const other = elsewhere(b.dir, { canDeliver: (id) => id === 'ses_W', deliverAnswer: async () => ({ outcome: 'submitted' }) });
      const r = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_W', text: 'with no watcher' }), 3000);
      eq(r, { outcome: 'submitted', reason: '' }, 'with no watcher on the answers folder, the outcome still comes back within seconds');
      other.dispose();
      b.close();
    } finally { fs.watch = watch; }
  }

  /* An answer typed in the Answer view and still on its way when the window closes is reported to finish() as well. */
  {
    const b = start();
    const ws = tmp('ws');
    b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(ws) }];
    const plans = tmp('plans');
    fs.writeFileSync(path.join(plans, 'S.json'), JSON.stringify({ nodes: [{ title: 'row', state: 'waiting', waitingOn: 'user', question: 'Merge it?' }] }));
    b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
      listConversations: async () => [{ sessionId: 'S', title: 'Task', cwd: ws, state: 'idle' }],
      canDeliver: () => false, deliverAnswer: async () => ({ outcome: 'submitted' }) });
    await wait(80);
    const conv = b.control.state.views['agentPlus.conversations'].provider;
    const row = conv.getChildren().find((e) => e.kind === 'conversation');
    const question = conv.getTreeItem(conv.getChildren(row)[0]).command.arguments[0];
    await b.control.state.handlers['agentPlus.answerQuestion'](question);
    const view = b.control.state.webviews['agentPlus.answer'];
    const key = view.current.key;
    view.receive({ type: 'send', key, text: 'Yes, merge.' });
    await wait(40);
    const sentFiles = files(b.dir).filter((n) => n.endsWith('.json')).length;
    b.close();
    eq([sentFiles, files(b.dir).filter((n) => n.endsWith('.json')).length, view.states.get(key).kind, b.control.state.clipboard], [1, 0, 'waiting', ''],
      'an answer on its way when the window closes is taken back, and the Answer view and the clipboard are not touched');
  }

  /* ── Restricted Mode ── */
  {
    const b = start({ trusted: false });
    const plans = tmp('plans');
    let asked = 0;
    b.api.registerSource({ protocol: 1, id: 'opencode-plus', label: 'OpenCode Agent Plus', listConversations: async () => [],
      planPath: (id) => path.join(plans, id + '.json'), canDeliver: () => true, deliverAnswer: async () => { asked++; return { outcome: 'submitted' }; } });
    await wait(60);
    const r = await within(b.api.deliver({ sourceId: 'opencode-plus', sessionId: 'ses_A', text: 'hi' }));
    eq([r, asked, files(b.dir), b.api.planPathOf('opencode-plus', 'ses_A')],
      [{ outcome: 'notReceived', reason: 'Agent Plus sends nothing in Restricted Mode' }, 0, [], path.join(plans, 'ses_A.json')],
      'in Restricted Mode deliver() sends nothing and says why, and planPathOf() still answers');
    b.close();
  }

  /* ── The outcome a caller gets, with the timeouts on a fake clock ── */
  {
    const dir = path.join(tmp('shared'), 'answers');
    let clock = 1000000;
    const timers = [];
    const later = (fn, ms) => { timers.push({ at: clock + ms, fn, live: true }); return timers.length; };
    const cancel = (n) => { if (timers[n - 1]) timers[n - 1].live = false; };
    const advance = (ms) => { clock += ms; for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); } };
    const settle = () => new Promise((r) => setImmediate(r));
    const window = (have) => {
      const heard = [];
      const via = answers.throughSources((id) => have[id] || null);
      const courier = new answers.Courier({ dir, now: () => clock, later, cancel, canShow: via.canShow, hand: via.hand,
        finish: (sent, result) => heard.push(answers.deliveryOutcome(result)) });
      return { courier, heard };
    };
    const lonely = window({});
    lonely.courier.send({ sourceId: 'opencode-plus', sessionId: 'S', text: 'x' }, {});
    advance(answers.TAKE_MS + 200);
    eq(lonely.heard, [{ outcome: 'notReceived', reason: `no VS Code window that has the conversation open took it within ${answers.TAKE_MS / 1000} seconds` }],
      'no window takes it: not received once the time to take it is up, saying so');
    const sender = window({});
    const taker = window({ 'opencode-plus': { canDeliver: () => true, deliverAnswer: () => new Promise(() => {}) } });
    sender.courier.send({ sourceId: 'opencode-plus', sessionId: 'S', text: 'y' }, {});
    taker.courier.pump(); await settle();
    advance(answers.TAKE_MS + 200);
    advance(answers.SEND_MS);
    sender.courier.pump();
    eq(sender.heard, [{ outcome: 'uncertain', reason: `a window took it, and no outcome came back within ${answers.SEND_MS / 1000} seconds; it may still arrive` }],
      'a window takes it and its source never answers: uncertain, with a reason');
    eq([answers.deliveryOutcome({ outcome: 'notReceived' }).reason !== '', answers.deliveryOutcome({ outcome: 'submitted', reason: 'ignored' }),
      answers.deliveryOutcome({ outcome: 'thrown away' }).outcome],
      [true, { outcome: 'submitted', reason: '' }, 'uncertain'], 'not received always says why; submitted has no reason; an outcome nobody can name is uncertain');

    /* A window of an older version takes a message the same way: its waiting() and throughSources() never read `row`. */
    const id = answers.post(dir, { sourceId: 'opencode-plus', sessionId: 'S', text: 'no row' }, clock);
    const found = answers.waiting(dir).find((a) => a.id === id);
    const typed = [];
    const via = answers.throughSources(() => ({ deliverAnswer: async (s, t, o) => { typed.push([s, t, o.deliveryId]); return { outcome: 'submitted' }; } }));
    let reported = null;
    via.hand(found, (r) => { reported = r; });
    await settle(); await settle();
    eq([!!found, 'row' in found, typed, reported], [true, false, [['S', 'no row', id]], { outcome: 'submitted', reason: '' }],
      'a record with no row is read and handed to its source like any answer');
    taker.courier.dispose();
  }

  /* ── planPathOf() ── */
  {
    const b = start();
    const plans = tmp('plans');
    const own = (id, planPath) => b.api.registerSource({ protocol: 1, id, label: id, listConversations: async () => [], planPath });
    own('opencode-plus', (id) => path.join(plans, id + '.json'));
    own('relative', (id) => path.join('plans', id + '.json'));
    own('empty', () => '');
    own('none', () => null);
    own('throws', () => { throw new Error('no plan'); });
    own('no-plan-path', undefined);
    const of = (s, id) => b.api.planPathOf(s, id);
    eq([of('opencode-plus', 'ses_A'), b.api.planPathOf({ sourceId: 'opencode-plus', sessionId: 'ses_A' }), of('relative', 'ses_A'), of('empty', 'ses_A'),
      of('none', 'ses_A'), of('throws', 'ses_A'), of('no-plan-path', 'ses_A'), of('not-registered', 'ses_A'), of('opencode-plus', ''),
      of('opencode-plus', ' ses_A'), b.api.planPathOf({ sourceId: 'opencode-plus' }), b.api.planPathOf()],
      [path.join(plans, 'ses_A.json'), path.join(plans, 'ses_A.json'), '', '', '', '', '', '', '', '', '', ''],
      'planPathOf() gives the absolute path the source registered here gives, in either form; anything else is \'\'');
    b.close();
  }
};
