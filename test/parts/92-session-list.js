// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's host side (src/session-list.js) with three made-up sources standing in for Claude Code, Codex
 * and OpenCode: reading page by page, the import done once, rows and sections, this window's tabs and the one in
 * front, what was closed here, another window's conversations, every action, deleting with its checks, archiving and
 * deleting on their own in one window at a time, each source's own actions, and when the list will delete what.
 */
const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600e3;

module.exports = async ({ eq, tmp, root, wait }) => {
  const fake = require(path.join(root, 'test', 'fake-vscode.js'));
  const L = require(path.join(root, 'src', 'session-list.js'));
  const now0 = 400 * DAY;
  let clock = now0;
  const now = () => clock;

  function setup({ trusted = true, folder = tmp('ws'), shared = tmp('shared') } = {}) {
    clock = now0;
    const { vscode, control } = fake.create({ trusted });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(folder) }];
    const entries = [];
    /* As src/sources.js's Registry: get() gives the source, entry() the entry. */
    const registry = { entries, get: (id) => (entries.find((e) => e.id === id) || {}).source || null, entry: (id) => entries.find((e) => e.id === id) || null };
    const opened = [], asks = new Set();
    const host = { vscode, registry, trusted: () => control.state.trusted, memento: fake.memento(), globalMemento: fake.memento(),
      shared: (name) => path.join(shared, name), asksOf: (sourceId, s) => asks.has(s.sessionId), open: async (t) => { opened.push(t); return 'sent'; },
      settings: () => ({}) };
    return { vscode, control, registry, host, opened, entries, shared, folder, asks };
  }

  /* A made-up source: its conversations, what it was asked to do, and what it was told was seen. */
  function source(id, list, { features = ['sessions', 'sessionImport', 'sessionSeen', 'shows'], imported = { archived: [], groups: [], pinned: [], colors: {} },
    own = [], caps = null } = {}) {
    const ev = new fake.EventEmitter(), close = new fake.EventEmitter();
    const s = {
      protocol: 1, id, label: id, features, sessions: list, calls: [], seen: [], pages: [], planDirPath: '', sidebar: new Set(), focused: '',
      planDir: () => s.planDirPath,
      listSessions: async ({ cursor, limit }) => {
        const from = cursor ? Number(cursor) : 0;
        s.pages.push([from, limit]);
        const next = from + limit < s.sessions.length ? String(from + limit) : null;
        return { sessions: s.sessions.slice(from, from + limit), cursor: next };
      },
      onDidChangeSessions: ev.event, changed: () => ev.fire(),
      onDidCloseSession: close.event, closed: (e) => close.fire(e),
      sessionActions: caps || { open: ['tab', 'sidebar'], create: ['tab'], rename: true, delete: true, own },
      runSessionAction: async (action, ids, args) => {
        s.calls.push([action, ids, args]);
        if (action === 'create') return { results: [{ sessionId: s.made || '', outcome: 'done' }] };
        if (action === 'delete') s.sessions = s.sessions.filter((x) => !ids.includes(x.sessionId));
        return { results: ids.map((x) => ({ sessionId: x, outcome: 'done' })) };
      },
      describeDeletion: async (ids) => ids.map((x) => ({ sessionId: x, what: `the file of ${x}` })),
      importSessions: async () => (typeof imported === 'function' ? imported() : imported),
      noteSeen: (ids, seen) => s.seen.push([ids, seen]),
      sessionForTab: (tab) => (tab && tab.input && tab.input.source === id ? tab.input.sid : null),
      shows: (x) => s.sidebar.has(x),
      isFocused: (x) => s.focused === x,
      reveal: async (x) => { s.calls.push(['reveal', [x]]); return true; },
    };
    return s;
  }
  const conv = (id, o = {}) => Object.assign({ sessionId: id, title: id, cwd: '/w', running: false, activity: 'stopped', createdAt: now0 - 30 * DAY,
    lastActiveAt: now0 - DAY, lastReplyAt: now0 - DAY }, o);

  /* ── Reading page by page, and the import done once ── */
  {
    const t = setup();
    const many = Array.from({ length: 1200 }, (_, i) => conv(`c-${String(i).padStart(4, '0')}`));
    const claude = source('claude-code', many.slice(0, 3), { imported: () => null });
    const codex = source('codex', many, { imported: { archived: [{ sessionId: 'c-0001', at: now0 - 50 * DAY }], groups: [{ name: 'Plugins', sessionIds: ['c-0002', 'c-0003', 'c-0001'] }],
      pinned: ['c-0003'], colors: { 'c-0004': 'green', 'c-9999': 'red' } } });
    t.entries.push({ id: 'claude-code', source: claude }, { id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    const st = list.store();
    st.flush();
    eq([codex.pages, list.rows().length], [[[0, 500], [500, 500], [1000, 500]], 1203], 'a source is read 500 a page until its cursor runs out');
    const rec = (s, i) => st.record(s, i);
    const g = st.groups();
    eq([g.map((x) => x.name), rec('codex', 'c-0002').group === g[0].id, rec('codex', 'c-0001').archived, rec('codex', 'c-0001').archivedAt,
      rec('codex', 'c-0001').group, rec('codex', 'c-0003').pinned, rec('codex', 'c-0004').color, st.imported('codex') > 0, st.imported('claude-code')],
    [['Plugins'], true, true, now0 - 50 * DAY, null, true, 'green', true, 0],
    'the import puts groups, archived (with its time, out of its group), pinned and colours in the store, once; a source that answers null is asked again');
    await list.refresh({ relist: true });
    st.flush();
    eq([st.imported('claude-code'), st.groups().length], [0, 1], 'a source that still cannot read its list\'s state is not counted imported');
    list.dispose();
  }

  /* ── Rows, this window, the one in front, closed here ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'Alpha', lastReplyAt: now0 - 60e3 }), conv('b', { title: 'Beta', activity: 'working', running: true }),
      conv('k', { title: 'Kid', kind: 'subagent', parentId: 'a' }), conv('e', { title: 'Empty', kind: 'empty' }),
      conv('q', { title: 'Asks' }), conv('d', { title: 'Dialog', activity: 'waiting', running: true, waitingFor: { kind: 'permission', tool: 'Bash' } })]);
    const oc = source('opencode', [conv('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', { title: 'Other agent' })],
      { features: ['sessions', 'sessionImport', 'sessionSeen', 'sessionClose'] });
    oc.sidebar.add('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    t.entries.push({ id: 'codex', source: codex }, { id: 'opencode', source: oc });
    t.asks.add('q');
    const list = L.createSessionList(t.host, { now });
    t.control.setTabs([{ label: 'Alpha', input: { source: 'codex', sid: 'a' } }, { label: 'x', input: {} }], 0);
    codex.sidebar.add('b');
    await list.refresh();
    let m = list.model();
    const flat = (mm) => Object.fromEntries(mm.sections.map((s) => [s.key, s.rows.map((r) => r.title)]));
    const byTitle = (mm, title) => mm.sections.flatMap((s) => s.rows).find((r) => r.title === title);
    eq([flat(m).ungrouped, m.counts, byTitle(m, 'Alpha').stripe, byTitle(m, 'Beta').stripe, byTitle(m, 'Dialog').dot, byTitle(m, 'Asks').dot, byTitle(m, 'Beta').dot],
      [['Alpha', 'Asks', 'Beta', 'Dialog', 'Other agent'], { all: 5, open: 2, running: 1, needs: 2 }, 'here', 'here', 'blue', 'red', 'green'],
      'rows of every source in one list, background and empty ones hidden, a tab or a sidebar here drawn as open here, with their dots and counts');
    eq(byTitle(m, 'Other agent').stripe, '', 'a sidebar is asked about only for a source that lists shows');
    eq([m.front, codex.seen, list.store().record('codex', 'a').seenAt], ['["codex","a"]', [[['a'], true]], now0 - 60e3],
      'the conversation in the tab in front is seen, and its source is told');
    t.host.settings = () => ({ hideBackground: false });
    await list.refresh();
    m = list.model();
    eq(m.sections.find((s) => s.key === 'ungrouped').rows.map((r) => [r.title, r.depth]).slice(0, 3), [['Alpha', 0], ['Kid', 1], ['Asks', 0]],
      'with background conversations shown, a sub-agent goes straight under the conversation that started it');
    t.host.settings = () => ({});

    /* Closing the tab. */
    clock = now0 + 120e3;
    t.control.setTabs([{ label: 'x', input: {} }], 0);
    t.control.fireTabs();
    await list.refresh();
    m = list.model();
    eq([flat(m).closed, byTitle(m, 'Alpha').stripe, (m.sections[0].rows[0] || {}).time], [['Alpha'], 'closed', 'closed now'],
      'a conversation whose tab closes is in Recently closed, and its own row gets the closed stripe');
    await list.reopenLast();
    eq(codex.calls.pop(), ['open', ['a'], { where: 'tab' }], 'reopening the last one closed opens it where it was, in a tab');
    oc.closed({ sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', where: 'sidebar' });
    await list.refresh();
    await list.reopenLast();
    eq(oc.calls.pop(), ['open', ['ses_aaaaaaaaaaaaaaaaaaaaaaaaaa'], { where: 'sidebar' }], 'a source that tells its closings says where, and the list reopens it there');
    list.dispose();
  }

  /* ── Another VS Code window, and a terminal ── */
  {
    const t = setup();
    const codex = source('codex', [conv('w', { title: 'In window B' }), conv('z', { title: 'In a terminal', elsewhere: [{ kind: 'terminal', label: 'terminal pts/3', detail: ['pid 77'], running: true }],
      activity: 'working', running: true }), conv('v', { title: 'Named by the source', elsewhere: [{ kind: 'vscode', label: 'a VS Code window' }] })]);
    codex.planDirPath = tmp('codex-plans');
    fs.mkdirSync(path.join(codex.planDirPath, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(codex.planDirPath, 'windows', `${process.ppid}.json`), JSON.stringify({ at: clock, pid: process.ppid, name: 'proj-b [SSH: host-b]', sessions: ['w', 'v'] }));
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    const m = list.model();
    const row = (title) => m.sections.flatMap((s) => s.rows).find((r) => r.title === title);
    eq([row('In window B').stripe, row('In window B').elsewhere, /Open in the VS Code window "proj-b \[SSH: host-b\]"/.test(row('In window B').hover),
      row('Named by the source').hover.includes('a VS Code window'), /Runs in terminal pts\/3\n {2}pid 77/.test(row('In a terminal').hover)],
    ['elsewhere', true, true, false, true],
    'another window\'s entry marks a row open elsewhere and names the window; the source\'s own guess at a VS Code window is dropped then; a terminal shows with its details');
    eq([await list.open('["codex","w"]'), t.opened.map((o) => o.sessionId), await list.open('["codex","z"]'), codex.calls.filter((c) => c[0] === 'open').length],
      ['sent', ['w'], 'elsewhere', 0], 'opening one open in another window brings that window forward; one open in a terminal is not opened here');
    t.host.open = async () => 'nowhere';
    eq([await list.open('["codex","w"]'), codex.calls.filter((c) => c[0] === 'open').length, t.control.state.said.some((x) => /which did not answer/.test(x.message))],
      ['elsewhere', 0, true], 'and when that window does not answer, it is not opened here as well, and the user is told');
    list.store().archive([['codex', 'w']], true);
    list.store().flush();
    await list.refresh();
    t.control.answer('Delete', 'Delete');
    await list.act('delete', ['["codex","w"]']);
    eq([codex.calls.filter((c) => c[0] === 'delete').length, t.control.state.said.some((s) => /open in the VS Code window/.test(s.message))], [0, true],
      'one open in another window is not deleted, and the user is told where it is open');
    list.dispose();
  }

  /* ── Actions ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'A', actions: ['goal.pause'] }), conv('b', { title: 'B' }), conv('c', { title: 'C', running: true, activity: 'working',
      elsewhere: [{ kind: 'terminal', label: 'terminal pts/1', running: true }] })], { own: [{ id: 'goal.pause', title: 'Pause Goal' }] });
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    const k = (x) => JSON.stringify(['codex', x]);
    const rec = (x) => { list.store().flush(); return list.store().record('codex', x); };
    await list.act('pin', [k('a')]); await list.act('color', [k('a')], 'purple');
    const made = await list.groupAct('newGroup');
    await list.act('addToGroup', [k('a'), k('b')], made.renameGroup);
    eq([rec('a').pinned, rec('a').color, rec('b').group === made.renameGroup], [true, 'purple', true], 'pin, a colour, and a new group with conversations added');
    await list.act('removeFromGroup', [k('b')]);
    await list.act('markUnread', [k('b')]);
    eq([rec('b').group, rec('b').unreadMark, codex.seen.pop()], [null, true, [['b'], false]], 'out of the group; marked unread, which the source is told');
    await list.act('markRead', [k('b')]);
    eq([rec('b').unreadMark, codex.seen.pop()], [false, [['b'], true]], 'marked read again');
    await list.act('archive', [k('a')]);
    eq([rec('a').archived, rec('a').pinned, rec('a').group], [true, false, null], 'archiving by hand unpins and takes it out of its group');
    await list.act('unarchive', [k('a')]);
    await list.rename(k('b'), '  New   name ');
    eq(codex.calls.pop(), ['rename', ['b'], { title: 'New name' }], 'a rename goes to the source, tidied');
    eq([await list.rename(k('c'), 'X'), t.control.state.said.some((s) => /would write its old title back/.test(s.message))], ['refused', true],
      'one running in another program is not renamed, and the user is told why');
    await list.refresh();
    const own = list.model().sections.flatMap((s) => s.rows).find((r) => r.title === 'A');
    eq([own.ctx['own_goal.pause'], list.model().menu.some((x) => x.name === 'own:goal.pause' && x.title === 'Pause Goal')], [true, true], 'a source\'s own action is in the menu, for the rows it names');
    await list.act('own:goal.pause', [k('a'), k('b')]);
    eq(codex.calls.pop(), ['goal.pause', ['a'], {}], 'and goes to the source for the rows it applies to');
    codex.made = 'new-one';
    await list.groupAct('newInGroup', made.renameGroup, 'codex');
    eq([codex.calls.pop(), rec('new-one').group === made.renameGroup], [['create', [], { where: 'tab' }], true], 'a new conversation for a group is put in it by the id the source answers');
    list.dispose();
  }

  /* ── Deleting by hand ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'Old' }), conv('b', { title: 'Live' }), conv('p', { title: 'Pinned' })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    list.store().archive([['codex', 'a'], ['codex', 'p']], true); list.store().pin([['codex', 'p']], true); list.store().flush();
    await list.refresh();
    let asked = null;
    const warnOf = t.vscode.window.showWarningMessage;
    t.vscode.window.showWarningMessage = (msg, ...rest) => {
      const o = rest.find((x) => x && typeof x === 'object');
      if (o && o.modal) asked = [msg, o.detail];
      return warnOf(msg, ...rest);
    };
    t.control.answer('Delete "', 'Delete');
    await list.act('delete', ['["codex","a"]', '["codex","b"]', '["codex","p"]']);
    eq([codex.calls.pop(), asked && asked[0], asked && /"Old" \(codex\): the file of a/.test(asked[1]), asked && /Left alone: "Live": only an archived conversation/.test(asked[1]),
      asked && /Left alone: "Pinned": it is pinned/.test(asked[1])],
    [['delete', ['a'], {}], 'Delete "Old" from disk?', true, true, true],
    'only archived, unpinned ones are deleted, after a confirmation that says what goes and what is left alone');
    list.dispose();
  }

  /* ── Archiving and deleting on their own ── */
  {
    const t = setup();
    const mk = () => source('codex', [conv('idle', { title: 'Idle', lastActiveAt: now0 - 20 * DAY, lastReplyAt: now0 - 20 * DAY, viewedAt: now0 - 20 * DAY }),
      conv('fresh', { title: 'Fresh' }), conv('gone', { title: 'Long archived', lastActiveAt: now0 - 200 * DAY, lastReplyAt: now0 - 200 * DAY })]);
    const codex = mk();
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    const st = list.store();
    st.archive([['codex', 'gone']], true, { since: now0 - 100 * DAY });
    st.swept();
    st.flush();
    await list.refresh();
    eq(codex.calls, [], 'the list does not sweep again within the hour of the last pass');
    clock = now0 + 2 * 3600e3;
    const first = await list.sweep();
    st.flush();
    eq([first.ran, st.record('codex', 'idle').archived, st.record('codex', 'fresh').archived, codex.calls.filter((c) => c[0] === 'delete')],
      [true, true, false, [['delete', ['gone'], {}]]], 'the hourly pass archives what was inactive long enough and deletes what was archived long enough');
    eq((await list.sweep()).why, 'done lately', 'and does not run again within the hour');
    await list.refresh({ relist: true });
    eq(Object.entries(list.deletionDue('codex')).filter(([, v]) => v !== null), [['idle', now0 + 2 * 3600e3 + 90 * DAY]],
      'when the list will delete each conversation, for a source that keeps them from its agent\'s own clean-up until then');

    /* A second window of the same project. */
    const t2 = setup({ folder: t.folder, shared: t.shared });
    clock = now0 + 2 * 3600e3;
    t2.entries.push({ id: 'codex', source: mk() });
    const list2 = L.createSessionList(t2.host, { now });
    await list2.refresh();
    clock += 2 * 3600e3;
    fs.mkdirSync(path.join(t.shared, 'session-list', `${list.project().key}.sweep`), { recursive: true });
    eq([list2.project().key === list.project().key, (await list2.sweep()).why], [true, 'another window is on it'],
      'another window of the project leaves the pass to the one doing it');
    list.dispose(); list2.dispose();
  }

  /* ── A source's note above the list, and a pass asked for at once ── */
  {
    const t = setup();
    const ran = [];
    t.vscode.commands.executeCommand = async (c, ...a) => { ran.push([c, ...a]); };
    const ev = new fake.EventEmitter();
    const oc = source('opencode', [], { features: ['sessions', 'sessionsNotice'] });
    let notice = { text: 'OpenCode was not found on this machine.', actions: [{ label: 'Download OpenCode', command: 'vscode.open', arguments: ['https://example.invalid/'] }, { label: '' }] };
    oc.sessionsNotice = () => notice;
    oc.onDidChangeSessionsNotice = ev.event;
    t.entries.push({ id: 'opencode', source: oc });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    eq(list.model().notices, [{ id: 'opencode', label: 'opencode', text: 'OpenCode was not found on this machine.', actions: [{ i: 0, label: 'Download OpenCode' }] }],
      'a source with sessionsNotice has its note drawn above the list, with its buttons');
    const acc = [];
    oc.features.push('accountInfo');
    oc.accountInfo = ({ sessionId }) => { acc.push(sessionId); return { rows: [{ label: 'Provider', value: 'Bedrock' }] }; };
    oc.sessions = [conv('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', { title: 'Mine' })];
    t.control.setTabs([{ label: 'Mine', input: { source: 'opencode', sid: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' } }], 0);
    await list.refresh({ relist: true });
    t.control.setTabs([{ label: 'x', input: {} }], 0);
    await list.refresh();
    eq([acc.slice(-1)[0], list.model().accounts.map((a) => a.info.rows[0].value)], ['ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', ['Bedrock']],
      'an agent\'s Account & usage part is asked about its conversation last in front, after another one comes to the front');
    list.noticeAction('opencode', 0);
    await wait(0);
    eq(ran, [['vscode.open', 'https://example.invalid/']], 'and a button runs the command the source gave');
    notice = null;
    await list.refresh();
    eq(list.model().notices, [], 'a source that has nothing to say has no note');
    list.dispose();

    const t2 = setup();
    const codex = source('codex', [conv('old', { title: 'Old', lastActiveAt: now0 - 30 * DAY, lastReplyAt: now0 - 30 * DAY, viewedAt: now0 - 30 * DAY })]);
    t2.entries.push({ id: 'codex', source: codex });
    const l2 = L.createSessionList(t2.host, { now });
    l2.store().swept(); l2.store().flush();
    await l2.refresh();
    t2.host.settings = () => ({ archiveAfterDays: 20 });
    eq([(await l2.sweep()).why, (await l2.sweep({ now: true })).ran, l2.store().record('codex', 'old').archived], ['done lately', true, true],
      'a pass asked for at once runs within the hour of the last one, as after the user changes when to archive');
    l2.dispose();
  }

  /* ── Restricted Mode ── */
  {
    const t = setup({ trusted: false });
    const codex = source('codex', [conv('a', { title: 'A' })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now });
    await list.refresh();
    await list.act('pin', ['["codex","a"]']);
    await list.rename('["codex","a"]', 'B');
    list.store().archive([['codex', 'a']], true);
    await list.act('delete', ['["codex","a"]']);
    list.store().flush();
    eq([list.model().restricted, list.store().record('codex', 'a').pinned, codex.calls.length, list.manages()], [true, false, 0, false],
      'in Restricted Mode the list is read only, sends no action, and does not archive or delete on its own');
    await list.open('["codex","a"]');
    eq(codex.calls, [['open', ['a'], { where: 'tab' }]], 'though it still opens a conversation, which only reads it');
    list.dispose();
  }

  /* ── What a source hands over, held to the protocol's limits ── */
  const s = L.sessionOf({ sessionId: 'x', title: 'T', kind: 'nope', parentId: 'x', elsewhere: Array.from({ length: 12 }, () => ({ kind: 'weird', label: 'L'.repeat(200), detail: ['d'.repeat(500)] })),
    badges: [{ text: 'goal' }, { text: '' }, { text: 'c' }, { text: 'd' }], processes: 3, hover: ['a', 5, '', 'b'], actions: ['x', 3] });
  eq([s.kind, s.parentId, s.elsewhere.length, s.elsewhere[0].kind, s.elsewhere[0].label.length, s.elsewhere[0].detail[0].length, s.badges.map((b) => b.text), s.processes, s.hover, s.actions, s.detail],
    ['user', '', 8, 'other', 80, 200, ['goal', 'c'], 3, ['a', 'b'], ['x'], true], 'a session is held to the protocol: kinds, places, lengths and counts');
  eq(L.capsOf({ sessionActions: () => ({ open: ['tab', 'window'], rename: 1, own: [{ id: 'g', title: 'Go' }, { id: '' }] }) }),
    { open: ['tab'], create: [], rename: false, delete: false, own: [{ id: 'g', title: 'Go' }] }, 'what a source says it can do, with nothing it did not say');
};
