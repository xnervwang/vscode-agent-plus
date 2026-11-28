// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's view and its place in the window (src/session-list-view.js, src/session-list-host.js).
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root, wait }) => {
  const fake = require(path.join(root, 'test', 'fake-vscode.js'));
  const V = require(path.join(root, 'src', 'session-list-view.js'));
  const H = require(path.join(root, 'src', 'session-list-host.js'));

  /* A stand-in for the webview view VS Code passes to the provider. */
  function viewOf(vscode) {
    const sent = [], ev = new fake.EventEmitter(), vis = new fake.EventEmitter();
    let hear = null;
    const view = { visible: true, badge: undefined, sent,
      webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => `webview:${u.path}`,
        postMessage: async (m) => { sent.push(m); return true; }, onDidReceiveMessage: (fn) => { hear = fn; return { dispose() {} }; } },
      onDidChangeVisibility: vis.event, onDidDispose: ev.event, show: () => { view.visible = true; vis.fire(); }, hide: () => { view.visible = false; vis.fire(); },
      say: (m) => hear(m) };
    return view;
  }

  /* ── The view, with a stand-in list that records its calls ── */
  {
    const { vscode } = fake.create();
    const dir = tmp('logos');
    const svg = path.join(dir, 'logo.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>');
    const asked = [];
    const changes = new fake.EventEmitter();
    let model = { sections: [], counts: { all: 3, open: 1, running: 1, needs: 2 }, sources: [{ id: 'codex', label: 'Codex', logo: { light: svg, dark: svg }, create: ['tab'] }] };
    const rec = (name) => (...a) => { asked.push([name, ...a]); return name === 'act' && a[0] === 'newGroupFrom' ? { renameGroup: 'g1' } : name === 'groupAct' && a[0] === 'newGroup' ? { renameGroup: 'g2' } : 'done'; };
    const list = { model: () => model, onDidChange: changes.event, schedule: () => asked.push(['schedule']) };
    for (const n of ['open', 'act', 'groupAct', 'rename', 'renameGroup', 'moveTo', 'create', 'chooseNew', 'wantDetail', 'accountLink', 'noticeAction', 'noteNoDelete']) list[n] = rec(n);
    const v = new V.SessionListView(vscode, { list, extensionUri: vscode.Uri.file('/ext') });
    const view = viewOf(vscode);
    v.resolveWebviewView(view);
    const html = view.webview.html;
    const nonce = (/script-src 'nonce-([0-9a-f]+)'/.exec(html) || [])[1];
    eq([!!nonce && html.includes(`<script nonce="${nonce}" src="webview:/ext/src/page/session-list-page.js">`), html.includes('href="webview:/ext/src/page/session-list-page.css"'),
      view.webview.options.enableScripts, view.webview.options.localResourceRoots.map((u) => u.path)], [true, true, true, ['/ext/src/page']],
    'the page loads its script, with a nonce, and its style from this extension\'s page folder, and nothing else');
    view.say({ kind: 'ready' });
    await wait(0);
    const first = view.sent.pop();
    const logo = first.model.logos.codex.dark;
    const decoded = Buffer.from(logo.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
    eq([first.type, /^data:image\/svg\+xml;base64,/.test(logo), /script/i.test(decoded), /<circle/.test(decoded), first.model.sources, view.badge],
      ['model', true, false, true, [{ id: 'codex', label: 'Codex', create: ['tab'], temporary: false, temporaryAt: [] }], { value: 2, tooltip: '2 conversations need you' }],
      'the page gets the model with each agent\'s logo as a script-free data: URI; the badge counts the conversations that need the user');
    changes.fire();
    eq(view.sent.length, 0, 'an unchanged model is not sent again');
    view.hide();
    model = Object.assign({}, model, { counts: { all: 3, needs: 1 } });
    changes.fire();
    eq([view.sent.length, view.badge.value], [0, 1], 'nothing is sent while the view is hidden, but its badge keeps up');
    view.show();
    await wait(0);
    eq([view.sent.length, asked.pop()], [1, ['schedule']], 'and once on screen again, it is sent and the list read again');

    const say = async (m) => { view.say(m); await wait(0); await wait(0); };
    view.sent.length = 0;
    asked.length = 0;
    await say({ kind: 'open', key: 'k1' });
    await say({ kind: 'act', name: 'pin', keys: ['k1', 5, 'k2'] });
    await say({ kind: 'act', name: 'newGroupFrom', keys: ['k1'] });
    await say({ kind: 'groupAct', name: 'newGroup', groupId: '' });
    await say({ kind: 'groupAct', name: 'deleteGroup', groupId: 'g1' });
    await say({ kind: 'rename', key: 'k1', title: 'New' });
    await say({ kind: 'renameGroup', groupId: 'g1', name: 'Named' });
    await say({ kind: 'move', keys: ['k1'], section: 'ungrouped' });
    await say({ kind: 'create', sourceId: 'codex', where: 'sidebar' });
    await say({ kind: 'newSource', sourceId: 'codex', where: 'tab' });
    await say({ kind: 'wantDetail', keys: ['k2'] });
    await say({ kind: 'accountLink', sourceId: 'codex', i: 1 });
    await say({ kind: 'noticeAction', sourceId: 'codex', i: 0 });
    await say({ kind: 'noDelete', rows: [{ key: 'k1', why: 'it is running' }] });
    await say({ kind: 'select', keys: ['k1'] });
    await say({ kind: 'nothing' });
    eq(asked, [['open', 'k1'], ['act', 'pin', ['k1', 'k2'], undefined], ['act', 'newGroupFrom', ['k1'], undefined], ['groupAct', 'newGroup', '', undefined],
      ['groupAct', 'deleteGroup', 'g1', undefined], ['rename', 'k1', 'New'], ['renameGroup', 'g1', 'Named'], ['moveTo', ['k1'], 'ungrouped'],
      ['create', 'codex', 'sidebar', '', { temporary: false }], ['chooseNew', 'codex', 'tab'], ['wantDetail', ['k2']], ['accountLink', 'codex', 1], ['noticeAction', 'codex', 0],
      ['noteNoDelete', [{ key: 'k1', why: 'it is running' }]]],
    'each message of the page goes to the list, with only strings among the keys');
    eq([view.sent, v.selection], [[{ type: 'startRenameGroup', groupId: 'g1' }, { type: 'startRenameGroup', groupId: 'g2' }], ['k1']],
      'a new group is put up for naming at once, and the selection is kept');
  }

  /* ── In the window ── */
  {
    const { vscode, control } = fake.create();
    const folder = tmp('ws');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(folder) }];
    const plans = new Map();
    const now = Date.now();
    const DAY = 86400e3;
    const entries = [];
    const registry = { entries, get: (id) => (entries.find((e) => e.id === id) || {}).source || null };
    const context = { workspaceState: fake.memento(), globalState: fake.memento(), extensionUri: vscode.Uri.file('/ext') };
    const s = H.startSessionList({ vscode, context, registry, say: () => {}, trusted: () => true, shared: (n) => path.join(tmp('shared'), n),
      planOf: (sourceId, id) => ({ plan: plans.get(id) || null }), openElsewhere: async () => 'nowhere' }, { tickMs: 3600e3 });
    eq(Object.keys(control.state.webviews), [H.VIEW_ID], 'it puts up the session list\'s view');
    Object.assign(control.state.config, { 'agentPlus.sessions.archiveAfterDays': -3, 'agentPlus.sessions.deleteAfterDays': 99999, 'agentPlus.sessions.recentlyClosed': 7.9,
      'agentPlus.sessions.deleteArchived': false });
    const ev = new fake.EventEmitter();
    const conv = (id, o) => Object.assign({ sessionId: id, title: id, cwd: folder, running: false, activity: 'stopped', lastActiveAt: now - DAY, lastReplyAt: now - DAY,
      lastUserAt: now - 2 * DAY }, o);
    const src = { protocol: 1, id: 'codex', label: 'Codex', features: ['sessions'], onDidChangeSessions: ev.event,
      listSessions: async () => ({ sessions: [conv('asks'), conv('answered', { lastUserAt: now - 1000 }), conv('old', { lastActiveAt: now - 30 * DAY, lastUserAt: now - 31 * DAY })], cursor: null }),
      sessionActions: { open: ['tab'], create: [], rename: false, delete: false, own: [] }, runSessionAction: async () => ({ results: [] }),
      sessionForTab: (t) => (t && t.input && t.input.conv) || null };
    for (const id of ['asks', 'answered', 'old']) plans.set(id, { nodes: [{ title: 'Pick one', state: 'waiting', waitingOn: 'user', question: 'Which?', since: now - 1.5 * DAY }] });
    entries.push({ id: 'codex', source: src });
    await s.list.refresh();
    const m = s.list.model();
    const rows = m.sections.find((x) => x.key === 'ungrouped').rows.map((r) => [r.id, r.dot]).sort();
    eq(rows, [['answered', ''], ['asks', 'red'], ['old', '']],
      'a plan question newer than the user\'s last message counts as asking the user; one answered since does not, nor one in a conversation inactive for weeks');
    const st = s.list.store();
    eq([s.list.deletionDue('codex').asks], [null], 'the settings are read: with agentPlus.sessions.deleteArchived off, no deletion is due');
    st.archive([['codex', 'asks']], true);
    st.flush();
    control.state.config['agentPlus.sessions.deleteArchived'] = true;
    await s.list.refresh();
    const due = s.list.deletionDue('codex').asks;
    eq(Math.round((due - Math.max(now - DAY, Date.now() - 5000)) / DAY), 3650, 'and held to their limits: at most 3650 days');

    control.setTabs([{ label: 'A', input: { conv: 'asks' } }]);
    control.fireTabs({ closed: [{ label: 'A', input: { conv: 'asks' } }] });
    const after1 = control.state.context[H.CLOSED_KEY];
    control.fireTabs({ closed: [control.fileTab('/x/notes.txt')] });
    eq([after1, control.state.context[H.CLOSED_KEY]], [true, false], 'closing a conversation\'s tab gives Ctrl+Shift+T to the list, closing any other tab gives it back');
    let qp = null;
    control.state.onQuickPick = (x) => { qp = x; };
    s.commands.findConversation();
    await wait(0);
    const first = qp.items.map((i) => i.label);
    qp.type('answ');
    const typed = qp.items.map((i) => [i.label, i.description, i.detail]);
    qp.accept(qp.items[0]);
    await wait(0);
    eq([first, typed, qp.hidden], [['answered', 'asks', 'old'].sort((a, b) => (a === 'old') - (b === 'old')), [['answered', 'Codex', 'answered']], true],
      'Find Conversation shows the conversations newest first, narrows them to titles or ids holding what is typed, and closes when one is picked');
    control.state.commands.length = 0;
    await s.commands.reopenClosedConversation();
    eq(control.state.commands.filter((c) => c[0] !== 'setContext'), [['workbench.action.reopenClosedEditor']],
      'with no closed conversation to reopen, Ctrl+Shift+T reopens the editor VS Code would have');
    s.dispose();
  }
};
