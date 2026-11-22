// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * When a conversation is announced (src/attention.js), read from its activity and whether it has a reply not seen: on
 * starting to wait for the user, and on stopping with such a reply once it has stayed stopped for the stable period
 * after working. A reply not seen turning up alone is not announced. The status bar counts the waiting ones and the
 * stopped ones with a reply not seen. A window of an older version, which writes only `state`, is still read.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const at = require(path.join(root, 'src', 'attention.js'));
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  let clock = 5000000;
  const settings = { enabled: true, finished: true, waiting: true };
  const conv = (id, activity, unseen = false, title = id) => ({ sessionId: id, state: 'idle', activity, unseen, title, cwd: '/w', running: true });
  const lists = (...cs) => [{ sourceId: 'claude-code', label: 'Claude Code', conversations: cs }];
  const win = (dir, name, { focused = true, stableMs } = {}) => {
    const w = { shown: [], painted: [] };
    w.att = at.createAttention({ dir, windowId: `${name}-00000000`, now: () => clock, focused: () => focused, settings: () => settings,
      warmupMs: 0, batchMs: 10, ...(stableMs === undefined ? {} : { stableMs }),
      show: (text) => { const n = { text, open: true }; w.shown.push(n); return { update(t) { n.text = t; }, close() { n.open = false; } }; },
      paint: (items) => { w.painted = items.map((it) => `${it.sessionId}:${it.kind}`).sort(); },
      links: { open: (it) => `open:${it.sessionId}`, list: () => 'list' } });
    w.open = () => w.shown.filter((n) => n.open).map((n) => n.text);
    w.step = async (...cs) => { w.att.publish(lists(...cs)); w.att.refresh(); await settle(); w.att.refresh(); };
    return w;
  };

  eq(at.STABLE_MS, 5000, 'the stable period is 5 seconds unless the caller gives another');

  const dir = path.join(tmp('shared'), 'attention');
  const w = win(dir, 'a');
  await w.step(conv('x', 'working'), conv('y', 'working'));
  eq([w.open(), w.painted], [[], []], 'conversations at work are neither announced nor counted');

  await w.step(conv('x', 'waiting', false, 'Fix the build'), conv('y', 'working'));
  eq([w.open(), w.painted], [['"Fix the build" is waiting for you. [Open](open:x)'], ['x:waiting']],
    'one that starts to wait for the user is announced and counted');

  await w.step(conv('x', 'working'), conv('y', 'stopped', true, 'Write the docs'));
  eq([w.open(), w.painted], [[], ['y:finished']],
    'one that stops with a reply not seen is counted at once but not announced yet, and the waiting one\'s notice closes once it works again');
  clock += 4999;
  await w.step(conv('x', 'working'), conv('y', 'stopped', true, 'Write the docs'));
  eq(w.open(), [], 'not before the stable period is over');
  clock += 1;
  await w.step(conv('x', 'working'), conv('y', 'stopped', true, 'Write the docs'));
  eq(w.open(), ['"Write the docs" finished. [Open](open:y)'], 'and announced once it has stayed stopped for the stable period');
  clock += 60000;
  await w.step(conv('x', 'working'), conv('y', 'stopped', true, 'Write the docs'));
  eq(w.shown.length, 2, 'staying stopped does not announce it again');

  await w.step(conv('x', 'stopped', true, 'Fix the build'), conv('y', 'working', true));
  eq([w.open(), w.painted], [[], ['x:finished']],
    'the finished notice closes when its conversation starts working again, even with its reply still not seen, and that one is not counted');
  clock += 2000;
  await w.step(conv('x', 'working', true), conv('y', 'working', true));
  clock += 10000;
  await w.step(conv('x', 'working', true), conv('y', 'working', true));
  eq([w.shown.length, w.painted], [2, []], 'one that starts working again within the stable period is not announced');

  await w.step(conv('x', 'background'), conv('y', 'working', true));
  clock += 6000;
  await w.step(conv('x', 'stopped', true, 'Fix the build'), conv('y', 'working', true));
  clock += 5000;
  await w.step(conv('x', 'stopped', true, 'Fix the build'), conv('y', 'working', true));
  eq(w.open(), ['"Fix the build" finished. [Open](open:x)'], 'a conversation whose background work ends with a reply not seen is announced too');

  const quiet = win(path.join(tmp('envelope'), 'attention'), 'e');
  await quiet.step(conv('p', 'working'), conv('q', 'working'));
  await quiet.step(conv('p', 'working'));
  await quiet.step(conv('p', 'working'), conv('q', 'stopped', true, 'Read it later'));
  clock += 6000;
  await quiet.step(conv('p', 'working'), conv('q', 'stopped', true, 'Read it later'));
  eq([quiet.shown.length, quiet.painted], [0, ['q:finished']],
    'a reply not seen turning up on a conversation that had already stopped is not announced, and is counted');

  settings.finished = false;
  const off = win(path.join(tmp('off'), 'attention'), 'o', { stableMs: 100 });
  await off.step(conv('r', 'working'));
  await off.step(conv('r', 'stopped', true));
  clock += 200;
  await off.step(conv('r', 'stopped', true));
  eq([off.shown.length, off.painted], [0, ['r:finished']], 'with finished turns turned off one is not announced, and still counted');
  settings.finished = true;
  eq((await (async () => { const s = win(path.join(tmp('short'), 'attention'), 's', { stableMs: 100 });
    await s.step(conv('r', 'working')); await s.step(conv('r', 'stopped', true)); clock += 100; await s.step(conv('r', 'stopped', true));
    const n = s.shown.length; s.att.dispose(); return n; })()), 1, 'the stable period is an option');

  const own = JSON.parse(fs.readFileSync(path.join(dir, 'a-00000000.json'), 'utf8'));
  eq(own.items.map((it) => [it.sessionId, it.state, it.activity, it.unseen]), [['x', 'idle', 'stopped', true], ['y', 'idle', 'working', true]],
    'the shared file carries each conversation\'s activity and unseen beside its state');
  eq(at.itemsOf(lists(conv('s', 'stopped'), conv('t', 'stopped', true), { sessionId: 'u', state: 'unread', title: 'old', running: true },
    { sessionId: 'v', state: 'prompt', running: true }, { sessionId: 'z', state: 'working', activity: 'waiting', running: false }))
    .map((it) => [it.sessionId, it.activity, it.unseen]), [['v', 'waiting', false], ['t', 'stopped', true], ['u', 'stopped', true]],
  'a stopped conversation with nothing unseen, and one not running, are not written; one with only a state is read from it; waiting ones come first');

  /* A window of an older version: format 1 with only state on its items, prompt and unread. */
  const odir = path.join(tmp('older'), 'attention');
  fs.mkdirSync(odir, { recursive: true });
  const reader = win(odir, 'n');
  const older = (items) => fs.writeFileSync(path.join(odir, 'o1-00000000.json'), JSON.stringify({ format: 1, at: clock, items, front: [] }));
  const item = (id, state, title = id) => ({ sourceId: 'codex', source: 'Codex', sessionId: id, state, title, cwd: '/w' });
  older([]);
  reader.att.refresh();
  older([item('k', 'prompt', 'Old prompt'), item('m', 'unread', 'Old reply')]);
  reader.att.refresh();
  await settle();
  reader.att.refresh();
  eq([reader.painted, reader.open()], [['k:waiting', 'm:finished'], ['"Old prompt" is waiting for you. [Open](open:k)']],
    'an older window\'s prompt and unread are read as waiting and as stopped with a reply not seen, and its prompt is announced');
  clock += 5000;
  older([item('k', 'prompt', 'Old prompt'), item('m', 'unread', 'Old reply')]);
  reader.att.refresh();
  await settle();
  reader.att.refresh();
  eq(reader.open(), ['"Old prompt" is waiting for you. [Open](open:k)', '"Old reply" finished. [Open](open:m)'],
    'an unread reply from an older window, which never says a turn was running, is announced once it has stayed for the stable period');
  for (const x of [w, quiet, off, reader]) x.att.dispose();

  /* In a running window: a question put in a plan after the user's last message is written to the shared file as waiting. */
  {
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 100000 } });
    const { vscode } = b;
    const ws = tmp('ws'), plans = tmp('plans');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
    const asked = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(plans, 'q.json'), JSON.stringify({ nodes: [{ title: 'r', state: 'waiting', waitingOn: 'user', question: 'Go?', asked }] }));
    fs.writeFileSync(path.join(plans, 'o.json'), JSON.stringify({ nodes: [{ title: 'r', state: 'waiting', waitingOn: 'user', question: 'Go?', asked }] }));
    const listed = [
      { sessionId: 'q', title: 'Asks', cwd: '/elsewhere', state: 'idle', activity: 'stopped', running: true, lastUserAt: Date.now() - 60000 },
      { sessionId: 'o', title: 'Asked before', cwd: '/elsewhere', state: 'idle', activity: 'working', running: true, lastUserAt: Date.now() },
    ];
    b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
      listConversations: async () => [], listAllConversations: async () => listed });
    await wait(150);
    const files = fs.readdirSync(path.join(b.home, 'attention'));
    const items = files.length === 1 ? JSON.parse(fs.readFileSync(path.join(b.home, 'attention', files[0]), 'utf8')).items : [];
    eq(items.map((it) => [it.sessionId, it.activity]), [['q', 'waiting'], ['o', 'working']],
      'a window reads the plans of the conversations it reports, wherever they are, so a new question counts as waiting in every window');
    b.close();
  }
};
