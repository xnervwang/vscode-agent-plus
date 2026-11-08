// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code Extras and Codex Extras list this extension in extensionDependencies, and VS Code starts neither until
 * this activate() has returned. So it returns the registration interface at once, waits for no other extension, and
 * never throws: anything that fails is logged and the interface still comes back, refusing registrations with a reason.
 */
const vscode = require('vscode');
const { start, unavailable } = require('./src/host');

function activate(context) {
  let log = null;
  try {
    log = vscode.window.createOutputChannel('Agent Work Plan');
    context.subscriptions.push(log);
  } catch (_) { log = null; }
  try {
    return { agentWorkPlan: start(context, log) };
  } catch (e) {
    try { if (log) log.appendLine(`could not start: ${(e && e.stack) || e}`); } catch (_) { /* nothing left to report to */ }
    return { agentWorkPlan: unavailable(e) };
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
