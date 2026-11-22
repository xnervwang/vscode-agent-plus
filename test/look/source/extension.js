// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A stand-in source for test/look/conversations-panel.js: one conversation for each activity, with and without a reply
 * not seen, a question put in a plan after the user's last message, and a title long enough to be cut. Once the
 * Conversations view shows them it writes LOOK_READY, so the runner knows when to take the picture.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const HOUR = 3600e3;
/* [session id, title, state, activity, unseen] */
const ROWS = [
  ['run', 'Running a turn', 'working', 'working', false],
  ['run-new', 'Running, with a reply not read yet', 'working', 'working', true],
  ['bg', 'Only background work left', 'working', 'background', false],
  ['bg-new', 'Background work, reply not read', 'working', 'background', true],
  ['prompt', 'At a permission prompt', 'prompt', 'waiting', false],
  ['asks', 'Asked a question in its plan', 'idle', 'stopped', true],
  ['done', 'Stopped, nothing new', 'idle', 'stopped', false],
  ['done-new', 'Stopped with a reply not read', 'unread', 'stopped', true],
  ['long', 'A long title that is cut short in a narrow panel, while the envelope at the end of the row stays in view', 'unread', 'stopped', true],
];

async function activate() {
  const ext = vscode.extensions.getExtension('xnervwang.agent-plus');
  const api = ((await ext.activate()) || ext.exports || {}).agentPlus;
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const plans = process.env.LOOK_PLANS;
  const now = Date.now();
  const list = ROWS.map(([sessionId, title, state, activity, unseen], i) => ({ sessionId, title, cwd: folder, state, activity, unseen,
    running: true, lastActiveAt: now - i * 60e3, lastUserAt: now - HOUR }));
  const result = api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code',
    planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans, listConversations: async () => list });
  await vscode.commands.executeCommand('agentPlus.conversations.focus');
  await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
  setTimeout(async () => {
    await vscode.commands.executeCommand('notifications.clearAll');
    fs.writeFileSync(process.env.LOOK_READY, JSON.stringify({ accepted: result.accepted, reason: result.reason }));
  }, 3000);
}

module.exports = { activate, deactivate() {} };
