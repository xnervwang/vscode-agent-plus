// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Temporary conversations in the session list (src/session-list.js, src/session-store.js): started from the New bar or
 * registered by their source, left out of every section, given a grace period once closed that is written to the
 * store, deleted by their source when it ends, kept or deleted at once from the notification, and never made
 * temporary by a source once the user has written to them.
 */
const path = require('path');

const MIN = 60e3;
const DAY = 24 * 3600e3;

module.exports = async ({ eq, tmp, root }) => {
  const fake = require(path.join(root, 'test', 'fake-vscode.js'));
  const L = require(path.join(root, 'src', 'session-list.js'));
  const now0 = 400 * DAY;
  let clock = now0;
  const now = () => clock;

  function setup({ shared = tmp('shared'), folder = tmp('ws') } = {}) {
    clock = now0;
    const { vscode, control } = fake.create({ trusted: true });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(folder) }];
    const entries = [];
    const registry = { entries, get: (id) => (entries.find((e) => e.id === id) || {}).source || null, entry: (id) => entries.find((e) => e.id === id) || null };
    const host = { vscode, registry, trusted: () => control.state.trusted, memento: fake.memento(), globalMemento: fake.memento(),
      shared: (name) => path.join(shared, name), asksOf: () => false, open: async () => 'sent', settings: () => ({ tempMinutes: 10 }) };
    return { vscode, control, entries, host, shared, folder };
  }
  /* A made-up source that can start and delete temporary conversations; `refuse` makes its deletes refused. */
  function source(id, list, { features = ['sessions', 'temporary'], made = '' } = {}) {
    const ev = new fake.EventEmitter();
    const s = {
      protocol: 1, id, label: id, features, sessions: list, calls: [], made, refuse: '',
      listSessions: async () => ({ sessions: s.sessions.slice(), cursor: null }),
      onDidChangeSessions: ev.event, changed: () => ev.fire(),
      sessionActions: { open: ['tab', 'sidebar'], create: ['tab', 'sidebar'], rename: true, delete: true, own: [] },
      runSessionAction: async (action, ids, args) => {
        s.calls.push([action, ids, args]);
        if (action === 'create') return { results: [{ sessionId: s.made, outcome: 'done' }] };
        if (action === 'delete' && s.refuse) return { results: ids.map((x) => ({ sessionId: x, outcome: 'refused', reason: s.refuse })) };
        if (action === 'delete') s.sessions = s.sessions.filter((x) => !ids.includes(x.sessionId));
        return { results: ids.map((x) => ({ sessionId: x, outcome: 'done' })) };
      },
      sessionForTab: (tab) => (tab && tab.input && tab.input.source === id ? tab.input.sid : null),
      reveal: async () => true,
    };
    return s;
  }
  const conv = (id, o = {}) => Object.assign({ sessionId: id, title: id, cwd: '/w', activity: 'stopped', createdAt: now0 - DAY, lastActiveAt: now0 - DAY, lastReplyAt: now0 - DAY }, o);
  const tab = (sid) => ({ label: sid, input: { source: 'codex', sid } });
  const allRows = (list) => list.model().sections.flatMap((x) => x.rows.map((r) => r.id));
  const deletes = (s) => s.calls.filter((c) => c[0] === 'delete').map((c) => [c[1], c[2]]);

  /* ── Started from the New bar, left out of the list, deleted after the grace period ── */
  {
    const t = setup();
    const codex = source('codex', [conv('keep', { title: 'Ordinary' })], { made: 'tmp1' });
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    const told = [];
    list.onDidChangeTemporary((e) => told.push(e.sourceId));
    await list.refresh();
    eq(await list.create('codex', 'tab', '', { temporary: true }), 'done', 'the New bar starts a temporary conversation');
    eq(codex.calls.find((c) => c[0] === 'create')[2], { where: 'tab', temporary: true }, 'and asks its source for one with temporary: true');
    codex.sessions.push(conv('tmp1', { title: 'Scratch question', createdAt: now0, lastActiveAt: now0, lastUserAt: now0 }));
    t.control.setTabs([tab('tmp1')], 0);
    await list.refresh({ relist: true });
    eq([list.isTemporary('codex', 'tmp1'), list.temporaryIds('codex'), told.includes('codex'), allRows(list), list.model().counts.all],
      [true, ['tmp1'], true, ['keep'], 1],
      'it is temporary, onDidChangeTemporary told its source, and no section of the list shows it or counts it');
    t.control.answer('Temporary conversation "Scratch question" was closed', undefined);
    t.control.setTabs([], 0);
    clock = now0 + MIN;
    await list.refresh();
    const rec = list.store().record('codex', 'tmp1').temp;
    const said = t.control.state.said.find((x) => /Temporary conversation "Scratch question" was closed\. It is deleted in 10 minutes\./.test(x.message));
    eq([rec.closedAt, rec.deleteAt, !!said, said && said.buttons, deletes(codex)], [now0 + MIN, now0 + 11 * MIN, true, ['Keep', 'Delete Now'], []],
      'closing it writes the closing and due times to the store at once, and this window tells the user, with Keep and Delete Now');
    eq((list.model().sections.find((x) => x.key === 'closed') || { rows: [] }).rows.map((r) => r.id), [], 'it is not listed under Recently closed');
    clock = now0 + 11 * MIN + 1000;
    await list.refresh();
    await list.deleteDueTemps();
    eq([deletes(codex), list.isTemporary('codex', 'tmp1'), codex.sessions.map((x) => x.sessionId)], [[[['tmp1'], { temporary: true }]], false, ['keep']],
      'once the time is up its source is asked to delete it with temporary: true, and its record goes');
    list.dispose();
  }

  /* ── The due time lives on disk: a window started after it deletes at its first look ── */
  {
    const shared = tmp('shared');
    const folder = tmp('ws');
    const t1 = setup({ shared, folder });
    const c1 = source('codex', [conv('t2', { title: 'Left behind', lastUserAt: now0 })]);
    t1.entries.push({ id: 'codex', source: c1 });
    const one = L.createSessionList(t1.host, { now });
    await one.refresh();
    eq(one.addTemporary('codex', 't2', { by: 'source' }), { ok: true, reason: '' }, 'a source registers a conversation it started as temporary');
    eq(one.addTemporary('codex', 't2', { by: 'source' }), { ok: true, reason: '' }, 'and registering it again is no error');
    t1.control.setTabs([tab('t2')], 0);
    await one.refresh({ relist: true });
    t1.control.setTabs([], 0);
    clock = now0 + MIN;
    await one.refresh();
    const due = one.store().record('codex', 't2').temp.deleteAt;
    one.dispose();
    /* The window and its timer are gone. Later, another window of the project starts. */
    clock = due + 30 * MIN;
    const t2 = setup({ shared, folder });
    clock = due + 30 * MIN;
    const c2 = source('codex', [conv('t2', { title: 'Left behind', lastUserAt: now0 })]);
    t2.entries.push({ id: 'codex', source: c2 });
    const two = L.createSessionList(t2.host, { now });
    await two.refresh();
    await two.deleteDueTemps();
    eq([due, deletes(c2)], [now0 + 11 * MIN, [[['t2'], { temporary: true }]]],
      'the next start deletes a temporary conversation whose time ran out while no window was there');
    two.dispose();
  }

  /* ── Keep, Delete Now, a refused delete, and one shown again ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'Kept one', lastUserAt: now0 }), conv('b', { title: 'Gone now', lastUserAt: now0 }), conv('c', { title: 'Back again', lastUserAt: now0 })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    for (const id of ['a', 'b', 'c']) list.addTemporary('codex', id);
    t.control.setTabs([tab('a'), tab('b'), tab('c')], 0);
    await list.refresh({ relist: true });
    t.control.answer('"Kept one" was closed', 'Keep');
    t.control.answer('"Gone now" was closed', 'Delete Now');
    t.control.setTabs([tab('c')], 0);
    clock = now0 + MIN;
    await list.refresh();
    await new Promise((r) => setTimeout(r, 20));
    await list.deleteDueTemps();
    await list.refresh({ relist: true });
    eq([list.isTemporary('codex', 'a'), allRows(list).includes('a'), deletes(codex)], [false, true, [[['b'], { temporary: true }]]],
      'Keep makes it ordinary and back in the list; Delete Now deletes it at once');
    t.control.setTabs([], 0);
    clock = now0 + 2 * MIN;
    await list.refresh();
    t.control.setTabs([tab('c')], 0);
    clock = now0 + 3 * MIN;
    await list.refresh();
    eq(list.store().record('codex', 'c').temp, { by: 'source', addedAt: now0, closedAt: 0, deleteAt: 0 }, 'one opened again within the grace period has it cleared');
    t.control.setTabs([], 0);
    clock = now0 + 4 * MIN;
    await list.refresh();
    codex.refuse = 'it is open in a terminal';
    clock = now0 + 20 * MIN;
    await list.refresh();
    await list.deleteDueTemps();
    eq([list.isTemporary('codex', 'c'), deletes(codex).length], [true, 2], 'a delete its source refuses keeps the record, for the next try');
    list.dispose();
  }

  /* ── What cannot be made temporary ── */
  {
    const t = setup();
    const codex = source('codex', [conv('old', { title: 'Old talk', lastUserAt: now0 - DAY }), conv('mine', { title: 'Open one', lastUserAt: now0 - DAY })]);
    const plain = source('opencode-plus', [conv('o1')], { features: ['sessions'] });
    t.entries.push({ id: 'codex', source: codex }, { id: 'opencode-plus', source: plain });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    eq([list.addTemporary('codex', 'old', { by: 'supervisor' }).ok, list.isTemporary('codex', 'old')], [false, false],
      'a source cannot make temporary a conversation the user wrote to over two minutes ago');
    eq([list.addTemporary('opencode-plus', 'o1').ok, await list.create('opencode-plus', 'tab', '', { temporary: true })], [false, 'nowhere'],
      'nor can a source without the feature, and the New bar starts no temporary conversation in it');
    t.control.setTabs([tab('mine')], 0);
    await list.refresh();
    const row = list.model().sections.flatMap((x) => x.rows).find((r) => r.id === 'mine');
    eq([row.ctx.tempable, list.model().menu.some((m) => m.name === 'makeTemp' && m.when === 'row && tempable')], [true, true],
      'an ordinary conversation open here offers Make Temporary in its menu');
    t.control.answer('Make "Open one" temporary?', 'Make Temporary');
    eq(await list.act('makeTemp', ['["codex","mine"]']), 'done', 'and the user makes it temporary after saying yes');
    await list.refresh();
    eq([list.isTemporary('codex', 'mine'), list.store().record('codex', 'mine').temp.by, allRows(list).includes('mine')], [true, 'convert', false],
      'it is temporary and leaves the list');
    list.dispose();
  }
};
