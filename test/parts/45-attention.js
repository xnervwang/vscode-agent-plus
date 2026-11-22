// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversations that need the user, across windows (src/attention.js): each window writes what its sources report, only
 * the window with the focus shows a notification, changes close together make one, and a window that reloads does not
 * show again what it showed before. The conversations here carry only `state`, which gives their activity;
 * 47-attention-activity.js has the activity rules themselves. In a running window the notification is a plain message
 * whose Open button opens the conversation.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

const conv = (id, state, title = id) => ({ sessionId: id, state, title, cwd: '/w', running: true });

module.exports = async ({ eq, tmp, root, wait }) => {
  const at = require(path.join(root, 'src', 'attention.js'));
  const dir = path.join(tmp('shared'), 'attention');
  let clock = 1000000;
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  const settings = { enabled: true, finished: true, waiting: true };
  const windows = {};
  const make = (name, { focused = false, looking = () => false } = {}) => {
    const w = { name, focused, shown: [], painted: [] };
    w.att = at.createAttention({ dir, windowId: `${name}-0000000${Object.keys(windows).length}`, now: () => clock, focused: () => w.focused,
      lookedAt: looking, settings: () => settings, warmupMs: 0, batchMs: 10,
      show: (text, items) => { w.shown.push({ text, ids: items.map((it) => it.sessionId) }); },
      paint: (items) => { w.painted = items.map((it) => `${it.sessionId}:${it.kind}`); } });
    windows[name] = w;
    return w;
  };
  const lists = (...cs) => [{ sourceId: 'codex', label: 'Codex', conversations: cs }];
  /* The notifications a window has shown since the last call. */
  const fresh = (w) => w.shown.splice(0).map((n) => n.text);

  const a = make('a'), b = make('b', { focused: true });
  a.att.publish(lists(conv('x', 'working'), conv('y', 'idle')));
  a.att.refresh(); b.att.refresh();
  eq([fs.readdirSync(dir).length, b.painted], [1, []], 'a window writes a file of its own; nothing needs the user yet');

  a.att.publish(lists(conv('x', 'prompt', 'Fix the build'), conv('y', 'idle')));
  a.att.refresh(); b.att.refresh();
  await settle();
  eq([fresh(a), fresh(b), a.painted, b.painted], [[], ['"Fix the build" is waiting for you.'], ['x:waiting'], ['x:waiting']],
    'a permission prompt in one window is shown by the window with the focus alone, and counted in both');

  a.att.publish(lists(conv('x', 'working', 'Fix the build'), conv('y', 'working', 'Write the docs')));
  a.att.refresh(); b.att.refresh();
  a.att.publish(lists(conv('x', 'unread', 'Fix the build'), conv('y', 'unread', 'Write the docs')));
  a.att.refresh(); b.att.refresh();
  clock += at.STABLE_MS;
  a.att.refresh(); b.att.refresh();
  await settle();
  eq([b.shown.map((n) => n.ids), fresh(b)], [[['x', 'y']], ['2 conversations need you (2 finished): "Fix the build", "Write the docs".']],
    'two that finish together make one notification about both');

  a.att.publish(lists(conv('x', 'idle'), conv('y', 'unread', 'Write the docs')));
  a.att.refresh(); b.att.refresh();
  await settle();
  eq([fresh(b), b.painted], [[], ['y:finished']], 'once one of them is read, nothing is shown again, and the count is the other alone');

  b.focused = false;
  a.att.publish(lists(conv('x', 'prompt', 'Fix the build'), conv('y', 'unread', 'Write the docs')));
  a.att.refresh(); b.att.refresh();
  await settle();
  eq([fresh(a).length, fresh(b).length, b.painted.sort()], [0, 0, ['x:waiting', 'y:finished']],
    'with no window focused nothing is shown, and the status bar still counts');

  const c = make('c', { focused: true, looking: (it) => it.sessionId === 'z' });
  c.att.refresh();
  await settle();
  fresh(c);
  a.att.publish(lists(conv('x', 'prompt'), conv('y', 'unread'), conv('z', 'working', 'Seen here')));
  a.att.refresh(); c.att.refresh();
  a.att.publish(lists(conv('x', 'prompt'), conv('y', 'unread'), conv('z', 'unread', 'Seen here')));
  a.att.refresh(); c.att.refresh();
  clock += at.STABLE_MS;
  c.att.refresh();
  await settle();
  eq(fresh(c), [], 'a conversation the focused window shows in front is not announced there');

  /* The window that reported them reloads: its file goes, and the new one reports the same states. */
  a.att.dispose();
  c.att.refresh();
  const a2 = make('a2');
  a2.att.publish(lists(conv('x', 'prompt'), conv('y', 'unread'), conv('z', 'unread')));
  c.att.refresh();
  await settle();
  eq([fs.existsSync(path.join(dir, 'a-00000000.json')), fresh(c)], [false, []],
    'a window that closes takes its file with it, and what its next copy reports again is not announced again');

  settings.finished = false;
  a2.att.publish(lists(conv('x', 'prompt'), conv('y', 'unread'), conv('z', 'unread'), conv('w', 'working', 'Quiet')));
  a2.att.refresh(); c.att.refresh();
  a2.att.publish(lists(conv('x', 'prompt'), conv('y', 'unread'), conv('z', 'unread'), conv('w', 'unread', 'Quiet')));
  a2.att.refresh(); c.att.refresh();
  clock += at.STABLE_MS;
  c.att.refresh();
  await settle();
  eq(fresh(c), [], 'with finished turns turned off, a finished one is not announced');
  settings.finished = true;
  settings.enabled = false;
  a2.att.publish(lists(conv('v', 'prompt', 'Off')));
  c.att.refresh();
  await settle();
  eq([fresh(c), c.painted], [[], []], 'with notifications off, nothing is shown or counted');
  settings.enabled = true;

  clock += at.STALE_MS + 1;
  c.att.refresh();
  eq(c.painted, [], 'a file not written for a minute is a window that has gone');

  const quiet = at.createAttention({ dir: path.join(tmp('ro'), 'attention'), windowId: 'ro-00000000', now: () => clock, focused: () => true,
    settings: () => settings, canWrite: () => false, show: () => {} });
  quiet.publish(lists(conv('x', 'prompt')));
  eq(fs.existsSync(path.join(tmp('ro'), 'attention')), false, 'in Restricted Mode a window writes nothing');

  const warm = at.createAttention({ dir, windowId: 'wa-00000000', now: () => clock, focused: () => true, settings: () => settings,
    batchMs: 10, show: (t) => { warmShown.push(t); } });
  const warmShown = [];
  a2.att.publish(lists(conv('q', 'prompt', 'Old')));
  warm.refresh();
  await settle();
  eq(warmShown, [], 'what a window finds in its first seconds was there before it started, and is not announced');
  for (const w of [b, c, a2]) w.att.dispose();
  warm.dispose();

  /* The user looking at a conversation in the window with the focus. */
  const win = (wdir, name, focus, looking) => {
    const w = { focused: focus, looking, shown: [], painted: [] };
    w.att = at.createAttention({ dir: wdir, windowId: `${name}-00000000`, now: () => clock,
      focused: () => w.focused, lookedAt: (it) => w.looking.includes(it.sessionId), settings: () => settings, warmupMs: 0, batchMs: 10,
      show: (text) => { w.shown.push({ text }); },
      paint: (items) => { w.painted = items.map((it) => `${it.sessionId}:${it.kind}`).sort(); } });
    return w;
  };
  const solo = win(path.join(tmp('solo'), 'attention'), 's', true, ['solo']);
  solo.att.publish(lists(conv('solo', 'working', 'Solo')));
  solo.att.refresh();
  solo.att.publish(lists(conv('solo', 'unread', 'Solo')));
  solo.att.refresh();
  clock += at.STABLE_MS;
  solo.att.refresh();
  await settle();
  solo.att.refresh();
  eq([solo.shown.length, solo.painted], [0, []], 'one window with one conversation, watched until its turn finishes: no notification and no count');

  const fdir = path.join(tmp('front'), 'attention');
  const p = win(fdir, 'p', true, ['mine']), q = win(fdir, 'q', false, []);
  p.att.publish(lists(conv('mine', 'prompt', 'Mine'), conv('other', 'prompt', 'Other')));
  p.att.refresh(); q.att.refresh();
  await settle();
  p.att.refresh(); q.att.refresh();
  eq([fresh(p), p.painted, q.painted], [['"Other" is waiting for you.'], ['other:waiting'], ['other:waiting']],
    'a conversation waiting in front of the user in the focused window is neither announced nor counted, there or in another window');
  p.looking = ['other'];
  p.att.refresh(); q.att.refresh();
  await settle();
  eq([fresh(p), p.painted, q.painted], [[], ['mine:waiting'], ['mine:waiting']],
    'bringing the other to the front stops counting it, and the one the user left is counted again without being announced');
  p.focused = false;
  p.att.refresh(); q.att.refresh();
  await settle();
  eq([fresh(p), p.painted, q.painted], [[], ['mine:waiting', 'other:waiting'], ['mine:waiting', 'other:waiting']],
    'once no window has the focus, both count again, and neither is announced');
  for (const w of [solo, p, q]) w.att.dispose();

  /* In a running window: a plain message with an Open and a Dismiss button, or Show them for several. */
  {
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 20,
      attentionWarmupMs: 0, attentionBatchMs: 10 } });
    const { vscode, control } = b;
    vscode.window.state = { focused: true };
    control.state.answers.push(['is waiting for you', 'Open']);
    const opened = [];
    let listed = [{ sessionId: 'n', title: 'Needs you', cwd: '/w', state: 'prompt', activity: 'waiting', running: true }];
    b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', listConversations: async () => [],
      listAllConversations: async () => listed, open: async (id) => { opened.push(id); return 'here'; } });
    await wait(300);
    const said = () => control.state.said.filter((m) => /need|waiting|finished/.test(m.message)).map((m) => [m.kind, m.message, m.buttons]);
    eq([said(), opened], [[['info', '"Needs you" is waiting for you.', ['Open', 'Dismiss']]], ['n']],
      'one conversation gets a plain message with Open and Dismiss, and Open opens it');
    b.close();
    const two = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 20,
      attentionWarmupMs: 0, attentionBatchMs: 10 } });
    two.vscode.window.state = { focused: true };
    listed = [{ sessionId: 'p', title: 'One', cwd: '/w', state: 'prompt', activity: 'waiting', running: true },
      { sessionId: 'q', title: 'Two', cwd: '/w', state: 'prompt', activity: 'waiting', running: true }];
    two.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', listConversations: async () => [],
      listAllConversations: async () => listed });
    await wait(300);
    eq(two.control.state.said.filter((m) => /need you/.test(m.message)).map((m) => [m.message, m.buttons]),
      [['2 conversations need you (2 waiting for you): "One", "Two".', ['Show them', 'Dismiss']]], 'several get Show them and Dismiss');
    two.close();
  }

  /* Titles in the shared files: a steward's gets its crown again, marks left in a title are taken out. */
  const tdir = path.join(tmp('titles'), 'attention');
  fs.mkdirSync(tdir, { recursive: true });
  const item = (id, title, extra) => Object.assign({ sourceId: 'claude-code', source: 'Claude Code', sessionId: id, state: 'prompt',
    activity: 'waiting', unseen: false, title, cwd: '/w' }, extra);
  fs.writeFileSync(path.join(tdir, 'n1-00000000.json'), JSON.stringify({ format: 1, at: clock, front: [], items: [
    item('s', 'Steward \u{1F6CE}\uFE0F', { steward: true }), item('o', '\u{1F451} Old steward'), item('p', 'Plain \u2709\uFE0F', { steward: false })] }));
  eq([...at.readAll(tdir, clock).merged.values()].map((it) => [it.sessionId, it.title]),
    [['s', '\u{1F451} Steward'], ['o', '\u{1F451} Old steward'], ['p', 'Plain']],
    'a title read from a window\'s file is drawn again: a steward\'s with one crown first, and an older window\'s title with a crown first counts as a steward\'s');
  eq(at.itemsOf([{ sourceId: 'claude-code', label: 'Claude Code', conversations: [require(path.join(root, 'src', 'sources.js'))
    .conversation({ sessionId: 'm', title: 'Manager \u{1F6CE}', state: 'prompt', steward: true })] }]).map((it) => [it.title, it.steward]),
  [['\u{1F451} Manager', true]], 'and a window writes the drawn title with steward beside it');
};
