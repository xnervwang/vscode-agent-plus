// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The views in a running window with sources registered: the work plan follows the conversation in front, the
 * Conversations tree draws every source, a slow source is never asked twice at once, Restricted Mode writes nothing, and
 * a window with nothing using this extension builds no view at all. Adapted from "another extension's agent in these
 * views" and "list requests and focus timing in a running window" in vscode-claude-code-extras' test/check.js.
 */
const fs = require('fs');
const path = require('path');
const { boot, CODEX } = require('../boot');

const T = 'abababab-1111-4222-8333-444444444444';

function sources(vscode, dirs, logo) {
  const codexFocus = new vscode.EventEmitter(), codexChanged = new vscode.EventEmitter();
  const tabOf = (thread) => ({ label: 'Codex', input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
    path: '/local/' + thread }), 'chatgpt.conversationEditor') });
  const codexTab = tabOf(T), freshTab = { label: 'New', input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex',
    authority: 'route', path: '/' }), 'chatgpt.conversationEditor') };
  const claudeTab = { label: 'Claude', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
  const state = { focused: false, revealed: [] };
  const codex = {
    protocol: 1, features: [], id: 'codex', label: 'Codex', extensionId: 'xnervwang.codex-extras',
    logo: { light: { fsPath: logo }, dark: { fsPath: logo } },
    planPath: (id) => path.join(dirs.codex, id + '.json'), planDir: () => dirs.codex,
    sessionForTab: (tab) => (tab.input === codexTab.input ? T : tab.input === freshTab.input ? '' : null),
    onDidFocus: codexFocus.event, isFocused: () => state.focused,
    listConversations: async () => [{ sessionId: T, title: 'Codex task', cwd: dirs.ws, state: 'working', running: true, lastActiveAt: Date.now() }],
    onDidChangeConversations: codexChanged.event,
    reveal: async (id) => { state.revealed.push(id); return false; },
  };
  const claude = {
    protocol: 1, id: 'claude-code', label: 'Claude Code', planPath: (id) => path.join(dirs.claude, id + '.json'), planDir: () => dirs.claude,
    sessionForTab: (tab) => (tab.input === claudeTab.input ? T : null),
    listConversations: async () => [{ sessionId: T, title: 'Claude task', cwd: dirs.ws, state: 'idle', running: true }],
  };
  return { codex, claude, codexTab, freshTab, claudeTab, codexFocus, codexChanged, state };
}

