// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's limit on the requests webview tabs can have in flight (src/webview-limit.js), looked at a few seconds after
 * the views start so the window is not held up, and only in a trusted window. It asks once for each new VS Code build
 * or, if agentWorkPlan.webviewRequestLimit says so, raises the limit again without asking. On Linux it never raises on
 * its own: VS Code added the limit there because too many open files can crash a window. From the request limit part of
 * extension.js in vscode-claude-code-extras bb28f51, and src/request-limit.js of vscode-codex-extras, which this
 * replaces in both.
 */
const fs = require('fs');
const path = require('path');
const webviewLimit = require('./webview-limit');

const SETTING = 'webviewRequestLimit';
const ASKED_KEY = 'agentWorkPlan.webviewLimitAsked';
const START_DELAY_MS = 8000;

function place(vscode) {
  const local = !vscode.env.remoteName;
  let commit = '';
  try { commit = String(JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).commit || ''); } catch (_) { /* unknown */ }
  return { fs: vscode.workspace.fs, local, appRoot: vscode.env.appRoot, commit,
    at: local ? (p) => vscode.Uri.file(p) : (p) => vscode.Uri.from({ scheme: 'vscode-local', path: p }) };
}

/* `host` is what src/host.js passes: vscode, context, say, trusted(). `opts.where` replaces place(), for tests. */
function create(host, opts = {}) {
  const { vscode, context, say } = host;
  const cfg = () => vscode.workspace.getConfiguration('agentWorkPlan');
  const where = () => (opts.where ? opts.where() : place(vscode));
  const timers = new Set();
  const subs = [];
  const change = async (at, installs, from, to) => {
    const failed = [];
    for (const i of installs) {
      const why = await webviewLimit.setLimit(at.fs, i, from, to, opts.timing);
      say(`webview request limit: ${i.root} ${from} -> ${to}: ${why || 'done'}`);
      if (why) failed.push({ install: i, why });
    }
    return failed;
  };
  const stuck = async (failed) => {
    if (failed[0].why === 'locked') {
      vscode.window.showWarningMessage('Agent Work Plan: another window is changing VS Code\'s request limit. Try again in a minute.');
      return;
    }
    const how = webviewLimit.byHand(failed[0].install, process.platform);
    const why = /NoPermissions|EACCES|EPERM/.test(failed[0].why) ? 'no permission to write the file' : failed[0].why;
    if (await vscode.window.showWarningMessage(`Agent Work Plan: could not change VS Code's request limit (${why}). To change it yourself: ${how}`,
      'Copy the command') === 'Copy the command') await vscode.env.clipboard.writeText(how);
  };
  let busy = false, started = false;
  const checkOnce = async () => {
    const mode = cfg().get(SETTING, 'ask');
    if (mode === 'leave' || !host.trusted() || !vscode.workspace.fs || !vscode.env.appRoot) return;
    const at = where();
    const installs = await webviewLimit.find(at);
    say('webview request limit: ' + (installs.map((i) => `${i.root} = ${i.limit}`).join('; ') || 'no installation found'));
    const low = installs.filter((i) => i.limit === webviewLimit.OLD);
    if (!low.length) return;
    const linux = low.every((i) => webviewLimit.platformOf(i.root, process.platform) === 'linux');
    if (mode !== 'raise' || linux) {
      if (context.globalState.get(ASKED_KEY, '') === at.commit) return;
      await context.globalState.update(ASKED_KEY, at.commit);
      const always = 'Raise it, now and after updates', once = 'Raise it this time', no = 'Leave it';
      const pick = await vscode.window.showInformationMessage(
        'Agent Work Plan: VS Code lets webview tabs, Claude Code\'s and Codex\'s among them, have 32 requests in flight at once '
        + 'across all windows, and a tab can stay blank waiting for one. Raise the limit to 1000000 in VS Code\'s own files?'
        + (linux ? ' VS Code added the limit for Linux, where too many open files can crash a window.' : ''),
        ...(linux ? [once, no] : [always, once, no]));
      if (pick === no) { await cfg().update(SETTING, 'leave', vscode.ConfigurationTarget.Global); return; }
      if (pick !== always && pick !== once) return;
      if (pick === always) await cfg().update(SETTING, 'raise', vscode.ConfigurationTarget.Global);
    }
    const failed = await change(at, low, webviewLimit.OLD, webviewLimit.NEW);
    if (failed.length < low.length) {
      vscode.window.showInformationMessage('Agent Work Plan: VS Code\'s request limit is now 1000000. Quit and reopen VS Code for this to apply.');
    }
    if (failed.length) await stuck(failed);
  };
  const check = async () => {
    if (busy) return;
    busy = true;
    try { await checkOnce(); } catch (e) { say(`webview request limit: ${(e && e.message) || e}`); } finally { busy = false; }
  };
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (started && e.affectsConfiguration(`agentWorkPlan.${SETTING}`) && cfg().get(SETTING, 'ask') === 'raise') check();
  }));
  return {
    check,
    /* Called by the views once something uses this extension and the window is trusted. */
    start() {
      if (started || !host.trusted()) return;
      started = true;
      const t = setTimeout(() => { timers.delete(t); check(); }, Number.isFinite(opts.delayMs) ? opts.delayMs : START_DELAY_MS);
      timers.add(t);
    },
    async putBack() {
      if (!host.trusted()) {
        vscode.window.showInformationMessage('Agent Work Plan: in Restricted Mode VS Code\'s files are left alone. Trust the workspace first.');
        return;
      }
      if (!vscode.workspace.fs || !vscode.env.appRoot) return;
      const at = where();
      const high = (await webviewLimit.find(at)).filter((i) => i.limit === webviewLimit.NEW);
      await cfg().update(SETTING, 'leave', vscode.ConfigurationTarget.Global);
      if (!high.length) { vscode.window.showInformationMessage('Agent Work Plan: VS Code\'s request limit is already 32.'); return; }
      const failed = await change(at, high, webviewLimit.NEW, webviewLimit.OLD);
      if (failed.length < high.length) {
        vscode.window.showInformationMessage('Agent Work Plan: VS Code\'s request limit is back to 32 and will stay there. Quit and reopen VS Code for this to apply.');
      }
      if (failed.length) await stuck(failed);
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } }
    },
  };
}

module.exports = { create, SETTING, ASKED_KEY, START_DELAY_MS };
