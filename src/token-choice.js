// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The parts of the token mode that only Agent Plus has; src/token-mode.js is the part every extension shares.
 *
 * An earlier install is told from a first one by whether globalState holds anything at start: every earlier version
 * wrote agentPlus.hadDependents once an extension using it was installed, and agentPlus.oldSettingsAdopted in its first
 * trusted window. So create() must run before src/host.js first looks for dependents, which writes the first of those.
 */
const tokenMode = require('./token-mode');
const { claimAsk } = require('./request-limit');
const { KNOWN } = require('./dependents');

/* 'new' from a first install until the notice is shown, then 'asked'; 'migrated' once an earlier install's settings
   have been looked at. */
const START_KEY = 'agentPlus.tokenModeStart';
/* What an earlier version can have written, looked for one by one when the memento cannot list its keys. */
const EARLIER_KEYS = ['agentPlus.hadDependents', 'agentPlus.oldSettingsAdopted', 'agentPlus.toldAlone', 'agentPlus.timeZone',
  'agentPlus.webviewLimitAsked', 'agentPlus.updateOffered'];
const COMMAND = 'agentPlus.chooseTokenMode';
const README_TOKENS = 'https://github.com/xnervwang/vscode-agent-plus#what-it-costs-in-tokens';
const MORE = 'Learn More';
const ASK_TEXT = 'Some features add text to the agent\'s context and use tokens. Choose which Claude Code Plus and Codex Plus features run. '
  + 'You can change this later from the token mode entry in the status bar.';
/* Beside the Conversations entry, which has 100. */
const PRIORITY = 99;

const nameOf = (id) => (KNOWN.find((k) => k.id === id) || {}).name || id;

/* The four items of the status bar's list. The tick for the mode in effect goes in the description: an icon before the
   name would push the name to the right of the line under it. */
function pickItems(now) {
  return tokenMode.MODES.map((m) => ({ label: m.label, description: [m.note, m.id === now ? '$(check) current' : ''].filter(Boolean).join(' · '),
    detail: m.detail, mode: m.id }));
}

/* The Settings editor's search for the feature settings of the extensions in `installed` (ids), or of both. */
function settingsQuery(installed = []) {
  const keys = tokenMode.SWITCHES.filter((s) => !installed.length || installed.includes(s.extension)).map((s) => s.key);
  return `@id:${keys.join(',')}`;
}

/*
 * What runs in `mode`, as [on, off] lists of feature names, for the extensions in `installed` (ids), or for both when
 * that is empty. In Custom, a feature that is on in one extension and off in the other is in both lists, with the names.
 */
function features(mode, value, installed = []) {
  const switches = tokenMode.SWITCHES.filter((s) => !installed.length || installed.includes(s.extension));
  const on = [], off = [];
  for (const f of tokenMode.FEATURES) {
    const mine = switches.filter((s) => s.feature === f.id);
    if (!mine.length) continue;
    const by = tokenMode.onIn(mode, f.id);
    const yes = mine.filter((s) => (by === null ? value(s) : by));
    const no = mine.filter((s) => !yes.includes(s));
    const named = (list) => `${f.name} (${list.map((s) => nameOf(s.extension)).join(', ')})`;
    if (!no.length) on.push(f.name);
    else if (!yes.length) off.push(f.name);
    else { on.push(named(yes)); off.push(named(no)); }
  }
  return [on, off];
}

/* The status bar entry's hover. */
function tipLines(mode, on, off) {
  return [
    `Token mode: ${tokenMode.labelOf(mode)}`,
    `Adds to the agent's context: ${on.length ? on.join(', ') : 'nothing'}`,
    ...(off.length ? [`Left out: ${off.join(', ')}`] : []),
    'What the extensions show in VS Code costs no tokens.',
    'Click to choose another mode.',
  ];
}

/* `host` is what src/host.js passes: vscode, context, say, trusted() and dependents(). `opts.home` is the shared folder
   where one of several windows starting together claims the notice. */
