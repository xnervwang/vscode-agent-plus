// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code Extras and Codex Extras list this extension in extensionDependencies, and VS Code starts neither until
 * this activate() has returned. So it returns the registration interface at once, waits for no other extension, and
 * never throws: anything that fails, loading the modules included, is logged and an interface still comes back,
 * refusing registrations with the reason.
 */
const vscode = require('vscode');

/*
 * Kept here rather than in src/ so that it exists even when a module under src/ fails to load. It carries every member
 * of the interface, `version` included: a dependent reads that to work out what to tell the user, and undefined there
 * would read as a version older than any release.
 */
function refusing(error) {
  const reason = 'Agent Work Plan could not start: ' + String((error && error.message) || error || 'unknown error');
  let version = '';
  try { version = String(require('./package.json').version || ''); } catch (_) { version = ''; }
  return Object.freeze({
    family: 'agent-work-plan', version, protocol: 1, accepts: [1], features: [],
    registerSource: () => Object.freeze({ accepted: false, code: 'failed', reason, registration: null }),
  });
}

function activate(context) {
  let log = null;
  try {
    log = vscode.window.createOutputChannel('Agent Work Plan');
    context.subscriptions.push(log);
  } catch (_) { log = null; }
  try {
    const host = require('./src/host');
    const views = require('./src/views');
    const limit = require('./src/request-limit');
    return { agentWorkPlan: host.start(context, log, { views: views.create, limit: limit.create }) };
  } catch (e) {
    try { if (log) log.appendLine(`could not start: ${(e && e.stack) || e}`); } catch (_) { /* nothing left to report to */ }
    return { agentWorkPlan: refusing(e) };
  }
}

function deactivate() {}

module.exports = { activate, deactivate, refusing };
