// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's host side (src/session-list.js), with three made-up sources standing in for Claude Code, Codex
 * and OpenCode.
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

  /* A made-up source. It records the actions it is asked for and what the list marks as seen. */
  function source(id, list, { features = ['sessions', 'sessionImport', 'sessionSeen', 'shows'], imported = { archived: [], groups: [], pinned: [], colors: {} },
    own = [], caps = null } = {}) {
    const ev = new fake.EventEmitter(), close = new fake.EventEmitter(), focus = new fake.EventEmitter();
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
      onDidFocus: focus.event, focus: (x) => focus.fire({ sessionId: x }), tabAnswer: {},
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
      sessionForTab: (tab) => (tab && tab.input && tab.input.source === id ? (tab.label in s.tabAnswer ? s.tabAnswer[tab.label] : tab.input.sid) : null),
      shows: (x) => s.sidebar.has(x),
      isFocused: (x) => s.focused === x,
      reveal: async (x) => { s.calls.push(['reveal', [x]]); return true; },
    };
    return s;
  }
  const conv = (id, o = {}) => Object.assign({ sessionId: id, title: id, cwd: '/w', running: false, activity: 'stopped', createdAt: now0 - 30 * DAY,
    lastActiveAt: now0 - DAY, lastReplyAt: now0 - DAY }, o);

  /* ── Reading the sources, and the import ── */
  {
    const t = setup();
    const many = Array.from({ length: 1200 }, (_, i) => conv(`c-${String(i).padStart(4, '0')}`));
    const claude = source('claude-code', many.slice(0, 3), { imported: () => null });
    const codex = source('codex', many, { imported: { archived: [{ sessionId: 'c-0001', at: now0 - 50 * DAY }, { sessionId: 'c-late', at: now0 - 40 * DAY }], groups: [{ name: 'Plugins', sessionIds: ['c-0002', 'c-0003', 'c-0001'] }],
      pinned: ['c-0003'], colors: { 'c-0004': 'green', 'c-9999': 'red' } } });
    t.entries.push({ id: 'claude-code', source: claude }, { id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await list.refresh();
    const st = list.store();
    st.flush();
    eq([codex.pages, list.rows().length], [[[0, 500], [500, 500], [1000, 500]], 1203], 'a source is read 500 a page until its cursor runs out');
    const rec = (s, i) => st.record(s, i);
    const g = st.groups();
    eq([g.map((x) => x.name), rec('codex', 'c-0002').group === g[0].id, rec('codex', 'c-0001').archived, rec('codex', 'c-0001').archivedAt,
      rec('codex', 'c-0001').group, rec('codex', 'c-0003').pinned, rec('codex', 'c-0004').color, st.imported('codex') > 0, st.imported('claude-code')],
    [['Plugins'], true, true, now0 - 50 * DAY, null, true, 'green', true, 0],
    'the import is done once and puts groups, pins, colours and archived conversations (with when, and out of their group) in the store; a source that answers null is asked again');
    await list.refresh({ relist: true });
    st.flush();
    eq([st.imported('claude-code'), st.groups().length], [0, 1], 'a source that still cannot read its list\'s state is not counted imported');
    codex.sessions.push(conv('c-late', { title: 'Read late' }));
    await list.refresh({ relist: true });
    eq([rec('codex', 'c-late').archived, list.model().sections.find((x) => x.key === 'archived').rows.some((r) => r.title === 'Read late')], [true, true],
      'a conversation the import names as archived before the source lists it is archived once it shows up');
    list.dispose();
  }

  /* ── Replies from before the record began count as seen ── */
  {
    const t = setup();
    const codex = source('codex', [conv('old', { title: 'Old reply', lastReplyAt: now0 - DAY }), conv('new', { title: 'New reply', lastReplyAt: now0 - DAY }),
      conv('far', { title: 'Far back', lastActiveAt: now0 - 30 * DAY, lastReplyAt: now0 - 30 * DAY, lastUserAt: now0 - 31 * DAY })]);
    t.entries.push({ id: 'codex', source: codex });
    const near = [];
    t.host.asksOf = (id, x, o) => { near.push([x.sessionId, !!(o && o.near)]); return false; };
    const list = L.createSessionList(t.host, { now });
    t.control.setTabs([{ label: 'Far back', input: { source: 'codex', sid: 'far' } }, { label: 'x', input: {} }], 1);
    await list.refresh();
    codex.sessions.find((x) => x.sessionId === 'new').lastReplyAt = now0 + 1000;
    clock = now0 + 2000;
    await list.refresh({ relist: true });
    const byT = (title) => list.model().sections.flatMap((x) => x.rows).find((r) => r.title === title);
    eq([byT('Old reply').unread, byT('New reply').unread, list.store().since()], [false, true, now0],
      'on a first look a reply from before the record began counts as seen, and one after it does not');
    eq(near.filter(([id]) => id === 'far').pop(), ['far', true], 'a conversation open in this window has its plan read however long ago it was active');
    clock = now0;
    list.dispose();
  }

  /* ── Which conversation is in front when a source says another is focused ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'Alpha' }), conv('q', { title: 'Other tab' })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    t.control.setTabs([{ label: 'Alpha', input: { source: 'codex', sid: 'a' } }, { label: 'Other tab', input: { source: 'codex', sid: 'q' } }], 0);
    codex.focused = 'q';
    await list.refresh();
    eq(list.model().front, '["codex","a"]', 'a source saying another of its conversations is focused does not move the front to one in another tab, since only the active tab can be in front');
    list.dispose();
  }

  /* ── Rows, the conversation in front, and what was closed here ── */
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
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    t.control.setTabs([{ label: 'Alpha', input: { source: 'codex', sid: 'a' } }, { label: 'x', input: {} }], 0);
    codex.sidebar.add('b');
    await list.refresh();
    let m = list.model();
    const flat = (mm) => Object.fromEntries(mm.sections.map((s) => [s.key, s.rows.map((r) => r.title)]));
    const byTitle = (mm, title) => mm.sections.flatMap((s) => s.rows).find((r) => r.title === title);
    eq([flat(m).ungrouped, m.counts, byTitle(m, 'Alpha').stripe, byTitle(m, 'Beta').stripe, byTitle(m, 'Dialog').dot, byTitle(m, 'Asks').dot, byTitle(m, 'Beta').dot],
      [['Alpha', 'Asks', 'Beta', 'Dialog', 'Other agent'], { all: 5, open: 2, running: 1, needs: 2 }, 'here', 'here', 'blue', 'red', 'green'],
      'rows of every source in one list, background and empty ones hidden, a tab or a sidebar here drawn as open here, with their dots and counts');
    eq(byTitle(m, 'Other agent').stripe, '', 'only a source that lists the shows feature is asked whether its sidebar shows a conversation');
    const placeLine = (mm, title) => byTitle(mm, title).hover.split('\n').filter((l) => l.startsWith('Open in this window'));
    eq([placeLine(m, 'Alpha'), placeLine(m, 'Beta')], [['Open in this window'], ['Open in this window']],
      'the hover says a conversation is open in this window, and names no place for one found by shows() alone: a tab behind another can be one');
    const flags = (t) => { const r = byTitle(m, t); return [r.runs, r.needs]; };
    eq([flags('Beta'), flags('Dialog'), flags('Asks'), flags('Alpha')], [[true, false], [false, true], [false, true], [false, false]],
      'each row says whether it runs and whether it needs the user, which the page\'s chips filter by');
    eq([m.front, codex.seen, byTitle(m, 'Alpha').unread], ['["codex","a"]', [], true], 'the conversation just brought to the front is not seen yet');
    clock = now0 + 2000;
    await list.refresh();
    m = list.model();
    eq([codex.seen, list.store().record('codex', 'a').seenAt, byTitle(m, 'Alpha').unread], [[[['a'], true]], now0 - 60e3, false],
      'once it has stayed in front a moment it is seen, and its source is told');
    const tabsNow = [{ label: 'Alpha', input: { source: 'codex', sid: 'a' } }, { label: 'x', input: {} }];
    t.control.setTabs(tabsNow, 1);
    codex.sessions.find((x) => x.sessionId === 'a').lastReplyAt = now0 + 1000;
    await list.refresh({ relist: true });
    clock = now0 + 3000;
    t.control.setTabs(tabsNow, 0);
    await list.refresh();
    clock = now0 + 3500;
    t.control.setTabs(tabsNow, 1);
    await list.refresh();
    clock = now0 + 8000;
    await list.refresh();
    eq([byTitle(list.model(), 'Alpha').unread, codex.seen.length], [true, 1], 'one brought to the front for a moment and left is still unread');
    t.control.setTabs(tabsNow, 0);
    await list.refresh();
    clock = now0 + 10000;
    await list.refresh();
    eq([byTitle(list.model(), 'Alpha').unread, codex.seen.length], [false, 2], 'and is seen once it stays');
    codex.focused = 'b';
    await list.refresh();
    eq(list.model().front, '["codex","b"]', 'with a tab of a source in front, the conversation that source says is focused (its sidebar shown after the tab) is the one in front');
    codex.focused = '';
    await list.refresh();
    eq(list.model().front, '["codex","a"]', 'and the tab\'s conversation is in front again once the source stops saying so');
    await list.act('markUnread', ['["codex","a"]']);
    clock = now0 + 20000;
    await list.refresh();
    clock = now0 + 30000;
    await list.refresh();
    eq(byTitle(list.model(), 'Alpha').unread, true, 'a conversation marked unread while in front stays unread until it leaves the front');
    t.control.setTabs(tabsNow, 1);
    await list.refresh();
    t.control.setTabs(tabsNow, 0);
    await list.refresh();
    clock = now0 + 40000;
    await list.refresh();
    eq(byTitle(list.model(), 'Alpha').unread, false, 'and is seen only after another conversation has had the front and it has stayed there again');
    codex.sessions.find((x) => x.sessionId === 'a').unseen = true;
    await list.refresh({ relist: true });
    clock = now0 + 50000;
    await list.refresh();
    eq(byTitle(list.model(), 'Alpha').unread, true, 'one its source says is unseen stays unread in front, for the source to clear');
    delete codex.sessions.find((x) => x.sessionId === 'a').unseen;
    await list.refresh({ relist: true });
    codex.sessions.find((x) => x.sessionId === 'd').unseen = true;
    await list.refresh({ relist: true });
    eq(byTitle(list.model(), 'Dialog').unread, true, 'a row its source says is unseen in the agent\'s own interface has the envelope');
    clock = now0;
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
    eq(oc.calls.pop(), ['open', ['ses_aaaaaaaaaaaaaaaaaaaaaaaaaa'], { where: 'sidebar' }], 'a source that reports a closing says where it was shown, and the list reopens it there');
    list.dispose();
  }

  /* ── A tab whose conversation the source learns late ── */
  {
    const t = setup();
    const codex = source('codex', [conv('late', { title: 'Learned late' })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    codex.tabAnswer['Learned late'] = '';
    t.control.setTabs([{ label: 'Learned late', input: { source: 'codex', sid: 'late' } }], 0);
    await list.refresh();
    /* The first look writes the store, and the store's change brings a second look a moment later; this
       waits for it. */
    await new Promise((r) => setTimeout(r, 1000));
    const stripe = () => list.model().sections.flatMap((x) => x.rows).find((r) => r.title === 'Learned late').stripe;
    const before = stripe();
    delete codex.tabAnswer['Learned late'];
    await new Promise((r) => setTimeout(r, 500));
    const unasked = stripe();
    codex.focus('late');
    await new Promise((r) => setTimeout(r, 500));
    eq([before, unasked, stripe()], ['', '', 'here'],
      'a tab its source answers with no conversation yet is not open here; once the source knows it and says so with onDidFocus, the list looks at the tabs again and the row is open here');
    list.dispose();
  }

  /* ── Delete... left out of an archived row's menu, said on the output channel ── */
  {
    const t = setup();
    const said = [];
    t.host.say = (l) => said.push(l);
    const codex = source('codex', [conv('busy', { title: 'Still running', activity: 'working', running: true }), conv('idle', { title: 'Idle' })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    t.control.setTabs([{ label: 'x', input: {} }], 0);
    await list.refresh();
    const key = (id) => JSON.stringify(['codex', id]);
    await list.act('archive', [key('busy'), key('idle')]);
    await list.refresh();
    const row = (id) => list.model().sections.flatMap((x) => x.rows).find((r) => r.id === id);
    const before = said.length;
    list.noteNoDelete([{ key: key('busy'), why: row('busy').deleteWhy }, { key: key('idle'), why: '' }, { key: 'nothing' }, 'x']);
    const lines = said.slice(before);
    eq([row('busy').deletable, row('idle').deletable, lines.length], [false, true, 2], 'only the rows the list holds are said');
    eq(/^session list: Delete\.\.\. left out of the menu of codex busy: it is running; here false, open elsewhere 0, activity working, running true, pinned false, detail true$/.test(lines[0]),
      true, 'a left-out Delete... is said with the reason the page was given and what the list holds for the row', lines[0]);
    eq(/: nothing the list holds now; .*activity stopped/.test(lines[1]), true,
      'and one the page left out with no reason, which the list would now allow, says so', lines[1]);
    list.dispose();
  }

  /* ── The place of a conversation only shows() finds ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'In the sidebar' }), conv('b', { title: 'Behind a tab' }), conv('c', { title: 'Not said' })],
      { features: ['sessions', 'sessionImport', 'sessionSeen', 'shows', 'shownIn'], caps: { open: ['sidebar', 'tab'], create: ['tab'], rename: true, delete: true, own: [] } });
    const place = { a: 'sidebar', b: 'tab', c: 'somewhere' };
    codex.shownIn = (x) => place[x];
    for (const x of ['a', 'b', 'c']) codex.sidebar.add(x);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    t.control.setTabs([{ label: 'x', input: {} }], 0);
    await list.refresh();
    const byTitle = (mm, title) => mm.sections.flatMap((s) => s.rows).find((r) => r.title === title);
    const placeLine = (title) => byTitle(list.model(), title).hover.split('\n').filter((l) => l.startsWith('Open in this window'));
    eq([placeLine('In the sidebar'), placeLine('Behind a tab'), placeLine('Not said')],
      [['Open in this window, in the sidebar'], ['Open in this window'], ['Open in this window']],
      'with shownIn listed, the hover adds in the sidebar only when shownIn answers sidebar');
    const reopened = [];
    for (const x of ['a', 'b', 'c']) {
      codex.sidebar.delete(x);
      clock += 1000;
      await list.refresh();
      await list.reopenLast();
      reopened.push(codex.calls.pop()[2].where);
    }
    eq(reopened, ['sidebar', 'tab', 'sidebar'], 'once closed, each reopens where shownIn said it was, and one with no place where its source opens first');
    list.dispose();
  }

  /* ── A conversation in a linked git worktree, and one open in more than one process ── */
  {
    const t = setup();
    t.entries.push({ id: 'codex', source: source('codex', [conv('wt', { title: 'In a worktree', worktree: 'feature-x' }),
      conv('two', { title: 'In two processes', processes: 2 }), conv('one', { title: 'In one process', processes: 1 })]) });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await list.refresh();
    const m = list.model();
    const row = (title) => m.sections.flatMap((s) => s.rows).find((r) => r.title === title);
    eq([row('In a worktree').worktree, row('In a worktree').processes, row('In two processes').processes, /Open in 2 processes at once/.test(row('In two processes').hover),
      row('In one process').processes, /processes at once/.test(row('In one process').hover)],
    ['feature-x', 0, 2, true, 0, false],
    'a row carries the name of the worktree its conversation is in, and how many processes have it open when more than one; its hover says so too');
    list.dispose();
  }

  /* ── Another VS Code window and a terminal ── */
  {
    const t = setup();
    const codex = source('codex', [conv('w', { title: 'In window B' }), conv('z', { title: 'In a terminal', elsewhere: [{ kind: 'terminal', label: 'terminal pts/3', detail: ['pid 77'], running: true }],
      activity: 'working', running: true }), conv('v', { title: 'Named by the source', elsewhere: [{ kind: 'vscode', label: 'a VS Code window' }] })]);
    codex.planDirPath = tmp('codex-plans');
    fs.mkdirSync(path.join(codex.planDirPath, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(codex.planDirPath, 'windows', `${process.ppid}.json`), JSON.stringify({ at: clock, pid: process.ppid, name: 'proj-b [SSH: host-b]', sessions: ['w', 'v'] }));
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await list.refresh();
    const m = list.model();
    const row = (title) => m.sections.flatMap((s) => s.rows).find((r) => r.title === title);
    eq([row('In window B').stripe, row('In window B').elsewhere, /Open in the VS Code window "proj-b \[SSH: host-b\]"/.test(row('In window B').hover),
      row('Named by the source').hover.includes('a VS Code window'), /Runs in terminal pts\/3\n {2}pid 77/.test(row('In a terminal').hover)],
    ['elsewhere', true, true, false, true],
    'another window\'s entry marks a row open elsewhere and names that window, replacing the source\'s own guess at a VS Code window; a terminal is shown with its details');
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
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await list.refresh();
    const k = (x) => JSON.stringify(['codex', x]);
    const rec = (x) => { list.store().flush(); return list.store().record('codex', x); };
    await list.act('pin', [k('a')]); await list.act('color', [k('a')], 'purple');
    const made = await list.groupAct('newGroup');
    await list.act('addToGroup', [k('a'), k('b')], made.renameGroup);
    eq([rec('a').pinned, rec('a').color, rec('b').group === made.renameGroup], [true, 'purple', true], 'pin, a colour, and a new group with conversations added');
    await list.act('color', [k('b')], 'pink');
    await list.refresh();
    const drawn = list.model();
    eq([drawn.sections.flatMap((x) => x.rows).find((r) => r.id === 'b').color, drawn.colors.find((c) => c.name === 'cyan').color],
      ['terminal.ansiBrightMagenta', 'terminal.ansiCyan'], 'pink and cyan are drawn in theme colours VS Code has');
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
    eq([codex.calls.pop(), rec('new-one').group === made.renameGroup], [['create', [], { where: 'tab' }], true], 'a new conversation started for a group goes into it, found by the id the source returns');
    list.dispose();
  }

  /* ── Deleting by hand ── */
  {
    const t = setup();
    const codex = source('codex', [conv('a', { title: 'Old' }), conv('b', { title: 'Live' }), conv('p', { title: 'Pinned' })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
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

  /* ── Automatic archiving and deleting ── */
  {
    const t = setup();
    const mk = () => source('codex', [conv('idle', { title: 'Idle', lastActiveAt: now0 - 20 * DAY, lastReplyAt: now0 - 20 * DAY, viewedAt: now0 - 20 * DAY }),
      conv('fresh', { title: 'Fresh' }), conv('gone', { title: 'Long archived', lastActiveAt: now0 - 200 * DAY, lastReplyAt: now0 - 200 * DAY })]);
    const codex = mk();
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
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
    const list2 = L.createSessionList(t2.host, { now, since: now0 - 300 * DAY });
    await list2.refresh();
    clock += 2 * 3600e3;
    fs.mkdirSync(path.join(t.shared, 'session-list', `${list.project().key}.sweep`), { recursive: true });
    eq([list2.project().key === list.project().key, (await list2.sweep()).why], [true, 'another window is on it'],
      'another window of the project leaves the pass to the one doing it');
    list.dispose(); list2.dispose();
  }

  /* ── A source's note above the list, and an immediate pass ── */
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
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
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
    const syncAccount = oc.accountInfo, syncNotice = oc.sessionsNotice;
    oc.accountInfo = async () => ({ rows: [{ label: 'Provider', value: 'Bedrock' }] });
    oc.sessionsNotice = () => Promise.reject(new Error('later'));
    await list.refresh();
    eq([list.model().accounts, list.model().notices], [[], []], 'a source whose accountInfo or sessionsNotice returns a Promise gets no part and no note');
    oc.accountInfo = syncAccount; oc.sessionsNotice = syncNotice;
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
    const l2 = L.createSessionList(t2.host, { now, since: now0 - 300 * DAY });
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
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
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

  /* ── The order of rows that run ── */
  {
    const t = setup();
    const codex = source('codex', [conv('q', { title: 'Quiet', lastActiveAt: now0 - 300e3 }),
      conv('r', { title: 'Runs', lastActiveAt: now0 - 600e3, activity: 'working', running: true }), conv('b', { title: 'Background', lastActiveAt: now0 - 900e3 })]);
    t.entries.push({ id: 'codex', source: codex });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await list.refresh();
    const order = () => list.model().sections.find((x) => x.key === 'ungrouped').rows.map((r) => r.title);
    const set = (id, o) => Object.assign(codex.sessions.find((x) => x.sessionId === id), o);
    eq(order(), ['Quiet', 'Runs', 'Background'], 'a row that already runs when the list first sees it sorts by its last message then');
    set('r', { lastActiveAt: now0 - 10e3 });
    set('b', { activity: 'background', running: true });
    await list.refresh({ relist: true });
    set('b', { lastActiveAt: now0 - 240e3 });
    await list.refresh({ relist: true });
    eq(order(), ['Quiet', 'Runs', 'Background'], 'while a turn or background work runs, its newer messages do not move the row');
    set('r', { activity: 'stopped', running: false });
    await list.refresh({ relist: true });
    eq(order(), ['Runs', 'Quiet', 'Background'], 'once its turn stops, the row moves to the place of its last message, and one still running stays put');
    set('q', { activity: 'working', running: true, lastActiveAt: now0 - 1e3 });
    await list.refresh({ relist: true });
    eq(order(), ['Quiet', 'Runs', 'Background'], 'a row that starts running is placed by the message it started with');
    eq(list.model().sections.find((x) => x.key === 'ungrouped').rows.find((r) => r.title === 'Background').time, '4m',
      'and the time on a row is still that of its last message');
    list.dispose();
  }

  /* ── The agent a new conversation starts in ── */
  {
    const firstOf = async (ids, noCreate = []) => {
      const t = setup();
      for (const id of ids) {
        t.entries.push({ id, source: source(id, [conv(`${id}-1`)], noCreate.includes(id) ? { caps: { open: ['tab'], create: [], rename: false, delete: false, own: [] } } : {}) });
      }
      const l = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
      await l.refresh();
      const got = l.model().newSource;
      l.dispose();
      return got;
    };
    eq([await firstOf(['other', 'opencode-plus', 'codex', 'claude-code']), await firstOf(['other', 'opencode-plus', 'codex']), await firstOf(['other', 'opencode-plus']),
      await firstOf(['zeta', 'other']), await firstOf(['codex', 'claude-code'], ['claude-code'])],
    ['claude-code', 'codex', 'opencode-plus', 'zeta', 'codex'],
    'a new conversation starts in Claude Code, else Codex, else OpenCode, else the first other agent registered; an agent that cannot start conversations is passed over');

    const t = setup();
    const claude = source('claude-code', [conv('c-1')]), codex = source('codex', [conv('x-1')]);
    t.entries.push({ id: 'codex', source: codex }, { id: 'claude-code', source: claude });
    await t.host.globalMemento.update(L.LAST_NEW_KEY, { sourceId: 'codex', where: 'sidebar' });
    const list = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await list.refresh();
    eq([list.model().newSource, list.model().newWhere], ['claude-code', 'sidebar'],
      'whichever agent was used last, the New bar starts with Claude Code, in the half picked last');
    list.chooseNew('codex', 'tab');
    await list.refresh();
    eq([list.model().newSource, list.model().newWhere, t.host.globalMemento.get(L.LAST_NEW_KEY)], ['codex', 'tab', { where: 'tab' }],
      'an agent picked in the New bar\'s menu is the one for the next new conversation; only the half is kept');
    const made = await list.groupAct('newGroup');
    await list.groupAct('newInGroup', made.renameGroup);
    eq([codex.calls.filter((c) => c[0] === 'create').length, claude.calls.filter((c) => c[0] === 'create').length], [1, 0],
      'New Conversation in This Group with no agent named starts one in the agent picked');
    await list.refresh();
    eq(list.model().newSource, 'claude-code', 'once that conversation has started, the New bar starts with Claude Code again');
    await list.create('claude-code', 'sidebar');
    eq(t.host.globalMemento.get(L.LAST_NEW_KEY), { where: 'tab' }, 'starting a conversation keeps the half it started in, and not its agent');
    const next = L.createSessionList(t.host, { now, since: now0 - 300 * DAY });
    await next.refresh();
    eq(next.model().newSource, 'claude-code', 'and the next window starts with Claude Code again');
    next.dispose();
    list.dispose();
  }

  /* ── A source's sessions and actions, cut to the protocol's limits ── */
  const s = L.sessionOf({ sessionId: 'x', title: 'T', kind: 'nope', parentId: 'x', elsewhere: Array.from({ length: 12 }, () => ({ kind: 'weird', label: 'L'.repeat(200), detail: ['d'.repeat(500)] })),
    badges: [{ text: 'goal' }, { text: '' }, { text: 'c' }, { text: 'd' }], processes: 3, hover: ['a', 5, '', 'b'], actions: ['x', 3] });
  eq([s.kind, s.parentId, s.elsewhere.length, s.elsewhere[0].kind, s.elsewhere[0].label.length, s.elsewhere[0].detail[0].length, s.badges.map((b) => b.text), s.processes, s.hover, s.actions, s.detail],
    ['user', '', 8, 'other', 80, 200, ['goal', 'c'], 3, ['a', 'b'], ['x'], true], 'a session is held to the protocol: kinds, places, lengths and counts');
  eq(L.capsOf({ sessionActions: () => ({ open: ['tab', 'window'], rename: 1, own: [{ id: 'g', title: 'Go' }, { id: '' }] }) }),
    { open: ['tab'], create: [], rename: false, delete: false, own: [{ id: 'g', title: 'Go' }] }, 'sessionActions is taken as given, with no actions added');
};