function create(host, opts = {}) {
  const { vscode, context, say } = host;
  const memento = context.globalState;
  const cfg = () => vscode.workspace.getConfiguration(tokenMode.SECTION);
  const inspect = (key) => {
    const i = key.indexOf('.');
    try { return vscode.workspace.getConfiguration(key.slice(0, i)).inspect(key.slice(i + 1)) || {}; } catch (_) { return {}; }
  };
  const subs = [];
  let closed = false;

  /* ── First install or earlier one ── */
  let start = memento ? memento.get(START_KEY) : 'asked';
  if (!start) {
    const kept = typeof memento.keys === 'function' ? memento.keys() : EARLIER_KEYS.filter((k) => memento.get(k) !== undefined);
    start = kept.some((k) => k !== START_KEY) ? 'earlier' : 'new';
    if (start === 'new') Promise.resolve(memento.update(START_KEY, 'new')).catch(() => {});
    say(start === 'new' ? 'token mode: a first install, so a mode is asked for once'
      : 'token mode: installed before, so the earlier settings are looked at once and nothing is asked');
  }

  /*
   * An earlier install's feature settings were the only way to turn a feature off, and All features, the default,
   * would override them. If any of them is set away from its default, the mode becomes Custom, unless a mode was
   * already chosen. Only user settings count: every one of these is an application setting, which VS Code reads from
   * there alone.
   */
  let migrating = null;
  const installed = () => (typeof host.dependents === 'function' ? host.dependents().map((d) => d.id) : []);
  /* Custom chosen by hand opens the Settings editor on the settings it hands each feature to. */
  const openSwitches = () => Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', settingsQuery(installed())))
    .catch((e) => say(`token mode: opening the settings: ${(e && e.message) || e}`));
  const migrate = () => {
    if (migrating || start !== 'earlier' || closed || !host.trusted()) return migrating;
    migrating = (async () => {
      const set = tokenMode.SWITCHES.filter((s) => { const v = inspect(s.key).globalValue; return v !== undefined && v !== s.default; });
      if (set.length && inspect(tokenMode.SETTING).globalValue === undefined) {
        await cfg().update(tokenMode.NAME, tokenMode.CUSTOM, vscode.ConfigurationTarget.Global);
        say(`token mode: set to Custom, since ${set.map((s) => s.key).join(', ')} ${set.length === 1 ? 'was' : 'were'} changed before`);
      }
      await memento.update(START_KEY, 'migrated');
      start = 'migrated';
    })().catch((e) => { say(`token mode: looking at the earlier settings: ${(e && e.message) || e}`); migrating = null; });
    return migrating;
  };
  migrate();
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') subs.push(vscode.workspace.onDidGrantWorkspaceTrust(() => migrate()));

  /* The first-install notice, shown once. When several windows start together, only the one that creates this client's
     marker file in the shared folder asks. */
  const ask = async () => {
    if (closed || start !== 'new' || !memento || memento.get(START_KEY) !== 'new' || !host.trusted()) return '';
    if (typeof host.dependents !== 'function' || !host.dependents().length) return '';
    const mine = claimAsk(`token-mode:${(vscode.env && vscode.env.machineId) || ''}`, opts.home);
    start = 'asked';
    await memento.update(START_KEY, 'asked');
    if (!mine) { say('token mode: another window of this client is asking for the mode'); return ''; }
    const pick = await vscode.window.showInformationMessage(ASK_TEXT, ...tokenMode.MODES.map((m) => m.label), MORE);
    const chosen = tokenMode.MODES.find((m) => m.label === pick);
    if (chosen) await cfg().update(tokenMode.NAME, chosen.id, vscode.ConfigurationTarget.Global);
    if (chosen && chosen.id === tokenMode.CUSTOM) await openSwitches();
    else if (pick === MORE) await vscode.env.openExternal(vscode.Uri.parse(README_TOKENS));
    say(`token mode: the first-install notice was ${chosen ? `answered with ${chosen.label}` : pick === MORE ? 'answered with Learn More' : 'closed'}`);
    return chosen ? chosen.id : pick || '';
  };

  /* ── The status bar entry ── */
  const value = (s) => tokenMode.effective(vscode, s.key);
  const describe = () => {
    const mode = tokenMode.modeNow(vscode);
    const [on, off] = features(mode, value, installed());
    return { mode, on, off };
  };
  const item = vscode.window.createStatusBarItem('agentPlus.tokenMode', vscode.StatusBarAlignment.Right, PRIORITY);
  item.name = 'Agent Plus Token Mode';
  item.command = COMMAND;
  let shown = false;
  const paint = () => {
    if (closed) return;
    if (!shown) { item.hide(); return; }
    const { mode, on, off } = describe();
    item.text = `$(dashboard) ${(tokenMode.modeById(mode) || {}).short}`;
    item.tooltip = tipLines(mode, on, off).join('\n');
    item.show();
  };
  const watched = [tokenMode.SETTING, ...tokenMode.SWITCHES.map((s) => s.key)];
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => { if (watched.some((k) => e.affectsConfiguration(k))) paint(); }));

  /* The list behind the entry. Resolves to the mode chosen, or '' when the list was closed or the same one picked.
     Picking Custom, even when it is the mode already, opens the feature settings. */
  const choose = async () => {
    const now = tokenMode.modeNow(vscode);
    const items = pickItems(now);
    const qp = vscode.window.createQuickPick();
    qp.title = 'Token mode';
    qp.placeholder = 'What Claude Code Plus and Codex Plus may add to the agent\'s context';
    qp.matchOnDetail = true;
    qp.items = items;
    qp.activeItems = items.filter((i) => i.mode === now);
    const picked = await new Promise((resolve) => {
      qp.onDidAccept(() => { resolve(qp.selectedItems[0] || qp.activeItems[0]); qp.hide(); });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!picked) return '';
    if (picked.mode !== now) {
      await cfg().update(tokenMode.NAME, picked.mode, vscode.ConfigurationTarget.Global);
      say(`token mode: ${tokenMode.labelOf(picked.mode)}, chosen from the status bar`);
    }
    if (picked.mode === tokenMode.CUSTOM) await openSwitches();
    return picked.mode === now && picked.mode !== tokenMode.CUSTOM ? '' : picked.mode;
  };

  const statusLines = () => {
    const { mode, on } = describe();
    return [`Token mode: ${tokenMode.labelOf(mode)} (agentPlus.tokenMode); adds to the agent's context: ${on.join(', ') || 'nothing'}`];
  };

  return {
    ask, choose, migrate, paint, statusLines,
    /* Shown while something uses this extension, as the views are. */
    setActive(on) { shown = !!on; paint(); },
    get start() { return start; },
    item,
    dispose() { closed = true; for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } try { item.dispose(); } catch (_) { /* gone */ } },
  };
}

module.exports = { create, pickItems, settingsQuery, features, tipLines, START_KEY, EARLIER_KEYS, COMMAND, README_TOKENS, MORE, ASK_TEXT, PRIORITY };
