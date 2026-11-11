// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The token mode setting and its table (src/token-mode.js), and what Agent Plus does with it (src/token-choice.js).
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { CODEX, CLAUDE } = require('../boot');

const MODES = ['interface', 'essential', 'all', 'custom'];
const CODEX_KEYS = ['codexPlus.workPlan', 'codexPlus.tellCodexYourTimeZone', 'codexPlus.conversationBrief', 'codexPlus.skillRouting', 'codexPlus.wakeUps'];
const CLAUDE_KEYS = ['claudeCodePlus.workPlan', 'claudeCodePlus.tellClaudeYourTimeZone', 'claudeCodePlus.conversationBrief'];

/* A stand-in VS Code holding only settings, for the pure functions. */
function settings(config = {}) {
  const { vscode, control } = fake.create();
  Object.assign(control.state.config, config);
  return { vscode, control };
}

module.exports = async ({ eq, tmp, root, wait }) => {
  const tm = require(path.join(root, 'src', 'token-mode.js'));
  const choice = require(path.join(root, 'src', 'token-choice.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  /* ── The setting ── */
  {
    const s = pkg.contributes.configuration.properties['agentPlus.tokenMode'] || {};
    eq([s.type, s.scope, s.enum, s.default], ['string', 'application', MODES, 'all'],
      'agentPlus.tokenMode is an application setting with the four modes, All features by default');
    eq([s.enumItemLabels, s.enumDescriptions], [tm.MODES.map((m) => m.label), tm.MODES.map((m) => m.detail)],
      'its labels and descriptions are the ones src/token-mode.js gives the status bar\'s list');
    eq(s.enumItemLabels, ['Interface features', 'Essential features', 'All features', 'Custom'], 'and the labels are the four names agreed on');
    const link = /\]\((https:\/\/github\.com\/xnervwang\/vscode-agent-plus#([\w-]+))\)/.exec(s.markdownDescription || '') || [];
    eq([link[1], choice.README_TOKENS], [choice.README_TOKENS, 'https://github.com/xnervwang/vscode-agent-plus#what-it-costs-in-tokens'],
      'its description links to the README\'s token section, as the first-install notice does');
    eq(/^## What it costs in tokens$/m.test(readme), true, 'and the README has that section');
    const table = /## What it costs in tokens\n\n([\s\S]*?)\n\n/.exec(readme);
    eq(!!table && tm.MODES.every((m) => table[1].includes(`| ${m.label} |`)), true, 'which opens with a table of the four modes');
    eq(/\| `agentPlus\.tokenMode` \| `all` \|/.test(readme), true, 'and the settings table has a row for it');
    const cmd = pkg.contributes.commands.find((c) => c.command === choice.COMMAND);
    eq([!!cmd, (pkg.contributes.menus.commandPalette.find((c) => c.command === choice.COMMAND) || {}).when],
      [true, '!agentPlus.alone'], 'the command behind the status bar entry is declared and in the palette while something uses this extension');
    const undo = fake.install(fake.create().vscode);
    fake.fresh(root);
    eq(require(path.join(root, 'src', 'host.js')).COMMANDS.includes('chooseTokenMode'), true, 'and registered with the others');
    undo();
  }

  /* ── What each mode turns on ── */
  {
    const want = {
      interface: [false, false, false, false, false],
      essential: [true, true, false, false, false],
      all: [true, true, true, true, true],
    };
    for (const mode of ['interface', 'essential', 'all']) {
      const { vscode } = settings({ 'agentPlus.tokenMode': mode, ...Object.fromEntries(CODEX_KEYS.map((k) => [k, mode === 'all' ? false : true])) });
      eq(CODEX_KEYS.map((k) => tm.effective(vscode, k)), want[mode], `${mode}: the five Codex Plus features run as the table says, whatever their own settings are`);
      eq(CLAUDE_KEYS.map((k) => tm.effective(vscode, k)), want[mode].slice(0, 3), `${mode}: and Claude Code Plus's three`);
    }
    const custom = { 'codexPlus.workPlan': false, 'codexPlus.tellCodexYourTimeZone': true, 'codexPlus.skillRouting': false, 'claudeCodePlus.conversationBrief': false };
    const { vscode, control } = settings({ 'agentPlus.tokenMode': 'custom', ...custom });
    eq(CODEX_KEYS.map((k) => tm.effective(vscode, k)), [false, true, true, false, true], 'custom: each feature follows its own setting, one not set being on');
    eq(CLAUDE_KEYS.map((k) => tm.effective(vscode, k)), [true, true, false], 'custom: Claude Code Plus\'s too');
    for (const mode of ['interface', 'essential', 'all', 'custom']) control.state.config['agentPlus.tokenMode'] = mode;
    eq([CODEX_KEYS.map((k) => tm.effective(vscode, k)), Object.fromEntries(Object.keys(custom).map((k) => [k, control.state.config[k]]))],
      [[false, true, true, false, true], custom], 'switching to the other modes and back to Custom finds every setting as it was');
    eq([tm.modeNow(settings().vscode), tm.modeNow(settings({ 'agentPlus.tokenMode': 'max' }).vscode)], ['all', 'all'],
      'nothing set is All features, and so is a value no mode has');
    eq(MODES.map((m) => tm.unloadsPlugin(m)), [true, false, false, false], 'only Interface features takes the work plan plugin out of the agent');
    eq(tm.SWITCHES.map((s) => s.key).sort(), [...CLAUDE_KEYS, ...CODEX_KEYS].sort(), 'the settings an earlier install is checked for are the eight of the two extensions');
    eq(tm.SWITCHES.every((s) => s.default === true), true, 'each of them on by default');
  }

  /* ── The notice for a setting changed outside Custom ── */
  {
    const { vscode, control } = settings({ 'agentPlus.tokenMode': 'essential' });
    const sub = tm.warnOutsideCustom(vscode, CODEX_KEYS, { who: 'Codex Plus' });
    control.answer('codexPlus.skillRouting', tm.SWITCH_BUTTON);
    control.state.config['codexPlus.skillRouting'] = false;
    control.changeConfig(['codexPlus.skillRouting']);
    control.changeConfig(['codexPlus.skillRouting']);
    await wait(5);
    eq(control.state.said.map((s) => [s.message, s.buttons]), [[
      'Codex Plus: the token mode is Essential features, so codexPlus.skillRouting has no effect until the mode is Custom.', ['Switch to Custom']]],
    'outside Custom, changing a feature\'s setting says once in this window which mode is in effect, with a button');
    eq(control.state.configWrites, [['agentPlus.tokenMode', 'custom']], 'and the button switches the mode to Custom');
    control.changeConfig(['codexPlus.wakeUps']);
    await wait(5);
    eq(control.state.said.length, 1, 'in Custom it says nothing');
    control.state.config['agentPlus.tokenMode'] = 'all';
    control.changeConfig(['codexPlus.wakeUps']);
    control.changeConfig(['agentPlus.tokenMode']);
    await wait(5);
    eq(control.state.said.map((s) => s.message.includes('codexPlus.wakeUps')), [false, true], 'another setting is told about once of its own; the mode itself is not');
    sub.dispose();
  }

  /* ── The first install ── */
  /* test/boot.js passes no tokenMode, so these start the host with one, as extension.js does. */
  const host = (over = {}) => {
    const { vscode, control } = fake.create({ trusted: over.trusted !== false });
    const undo = fake.install(vscode);
    fake.fresh(root);
    control.state.extensions = [{ id: 'xnervwang.agent-plus', packageJSON: { name: 'agent-plus', version: pkg.version } }]
      .concat(over.extensions || [CODEX()]);
    Object.assign(control.state.config, over.config || {});
    if (over.answers) for (const [m, p] of over.answers) control.answer(m, p);
    const subs = [];
    const memento = over.memento || fake.memento();
    const context = { subscriptions: subs, globalState: memento, workspaceState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('storage')),
      extensionPath: root };
    const hostMod = require(path.join(root, 'src', 'host.js'));
    const api = hostMod.start(context, { appendLine: (l) => control.state.log.push(l) }, { noticeDelayMs: 0, home: over.home || tmp('shared'),
      tokenMode: require(path.join(root, 'src', 'token-choice.js')).create });
    return { vscode, control, memento, api, close() { for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } undo(); } };
  };

  {
    const home = tmp('shared-first');
    const a = host({ home, answers: [[choice.ASK_TEXT, 'Essential features']] });
    eq(a.memento.get(choice.START_KEY), 'new', 'a first install is recorded as one at once, before anything else writes to globalState');
    await wait(20);
    const asked = a.control.state.said.filter((s) => s.message === choice.ASK_TEXT);
    eq(asked.map((s) => s.buttons), [['Interface features', 'Essential features', 'All features', 'Custom', 'Learn More']],
      'a first install asks for a mode once, with a button for each and one for the README');
    eq([a.control.state.configWrites, a.memento.get(choice.START_KEY)], [[['agentPlus.tokenMode', 'essential']], 'asked'],
      'the mode picked is written to the user settings, and the notice is not owed any more');
    a.close();
    const again = host({ home, memento: a.memento });
    await wait(20);
    eq(again.control.state.said.filter((s) => s.message === choice.ASK_TEXT).length, 0, 'the next start does not ask again');
    again.close();
  }
  {
    const a = host({ answers: [[choice.ASK_TEXT, 'Learn More']] });
    await wait(20);
    eq([a.control.state.external, a.control.state.configWrites], [[choice.README_TOKENS], []], 'Learn More opens the README\'s token section and changes nothing');
    a.close();
    const custom = host({ answers: [[choice.ASK_TEXT, 'Custom']] });
    await wait(20);
    eq([custom.control.state.configWrites, custom.control.state.commands.filter((c) => c[0] === 'workbench.action.openSettings')],
      [[['agentPlus.tokenMode', 'custom']], [['workbench.action.openSettings', '@id:codexPlus.workPlan,codexPlus.tellCodexYourTimeZone,'
        + 'codexPlus.conversationBrief,codexPlus.skillRouting,codexPlus.wakeUps']]],
      'Custom from the notice opens the Settings editor on the feature settings of Codex Plus, the one extension installed');
    custom.close();
    const b = host({});
    await wait(20);
    eq([b.control.state.said.some((s) => s.message === choice.ASK_TEXT), b.control.state.configWrites, b.memento.get(choice.START_KEY)],
      [true, [], 'asked'], 'closing the notice leaves the mode at its default, and it is not asked again');
    b.close();
  }
  {
    const home = tmp('shared-two');
    const a = host({ home }), b = host({ home });
    await wait(20);
    eq([a, b].map((w) => w.control.state.said.filter((s) => s.message === choice.ASK_TEXT).length), [1, 0],
      'of two windows of one client that start together, one asks');
    a.close(); b.close();
  }
  {
    const alone = host({ extensions: [] });
    await wait(20);
    eq([alone.control.state.said.some((s) => s.message === choice.ASK_TEXT), alone.memento.get(choice.START_KEY)], [false, 'new'],
      'with nothing that uses this extension, nothing is asked yet');
    alone.control.state.extensions.push(CLAUDE());
    alone.control.fireExtensions();
    await wait(20);
    eq(alone.control.state.said.some((s) => s.message === choice.ASK_TEXT), true, 'and it asks once an extension that uses it is installed');
    alone.close();
    const untrusted = host({ trusted: false });
    await wait(20);
    eq(untrusted.control.state.said.some((s) => s.message === choice.ASK_TEXT), false, 'an untrusted window does not ask');
    untrusted.control.grantTrust();
    await wait(20);
    eq(untrusted.control.state.said.some((s) => s.message === choice.ASK_TEXT), true, 'until the workspace is trusted');
    untrusted.close();
  }

  /* ── An earlier install ── */
  const earlier = (extra = {}) => { const m = fake.memento(); m.update('agentPlus.hadDependents', true); for (const [k, v] of Object.entries(extra)) m.update(k, v); return m; };
  {
    const a = host({ memento: earlier(), config: { 'codexPlus.skillRouting': false, 'claudeCodePlus.workPlan': true } });
    await wait(20);
    eq([a.control.state.said.some((s) => s.message === choice.ASK_TEXT), a.control.state.configWrites, a.memento.get(choice.START_KEY)],
      [false, [['agentPlus.tokenMode', 'custom']], 'migrated'],
      'an earlier install is not asked; a feature setting changed from its default makes the mode Custom, once');
    eq(a.control.state.commands.filter((c) => c[0] === 'workbench.action.openSettings'), [], 'without opening the Settings editor');
    a.close();
    const b = host({ memento: a.memento, config: { 'codexPlus.wakeUps': false } });
    await wait(20);
    eq(b.control.state.configWrites, [], 'and the next start does not look again');
    b.close();
  }
  {
    const a = host({ memento: earlier({ 'agentPlus.oldSettingsAdopted': true }), config: { 'codexPlus.skillRouting': true } });
    await wait(20);
    eq([a.control.state.configWrites, a.memento.get(choice.START_KEY), a.control.state.said.length], [[], 'migrated', 0],
      'with every feature setting at its default, or set to it, nothing is written');
    a.close();
    const chosen = host({ memento: earlier(), config: { 'codexPlus.wakeUps': false, 'agentPlus.tokenMode': 'essential' } });
    await wait(20);
    eq(chosen.control.state.configWrites, [], 'a mode already chosen is left as it is');
    chosen.close();
    const m = fake.memento();
    m.update('agentPlus.timeZone', 'Europe/Paris');
    const anyKey = host({ memento: m, config: { 'claudeCodePlus.conversationBrief': false } });
    await wait(20);
    eq([anyKey.control.state.configWrites, anyKey.control.state.said.length], [[['agentPlus.tokenMode', 'custom']], 0],
      'any key an earlier version left counts as an earlier install');
    anyKey.close();
    const untrusted = host({ trusted: false, memento: earlier(), config: { 'codexPlus.skillRouting': false } });
    await wait(20);
    eq(untrusted.control.state.configWrites, [], 'an untrusted window writes nothing');
    untrusted.control.grantTrust();
    await wait(20);
    eq(untrusted.control.state.configWrites, [['agentPlus.tokenMode', 'custom']], 'until the workspace is trusted');
    untrusted.close();
  }
  {
    const noKeys = fake.memento();
    noKeys.update('agentPlus.hadDependents', true);
    delete noKeys.keys;
    const a = host({ memento: noKeys, config: { 'codexPlus.workPlan': false } });
    await wait(20);
    eq(a.control.state.configWrites, [['agentPlus.tokenMode', 'custom']], 'a memento that cannot list its keys is asked for the keys earlier versions wrote');
    a.close();
  }

  /* ── The status bar entry and its list ── */
  {
    const a = host({ memento: earlier(), extensions: [CODEX(), CLAUDE()] });
    await wait(20);
    const item = a.control.state.status.find((s) => s.id === 'agentPlus.tokenMode');
    eq([!!item, item && item.shown, item && item.text, item && item.command], [true, true, '$(dashboard) All', 'agentPlus.chooseTokenMode'],
      'the status bar entry shows the mode\'s short name and opens the list');
    eq(item.tooltip.split('\n'), ['Token mode: All features',
      'Adds to the agent\'s context: work plan, time-zone note, conversation brief, skill suggestions, wake-ups',
      'What the extensions show in VS Code costs no tokens.', 'Click to choose another mode.'],
    'its hover says what the mode adds to the agent\'s context, and that the rest costs nothing');
    const texts = {};
    for (const mode of MODES) {
      a.control.state.config['agentPlus.tokenMode'] = mode;
      a.control.changeConfig(['agentPlus.tokenMode']);
      texts[mode] = [item.text, item.tooltip.split('\n')[1], item.tooltip.split('\n')[2]];
    }
    eq(texts, {
      interface: ['$(dashboard) Interface', 'Adds to the agent\'s context: nothing', 'Left out: work plan, time-zone note, conversation brief, skill suggestions, wake-ups'],
      essential: ['$(dashboard) Essential', 'Adds to the agent\'s context: work plan, time-zone note', 'Left out: conversation brief, skill suggestions, wake-ups'],
      all: ['$(dashboard) All', 'Adds to the agent\'s context: work plan, time-zone note, conversation brief, skill suggestions, wake-ups', 'What the extensions show in VS Code costs no tokens.'],
      custom: ['$(dashboard) Custom', 'Adds to the agent\'s context: work plan, time-zone note, conversation brief, skill suggestions, wake-ups', 'What the extensions show in VS Code costs no tokens.'],
    }, 'each mode is drawn as soon as it is chosen');
    a.control.state.config['claudeCodePlus.conversationBrief'] = false;
    a.control.state.config['codexPlus.wakeUps'] = false;
    a.control.changeConfig(['codexPlus.wakeUps']);
    eq(item.tooltip.split('\n').slice(1, 3), ['Adds to the agent\'s context: work plan, time-zone note, conversation brief (Codex Plus), skill suggestions',
      'Left out: conversation brief (Claude Code Plus), wake-ups'], 'in Custom it follows each extension\'s own settings, naming the extension where they differ');
    a.control.state.config['agentPlus.tokenMode'] = 'essential';
    a.control.changeConfig(['agentPlus.tokenMode']);

    let shown = null;
    a.control.state.onQuickPick = (qp) => { shown = { title: qp.title, items: qp.items.map((i) => ({ label: i.label, description: i.description, detail: i.detail })),
      active: qp.activeItems.map((i) => i.mode) }; qp.accept(qp.items[0]); };
    const picked = await a.control.state.handlers['agentPlus.chooseTokenMode']();
    eq(shown && shown.items, [
      { label: 'Interface features', description: 'no tokens', detail: 'Adds nothing to the agent\'s context, and unloads the work plan plugin.' },
      { label: 'Essential features', description: '$(check) current', detail: 'Adds the work plan and the time-zone note, nothing else.' },
      { label: 'All features', description: 'default', detail: 'Adds every feature, including the brief, skill suggestions and wake-ups.' },
      { label: 'Custom', description: '', detail: 'Each feature follows its own setting; all are on until you turn one off.' },
    ], 'the list has the four modes, the one in effect ticked in its description, each with a short mark and a line saying what it adds');
    eq([shown.items.some((i) => i.label.includes('$(')), Math.max(...shown.items.map((i) => i.detail.length)) <= 85], [false, true],
      'no name has an icon before it, which would push it out of line with the line under it, and each of those lines fits on one');
    eq(choice.pickItems('all').map((i) => i.description), ['no tokens', '', 'default · $(check) current', ''], 'the tick sits beside a short mark');
    eq(tm.MODES.map((m) => m.detail), pkg.contributes.configuration.properties['agentPlus.tokenMode'].enumDescriptions,
      'and that line is the setting\'s description in the Settings editor');
    eq([shown.active, picked, a.control.state.configWrites], [['essential'], 'interface', [['agentPlus.tokenMode', 'interface']]],
      'it opens on the mode in effect, and picking another writes it');
    eq(a.control.state.commands.filter((c) => c[0] === 'workbench.action.openSettings'), [], 'and opens no settings');
    a.control.state.onQuickPick = (qp) => qp.hide();
    eq([await a.control.state.handlers['agentPlus.chooseTokenMode'](), a.control.state.configWrites.length], ['', 1], 'closing the list changes nothing');
    const query = '@id:claudeCodePlus.workPlan,claudeCodePlus.tellClaudeYourTimeZone,claudeCodePlus.conversationBrief,codexPlus.workPlan,'
      + 'codexPlus.tellCodexYourTimeZone,codexPlus.conversationBrief,codexPlus.skillRouting,codexPlus.wakeUps';
    for (const pass of [1, 2]) {
      a.control.state.onQuickPick = (qp) => qp.accept(qp.items.find((i) => i.mode === 'custom'));
      await a.control.state.handlers['agentPlus.chooseTokenMode']();
      eq([a.control.state.config['agentPlus.tokenMode'], a.control.state.commands.filter((c) => c[0] === 'workbench.action.openSettings').length,
        (a.control.state.commands.filter((c) => c[0] === 'workbench.action.openSettings').pop() || [])[1]], ['custom', pass, query],
      pass === 1 ? 'picking Custom opens the Settings editor on the feature settings of the extensions installed'
        : 'and so does picking it again while it is the mode');
    }
    a.control.state.config['agentPlus.tokenMode'] = 'essential';
    const lines = await a.control.state.handlers['agentPlus.showStatus']();
    eq(lines.filter((l) => l.startsWith('Token mode:')), ['Token mode: Essential features (agentPlus.tokenMode); adds to the agent\'s context: work plan, time-zone note'],
      'Show Status says the mode and what it adds');
    a.close();
    eq(item.disposed, true, 'the entry goes with the window');
  }
  {
    const a = host({ memento: earlier(), extensions: [CLAUDE()] });
    await wait(20);
    const item = a.control.state.status.find((s) => s.id === 'agentPlus.tokenMode');
    eq(item.tooltip.split('\n')[1], 'Adds to the agent\'s context: work plan, time-zone note, conversation brief', 'with only Claude Code Plus installed, only its features are listed');
    a.close();
    const alone = host({ memento: earlier(), extensions: [] });
    await wait(20);
    eq(alone.control.state.status.find((s) => s.id === 'agentPlus.tokenMode').shown, false, 'with nothing that uses this extension the entry is hidden, as the views are');
    alone.close();
  }

  /* ── extension.js starts it ── */
  {
    const { vscode } = fake.create();
    const undo = fake.install(vscode);
    fake.fresh(root);
    const hostPath = require.resolve(path.join(root, 'src', 'host.js'));
    const real = require(hostPath);
    let given = null;
    require.cache[hostPath].exports = Object.assign({}, real, { start: (ctx, log, opts) => { given = opts; return real.unavailable(new Error('stub')); } });
    require(path.join(root, 'extension.js')).activate({ subscriptions: [], globalState: fake.memento(), workspaceState: fake.memento() });
    eq(!!given && given.tokenMode === require(path.join(root, 'src', 'token-choice.js')).create, true, 'extension.js passes the token mode to the host');
    delete require.cache[hostPath];
    undo();
  }
};
