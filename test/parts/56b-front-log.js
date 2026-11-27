// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The output channel's "active conversation:" line, which the feature extensions' window tests read to tell which
 * conversation Agent Plus has in front. A tab change draws the front a moment later (src/views.js drawFocus), and a
 * read of the plans in that moment moves the work plan view to the new conversation first; the line is written
 * either way, once per change.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const b = boot(root, tmp, { viewOptions: { listWaitMs: 20, slowMs: 1e9, refreshMs: 1e9 } });
  const { control } = b;
  const ws = tmp('ws');
  b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(ws) }];
  const plans = tmp('plans');
  for (const id of ['A', 'B']) fs.writeFileSync(path.join(plans, id + '.json'), JSON.stringify({ nodes: [{ title: id, state: 'todo' }] }));
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
    sessionForTab: (tab) => (tab && tab.input && tab.input.conv) || null, isFocused: () => true,
    listConversations: async () => ['A', 'B'].map((id) => ({ sessionId: id, title: id, cwd: ws, state: 'idle', running: true })) });
  await wait(120);
  const said = () => control.state.log.filter((l) => / active conversation: |^active conversation: /.test(l)).map((l) => l.replace(/^.*active conversation: /, ''));
  const to = (id) => { control.setTabs([{ label: id, input: { conv: id } }]); control.fireTabs(); };

  to('A');
  await wait(20);
  eq(said().slice(-1), ['codex A'], 'a tab of a conversation brought forward is said to be in front');

  to('B');
  await control.state.handlers['agentPlus.refreshWorkPlan']();
  await wait(20);
  eq(said().slice(-1), ['codex B'], 'and so is the next, when a read of the plans moved the work plan view to it before the front was drawn');

  to('B');
  b.control.fireTabs();
  await control.state.handlers['agentPlus.refreshWorkPlan']();
  await wait(20);
  eq(said().filter((x) => x === 'codex B').length, 1, 'the line is not written again for a front that did not change');
  b.close();
};
