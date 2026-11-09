// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Taking over the Conversations switch someone set under the Claude Code extension's old ids, against a stand-in
 * settings store that answers inspect() per scope the way VS Code does for keys no installed extension declares.
 */
const path = require('path');
const fake = require('../fake-vscode');
const oldSettings = require('../../src/old-settings');

function settings(values, { trusted, folders = [], refuse = '' } = {}) {
  const writes = [];
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      isTrusted: trusted,
      workspaceFolders: folders,
      getConfiguration: (section) => ({
        inspect: (name) => {
          const v = values[`${section}.${name}`];
          return v ? { key: `${section}.${name}`, ...v } : undefined;
        },
        update: async (name, value, target) => {
          if (refuse && target === refuse) throw new Error('refused');
          writes.push([`${section}.${name}`, value, target]);
          const k = `${section}.${name}`;
          values[k] = { ...(values[k] || {}), [target === 1 ? 'globalValue' : 'workspaceValue']: value };
        },
      }),
    },
  };
  return { vscode, writes };
}

module.exports = async ({ eq, root, tmp, wait }) => {
  {
    const { vscode, writes } = settings({ 'claudeCodeWorkPlan.conversations': { globalValue: false } });
    eq(await oldSettings.adopt(vscode), [['agentPlus.conversationsView', 'Global', false]], 'a switch turned off under the old id is taken over');
    eq(writes, [['agentPlus.conversationsView', false, 1]], 'at the scope it was set at');
    eq(await oldSettings.adopt(vscode), [], 'and once only: the second start finds this extension\'s own already set');
  }
  {
    const { vscode } = settings({ 'claudeCodeExtras.conversations': { workspaceValue: false } });
    eq(await oldSettings.adopt(vscode), [['agentPlus.conversationsView', 'Workspace', false]], 'the older id too, in a workspace');
  }
  {
    const { vscode, writes } = settings({ 'claudeCodeWorkPlan.conversations': { globalValue: false },
      'agentPlus.conversationsView': { globalValue: true } });
    eq([await oldSettings.adopt(vscode), writes], [[], []], 'a value set for this extension wins over the old one');
  }
  {
    const { vscode, writes } = settings({ 'claudeCodeWorkPlan.conversations': { globalValue: false },
      'claudeCodeExtras.conversations': { globalValue: true } });
    await oldSettings.adopt(vscode);
    eq(writes, [['agentPlus.conversationsView', false, 1]], 'of the two old ids, the later one is taken');
  }
  {
    const { vscode, writes } = settings({});
    eq([await oldSettings.adopt(vscode), writes], [[], []], 'nothing set under either old id: nothing written');
  }
  /* Restricted Mode: a workspace's .vscode/settings.json is not this extension's to write until it is trusted. */
  {
    const { vscode, writes } = settings({ 'claudeCodeWorkPlan.conversations': { workspaceValue: false } }, { trusted: false, folders: [{}] });
    const context = { globalState: fake.memento(), workspaceState: fake.memento() };
    eq([await oldSettings.adopt(vscode, context), writes, context.workspaceState.keys()], [[], [], []],
      'in Restricted Mode nothing is written and nothing is recorded as done');
  }
  /* Each scope once: a value the reader resets afterwards is not brought back from the old id, which is still set. */
  {
    const values = { 'claudeCodeWorkPlan.conversations': { globalValue: false, workspaceValue: false } };
    const { vscode, writes } = settings(values, { folders: [{}] });
    const context = { globalState: fake.memento(), workspaceState: fake.memento() };
    await oldSettings.adopt(vscode, context);
    delete values['agentPlus.conversationsView'];
    await oldSettings.adopt(vscode, context);
    eq(writes, [['agentPlus.conversationsView', false, 1], ['agentPlus.conversationsView', false, 2]],
      'each scope is taken over once, and a value reset afterwards is not written back at the next start');
  }
  /* A scope that could not be written is tried again next time; the one that was written is not. */
  {
    const values = { 'claudeCodeWorkPlan.conversations': { globalValue: false, workspaceValue: false } };
    const first = settings(values, { folders: [{}], refuse: 2 });
    const context = { globalState: fake.memento(), workspaceState: fake.memento() };
    await oldSettings.adopt(first.vscode, context);
    const second = settings(values, { folders: [{}] });
    await oldSettings.adopt(second.vscode, context);
    eq([first.writes, second.writes], [[['agentPlus.conversationsView', false, 1]], [['agentPlus.conversationsView', false, 2]]],
      'a scope whose write failed is tried again at the next start, and only that one');
  }
  /* The extension's own start: in an untrusted window it waits for trust. */
  {
    const { vscode, control } = fake.create({ trusted: false });
    const undo = fake.install(vscode);
    fake.fresh(root);
    const store = settings({ 'claudeCodeWorkPlan.conversations': { globalValue: false } });
    const own = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = (section) => Object.assign({}, own(section), store.vscode.workspace.getConfiguration(section));
    const subs = [];
    const context = { subscriptions: subs, globalState: fake.memento(), workspaceState: fake.memento(),
      globalStorageUri: vscode.Uri.file(tmp('adopt-storage')), extensionPath: root, extensionUri: vscode.Uri.file(root) };
    require(path.join(root, 'extension.js')).activate(context);
    await wait(20);
    const before = store.writes.slice();
    control.grantTrust();
    await wait(20);
    eq([before, store.writes], [[], [['agentPlus.conversationsView', false, 1]]],
      'an untrusted window takes over nothing until the workspace is trusted, and then does');
    for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } }
    undo();
  }
};
