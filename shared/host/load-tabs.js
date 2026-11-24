// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/load-tabs.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Loading the conversations in background tabs when a window starts (each extension's loadRestoredTabs setting). After
 * a reload VS Code puts a window's webview tabs back, but it builds a tab's page only when that tab is shown, so a
 * conversation in a background tab stays blank, and unknown to its agent, until it is clicked. Bringing each background
 * tab of the agent to the front once builds its page, and the agent keeps the page when the tab goes back.
 *
 * VS Code has no call that brings a tab to the front, so each editor group is focused by its own command
 * (workbench.action.focusFirstEditorGroup and the rest) and its tabs are shown by position with
 * workbench.action.openEditorAtIndex. Afterwards each group shows the tab it showed before, and the focus goes back to
 * the group that had it.
 */

/* Time for VS Code to build a tab's page before the next tab is brought to the front. */
const STEP_MS = 400;
const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
  .map((n) => `workbench.action.focus${n}EditorGroup`);

/*
 * groups: vscode.window.tabGroups.all; front: the active group; isTab(tab): whether a tab is one of the agent's
 * conversation tabs; exec(command, ...args) -> Promise; sleep(ms) -> Promise. Returns how many tabs were shown.
 */
async function loadAll({ groups, front, isTab, exec, sleep, stepMs = STEP_MS }) {
  let shown = 0;
  for (const g of groups || []) {
    const focus = FOCUS_GROUP[(g.viewColumn || 0) - 1];
    if (!focus) continue;
    const behind = g.tabs.map((t, i) => (isTab(t) && !t.isActive ? i : -1)).filter((i) => i >= 0);
    if (!behind.length) continue;
    const back = g.tabs.findIndex((t) => t.isActive);
    await exec(focus);
    for (const i of behind) {
      await exec('workbench.action.openEditorAtIndex', i);
      shown++;
      await sleep(stepMs);
    }
    if (back >= 0) await exec('workbench.action.openEditorAtIndex', back);
  }
  const home = front && FOCUS_GROUP[(front.viewColumn || 0) - 1];
  if (shown && home) await exec(home);
  return shown;
}

module.exports = { loadAll, FOCUS_GROUP, STEP_MS };
