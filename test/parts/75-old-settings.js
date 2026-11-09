// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Taking over the Conversations switch someone set under the Claude Code extension's old ids, against a stand-in
 * settings store that answers inspect() per scope the way VS Code does for keys no installed extension declares.
 */
const oldSettings = require('../../src/old-settings');

function settings(values) {
  const writes = [];
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      getConfiguration: (section) => ({
        inspect: (name) => {
          const v = values[`${section}.${name}`];
          return v ? { key: `${section}.${name}`, ...v } : undefined;
        },
        update: async (name, value, target) => {
          writes.push([`${section}.${name}`, value, target]);
          const k = `${section}.${name}`;
          values[k] = { ...(values[k] || {}), [target === 1 ? 'globalValue' : 'workspaceValue']: value };
        },
      }),
    },
  };
  return { vscode, writes };
}

module.exports = async ({ eq }) => {
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
};
