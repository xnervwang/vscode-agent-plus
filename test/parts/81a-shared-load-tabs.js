// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * shared/host/load-tabs.js against stand-in tab groups: which tabs it brings to the front, in what order, and where it
 * leaves each group and the focus. Which tabs are the agent's is the caller's to say.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const lt = require(path.join(root, 'shared', 'host', 'load-tabs.js'));
  const tab = (mine, active) => ({ mine, isActive: active });
  const groups = [
    { viewColumn: 1, tabs: [tab(true, false), tab(false, true), tab(true, false)] },
    { viewColumn: 2, tabs: [tab(false, false), tab(true, true)] },
    { viewColumn: 3, tabs: [tab(true, false), tab(true, true)] },
  ];
  const ran = [];
  const exec = async (...a) => { ran.push(a.join(' ')); };
  const n = await lt.loadAll({ groups, front: groups[1], isTab: (t) => t.mine, exec, sleep: async () => {}, stepMs: 0 });
  eq([n, ran], [3, ['workbench.action.focusFirstEditorGroup', 'workbench.action.openEditorAtIndex 0', 'workbench.action.openEditorAtIndex 2',
    'workbench.action.openEditorAtIndex 1', 'workbench.action.focusThirdEditorGroup', 'workbench.action.openEditorAtIndex 0',
    'workbench.action.openEditorAtIndex 1', 'workbench.action.focusSecondEditorGroup']],
  'each background tab the caller names is shown once, group by group, then each group shows its old front tab and the focus goes back');

  ran.length = 0;
  const none = await lt.loadAll({ groups, front: groups[1], isTab: () => false, exec, sleep: async () => {}, stepMs: 0 });
  eq([none, ran], [0, []], 'with no tab of the agent behind another, nothing is shown and the focus is not moved');
};
