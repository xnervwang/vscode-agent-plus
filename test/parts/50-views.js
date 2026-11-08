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
    eq(control.state.watchers.map((w) => w.pattern.pattern), [path.basename(codexDir) + '/*.json', path.basename(claudeDir) + '/*.json'],
      'each source\'s plan folder is watched');

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
  }
};
