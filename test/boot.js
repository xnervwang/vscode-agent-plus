// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Starts the host against a fresh stand-in VS Code for one check. src/host.js is started directly so the test can pass
 * what extension.js does not: the gallery's fetch(), no wait before the one-off notices, and where the shared folder is.
 */
const path = require('path');
const fake = require('./fake-vscode');

const CODEX = (over = {}) => ({ id: 'xnervwang.codex-extras', packageJSON: { name: 'codex-extras', displayName: 'Codex Extras',
  version: '0.1.0', extensionDependencies: ['openai.chatgpt', 'xnervwang.agent-work-plan'], agentWorkPlan: { protocol: 1 }, ...over } });
const CLAUDE = (over = {}) => ({ id: 'xnervwang.claude-code-extras', packageJSON: { name: 'claude-code-extras',
  displayName: 'Claude Code Extras', version: '1.1.0', extensionDependencies: ['xnervwang.agent-work-plan'], agentWorkPlan: { protocol: 1 }, ...over } });
const SELF = () => ({ id: 'xnervwang.agent-work-plan', packageJSON: { name: 'agent-work-plan', version: '1.0.0' } });

function boot(root, tmp, { extensions = [CODEX()], trusted = true, config = {}, fetch, noticeDelayMs = 0, version, views, memento, home,
  viewOptions, limit } = {}) {
  const { vscode, control } = fake.create({ trusted, version });
  const undo = fake.install(vscode);
  fake.fresh(root);
  control.state.extensions = [SELF()].concat(extensions);
  control.state.config = Object.assign({ 'agentWorkPlan.workPlanView': true, 'agentWorkPlan.conversationsView': true }, config);
  const storage = tmp('storage');
  const subs = [];
  const context = { subscriptions: subs, globalState: memento || fake.memento(), workspaceState: fake.memento(),
    globalStorageUri: vscode.Uri.file(storage), extensionPath: root, extensionUri: vscode.Uri.file(root) };
  const host = require(path.join(root, 'src', 'host.js'));
  const log = { appendLine: (l) => control.state.log.push(l), dispose() {} };
  const opts = { fetch, noticeDelayMs, home: home || tmp('shared'), viewOptions, limit };
  if (views !== false) {
    try { opts.views = views || require(path.join(root, 'src', 'views.js')).create; } catch (_) { /* before the views exist */ }
  }
  const api = host.start(context, log, opts);
  return {
    vscode, control, context, api, storage, home: opts.home,
    close() { for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } undo(); },
  };
}

module.exports = { boot, CODEX, CLAUDE, SELF };