module.exports = async ({ ok, bad, eq, tmp, root, wait }) => {
  const ws = tmp('ws'), codexDir = tmp('codex-plans'), claudeDir = tmp('claude-plans');
  fs.writeFileSync(path.join(codexDir, T + '.json'), JSON.stringify({ nodes: [{ title: 'codex row', state: 'waiting', waitingOn: 'user', question: 'Merge it?' }] }));
  fs.writeFileSync(path.join(claudeDir, T + '.json'), JSON.stringify({ nodes: [{ title: 'claude row', state: 'todo' }] }));
  const logo = path.join(tmp('logo'), 'blossom.svg');
  fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h4"/></svg>');
  const timing = { listWaitMs: 40, slowMs: 300, refreshMs: 1e9 };

  {
    const b = boot(root, tmp, { viewOptions: timing });
    const { vscode, control } = b;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
    const s = sources(vscode, { codex: codexDir, claude: claudeDir, ws }, logo);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    eq(pkg.contributes.commands.map((c) => c.command).filter((c) => !control.state.handlers[c]), [], 'every command in the manifest is registered');
    eq(Object.keys(control.state.views).sort(), ['agentWorkPlan.conversations', 'agentWorkPlan.workPlan'], 'the two trees are created');
    eq(Object.keys(control.state.webviews), ['agentWorkPlan.answer'], 'and the Answer view');
    const rc = b.api.registerSource(s.codex), rl = b.api.registerSource(s.claude);
    await wait(120);
    const conv = control.state.views['agentWorkPlan.conversations'].provider, plan = control.state.views['agentWorkPlan.workPlan'];
    const rows = () => conv.getChildren().filter((e) => e.kind === 'conversation').map((e) => conv.getTreeItem(e));
    const r = rows();
    const status = control.state.status.find((i) => i.id === 'agentWorkPlan.conversations');
    if (rc.accepted && rl.accepted && r.length === 2 && r[0].id === `conversations/codex/${T}` && r[0].iconPath.light
      && fs.existsSync(r[0].iconPath.light.fsPath) && r[1].iconPath.id === 'circle-outline' && /\nCodex\n/.test(r[0].tooltip)
      && status && status.shown && status.text.endsWith('1 to decide')) {
      ok('both sources\' conversations are drawn, the one with a logo carries it, and the status bar counts the question');
    } else bad(`rows ${JSON.stringify([r, status && status.text])}`);
    /* The base is the plan folder itself and the pattern has no '/' in it: a pattern with one makes VS Code watch the
       base recursively, and the base would then be a whole conversation store. */
    eq(control.state.watchers.map((w) => [w.pattern.base.fsPath, w.pattern.pattern]), [[codexDir, '*.json'], [claudeDir, '*.json']],
      'each source\'s plan folder is watched, without a path separator that would make the watch recursive');

    const shown = () => [plan.provider.shown() && plan.provider.shown().file, plan.description];
    const at = (tab) => { control.setTabs([tab]); control.fireTabs(); };
    at(s.codexTab); await wait(10);
    const afterCodex = shown();
    at(control.fileTab('/w/a.js')); await wait(10);
    const afterFile = shown();
    at(s.claudeTab); await wait(10);
    const afterClaude = shown();
    at(s.freshTab); await wait(10);
    const afterFresh = shown();
    eq([afterCodex, afterFile, afterClaude, afterFresh], [[path.join(codexDir, T + '.json'), 'Codex'], [path.join(codexDir, T + '.json'), 'Codex'],
      [path.join(claudeDir, T + '.json'), 'Claude Code'], [null, 'Codex']],
    'the work plan follows the claimed tab, keeps its place for a file, and shows nothing for a new conversation');
    s.state.focused = false;
    s.codexFocus.fire({ sessionId: T });
    await wait(20);
    const ignored = shown();
    s.state.focused = true;
    s.codexFocus.fire({ sessionId: T });
    await wait(20);
    eq([ignored, shown()], [[null, 'Codex'], [path.join(codexDir, T + '.json'), 'Codex']],
      'a focus report is taken only when the source still says that conversation is in front');

    await control.state.handlers['agentWorkPlan.openConversation']({ sourceId: 'codex', sessionId: T, title: 'Codex task', cwd: ws });
    eq([s.state.revealed, control.state.said.some((m) => /could not be brought to front/.test(m.message))], [[T], true],
      'a row\'s reveal() goes to its source, and a false answer is said');

    /* A slow source: its first list never arrives until released. */
    let calls = 0, release = null;
    const slowChanged = new vscode.EventEmitter();
    const slow = { protocol: 1, id: 'slow', label: 'Slow', onDidChangeConversations: slowChanged.event,
      listConversations: () => { calls++; return calls === 1 ? new Promise((done) => { release = done; }) : Promise.resolve([]); } };
    b.api.registerSource(slow);
    await wait(60);
    slowChanged.fire(); slowChanged.fire();
    await wait(60);
    const whileWaiting = calls;
    await wait(300);
    const problem = conv.problem;
    release([{ sessionId: 'z1', title: 'late', cwd: ws, state: 'idle' }]);
    await wait(120);
    const late = rows().map((x) => x.id);
    if (whileWaiting === 1 && /Slow: it has not listed its conversations for 0 seconds; still waiting/.test(problem) && calls === 2
      && late.includes('conversations/slow/z1') === false && rows().length >= 2) {
      ok('a source still answering is not asked again, is shown as still waiting, and is asked once more after it answers');
    } else bad(`slow source: ${JSON.stringify({ whileWaiting, problem, calls, late })}`);

    rc.registration.dispose();
    await wait(80);
    const after = rows().map((x) => x.id);
    eq([after.includes(`conversations/codex/${T}`), control.state.watchers[0].disposed], [false, true],
      'disposing a registration removes its rows and its watcher');
    b.close();
  }

  /*
   * Which conversation is in front: one tab object for a tab's whole life, a source registering when its own tab is
   * already in front, a source going away while it has the focus, and a focus report that lost to a later tab change.
   */
  {
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 1e9, refreshMs: 1e9, debounceMs: 10 } });
    const { vscode, control } = b;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
    const dir = tmp('one-plans');
    const S = 'cccccccc-1111-4222-8333-444444444444';
    const D2 = 'dddddddd-1111-4222-8333-444444444444';
    const file = path.join(dir, S + '.json');
    const plan = (title) => JSON.stringify({ nodes: [{ title, state: 'todo' }] });
    fs.writeFileSync(file, plan('first'));
    fs.writeFileSync(path.join(dir, D2 + '.json'), plan('other'));
    /* The extension host hands out one object per tab for its whole life and updates it in place, so a tab that has no
       conversation yet is the same object as the tab that has one a moment later. The stand-in does the same: the tab a
       source is shown is made when the tabs are set, and firing the event again shows it that same object. */
    const tab = { label: 'New', input: new vscode.TabInputWebview('one-panel') };
    const otherTab = { label: 'Other', input: new vscode.TabInputWebview('other-panel') };
    const view = control.state.views['agentWorkPlan.workPlan'];
    const titleNow = () => {
      const p = view.provider.shown();
      if (!p) return 'none';
      return p.error ? 'error' : p.nodes.length ? p.nodes[0].title : 'empty';
    };
    let answerForTab = '';
    const one = { protocol: 1, id: 'one', label: 'One', planPath: () => file, planDir: () => dir,
      sessionForTab: (t) => (t.input === tab.input ? answerForTab : null), listConversations: async () => [] };
    const rOne = b.api.registerSource(one);
    await wait(30);
    control.setTabs([tab]);
    control.fireTabs();
    await wait(30);
    const waitingForOne = [view.provider.shown(), view.description];
    answerForTab = S;
    control.fireTabs();
    await wait(30);
    eq([waitingForOne[0], waitingForOne[1], titleNow()], [null, 'One', 'first'],
      'a tab with no conversation yet shows nothing, and the same tab object is asked again once it has one');

    /* A source registering while a tab only it answers for is already in front. Nothing else will offer it that tab:
       the reader has not touched the tabs since, and another source already has the focus. */
    const four = { protocol: 1, id: 'four', label: 'Four', planPath: (id) => path.join(dir, id + '.json'), planDir: () => dir,
      sessionForTab: (t) => (t.input === otherTab.input ? D2 : null), listConversations: async () => [] };
    control.setTabs([otherTab]);
    control.fireTabs();
    await wait(30);
    const beforeFour = [view.description, titleNow()];
    b.api.registerSource(four);
    await wait(40);
    eq([beforeFour, view.description, titleNow()], [['One', 'first'], 'Four', 'other'],
      'a source registering while its own tab is already in front is offered it, even though another source has the focus');

    /* Two sources that both answer for one tab: the one registered first keeps it, and when it goes away the other
       takes it rather than the tab going back to the source on its way out. */
    const three = { protocol: 1, id: 'three', label: 'Three', planPath: () => file, planDir: () => dir,
      sessionForTab: (t) => (t.input === tab.input ? S : null), listConversations: async () => [] };
    b.api.registerSource(three);
    control.setTabs([tab]);
    control.fireTabs();
    await wait(40);
    const whileBoth = view.description;
    rOne.registration.dispose();
    await wait(40);
    eq([whileBoth, view.description], ['One', 'Three'],
      'the source registered first answers for a tab both know, and a source unregistering does not take the tab back');

    /* A focus report is acted on a moment after it was made, and by then the reader may have switched tabs. The tab is
       the later signal and wins. */
    const fourFocus = new vscode.EventEmitter();
    const five = { protocol: 1, id: 'five', label: 'Five', planPath: (id) => path.join(dir, id + '.json'), planDir: () => dir,
      sessionForTab: () => null, onDidFocus: fourFocus.event, isFocused: () => true, listConversations: async () => [] };
    b.api.registerSource(five);
    await wait(30);
    fourFocus.fire({ sessionId: D2 });
    control.setTabs([otherTab]);
    control.fireTabs();
    await wait(40);
    const tabWon = [view.description, titleNow()];
    /* With no tab change after it, the same report is taken. */
    fourFocus.fire({ sessionId: D2 });
    await wait(40);
    eq([tabWon, view.description], [['Four', 'other'], 'Five'],
      'a focus report queued before the reader switched tabs is dropped, and one with nothing after it is taken');

    /* Plans are read again only when their file has changed. */
    control.setTabs([tab]);
    control.fireTabs();
    await wait(40);
    const backOnThree = titleNow();
    const fire = (kind) => { for (const w of control.state.watchers) if (!w.disposed) w.fire(kind); };
    const reallyRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (p, ...rest) => { if (p === file) reads++; return reallyRead.call(fs, p, ...rest); };
    try {
      fire('change'); await wait(40);
      fire('change'); await wait(40);
      const unchanged = [reads, titleNow()];
      await control.state.handlers['agentWorkPlan.refreshWorkPlan']();
      await wait(40);
      const afterRefresh = [reads, titleNow()];
      fs.writeFileSync(file, plan('third'));
      fire('change'); await wait(40);
      const afterWrite = [reads, titleNow()];
      /* Half a file, as a reader lands on while another process is writing it. */
      fs.writeFileSync(file, '{"nodes": [');
      fire('change'); await wait(40);
      const halfWritten = titleNow();
      const longAgo = Date.now() / 1000 - 5;
      fs.utimesSync(file, longAgo, longAgo);
      fire('change'); await wait(40);
      eq([backOnThree, unchanged, afterRefresh, afterWrite, halfWritten, titleNow()],
        ['first', [0, 'first'], [1, 'first'], [2, 'third'], 'third', 'error'],
        'a plan file that has not changed is not read again, the refresh command reads it anyway, and one being written keeps the last plan that parsed until it is no longer fresh');
    } finally { fs.readFileSync = reallyRead; }
    b.close();
  }

  /* Restricted Mode. */
  {
    const b = boot(root, tmp, { trusted: false, viewOptions: timing });
    const { vscode, control } = b;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
    const s = sources(vscode, { codex: codexDir, claude: claudeDir, ws }, logo);
    b.api.registerSource(s.codex); b.api.registerSource(s.claude);
    await wait(120);
    const answer = control.state.webviews['agentWorkPlan.answer'];
    const conv = control.state.views['agentWorkPlan.conversations'].provider;
    const first = conv.getTreeItem(conv.getChildren().find((e) => e.kind === 'conversation'));
    eq([answer.restricted, fs.existsSync(path.join(b.home, 'answers')), fs.existsSync(path.join(b.storage, 'conversation-icons')), !!first.iconPath.light],
      [true, false, false, false], 'in Restricted Mode the Answer view is read only, and no answer folder or icon is written');
    control.grantTrust();
    await wait(20);
    eq([answer.restricted, fs.existsSync(path.join(b.home, 'answers'))], [false, true], 'trusting the workspace makes the answer folder');
    if (process.platform !== 'win32') eq((fs.statSync(path.join(b.home, 'answers')).mode & 0o777).toString(8), '700', 'readable by this user alone');
    b.close();
  }

  /* Nothing uses it. */
  {
    const b = boot(root, tmp, { extensions: [], viewOptions: timing });
    eq([Object.keys(b.control.state.views), Object.keys(b.control.state.webviews), b.control.state.status.length], [[], [], 0],
      'alone, no view and no status bar entry is created');
    b.control.state.extensions.push(CODEX());
    b.control.fireExtensions();
    eq([Object.keys(b.control.state.views).length, b.control.state.status.length], [2, 1], 'they are created when an extension that uses it is installed');
    b.close();
    /* A source registering in a window where nothing declared the dependency builds the views, and is attached once. */
    const c = boot(root, tmp, { extensions: [], viewOptions: timing });
    const r = c.api.registerSource({ protocol: 1, id: 'stray', planDir: () => codexDir, listConversations: async () => [] });
    await wait(20);
    eq([r.accepted, c.control.state.context['agentWorkPlan.alone'], c.control.state.watchers.length], [true, false, 1],
      'a source registering without a declared dependency brings the views back, with one watcher for its plans');
    c.close();
  }
};
