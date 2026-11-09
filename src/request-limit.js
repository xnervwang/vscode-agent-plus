// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's limit on the requests webview tabs can have in flight (src/webview-limit.js), looked at a few seconds after
 * the views start so the window is not held up, and only in a trusted window. It asks once for each new VS Code build
 * or, if agentPlus.webviewRequestLimit says so, raises the limit again without asking. On Linux it never raises on
 * its own: VS Code added the limit there because too many open files can crash a window. From the request limit part of
 * extension.js in vscode-claude-code-extras bb28f51, and src/request-limit.js of vscode-codex-extras, which this
 * replaces in both.
 *
 * Raising and putting back are the same kind of operation and run one at a time, each carrying the number of the
 * decision it belongs to. Putting back, or turning the setting off, raises that number, so a raise still waiting on the
 * reader or on the client's file system writes nothing when it finally gets its turn.
 *
 * Several windows of this machine come back at once after a VS Code update, which is the moment the limit is reset, so
 * the question is asked by whichever of them creates the marker file in the shared folder. That is a real exclusive
 * create: the shared folder is on the machine this extension runs on, not on the client.
 */
const fs = require('fs');
const path = require('path');
const webviewLimit = require('./webview-limit');
const { sharedHome, privateDir } = require('./files');

const SETTING = 'webviewRequestLimit';
const ASKED_KEY = 'agentPlus.webviewLimitAsked';
const START_DELAY_MS = 8000;

function place(vscode) {
  const local = !vscode.env.remoteName;
  let commit = '';
  try { commit = String(JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).commit || ''); } catch (_) { /* unknown */ }
  return { fs: vscode.workspace.fs, local, appRoot: vscode.env.appRoot, commit,
    at: local ? (p) => vscode.Uri.file(p) : (p) => vscode.Uri.from({ scheme: 'vscode-local', path: p }) };
}

/*
 * Whether this window is the one to ask about VS Code build `commit`. True for the window that creates the marker, and
 * for every window when the folder cannot be written at all: a question nobody asks leaves a reader with blank webview
 * tabs and nothing said about why.
 */
function claimAsk(commit, home) {
  const dir = path.join(home || sharedHome(), 'asked');
  try { privateDir(dir); } catch (_) { return true; }
  try {
    fs.closeSync(fs.openSync(path.join(dir, encodeURIComponent(commit || 'unknown')), 'wx', 0o600));
    return true;
  } catch (e) {
    return !e || e.code !== 'EEXIST';
  }
}

/* `host` is what src/host.js passes: vscode, context, say, trusted(). `opts.where` replaces place(), `opts.home` the
   shared folder, for tests. */
function create(host, opts = {}) {
  const { vscode, context, say } = host;
  const cfg = () => vscode.workspace.getConfiguration('agentPlus');
  const where = () => (opts.where ? opts.where() : place(vscode));
  const look = (at) => webviewLimit.find(Object.assign({}, at, { repair: true, timing: opts.timing }));
  const timers = new Set();
  const subs = [];
  /*
   * Which decision is the current one, and which kind it was. An operation takes a number before it waits for its turn
   * and writes nothing once a later one has been taken: a raise that is still waiting on the reader, or on the client's
   * file system, must not put the limit back up after the reader has restored it or turned the setting off. Only a
   * raise is cancelled by the setting going to `leave`, because putting back writes `leave` itself as its first step.
   */
  let decision = 0, doing = '';
  let running = Promise.resolve();
  const serial = (fn) => {
    const next = running.then(fn, fn);
    running = next.then(() => {}, () => {});
    return next;
  };
  const begin = (what) => { doing = what; return ++decision; };
  const dropped = (mine) => mine !== decision;
  const cancelRaise = () => { if (doing === 'raise') decision++; };
  /* `done` counts the installs actually changed, so a change dropped part way (or before it began) is not reported as
     made: the one that dropped it says what it did itself. */
  const change = async (at, installs, from, to, mine) => {
    const failed = [];
    let done = 0;
    for (const i of installs) {
      if (dropped(mine)) { say(`webview request limit: ${from} -> ${to} dropped, it is no longer wanted`); return { failed, done }; }
      const why = await webviewLimit.setLimit(at.fs, i, from, to, opts.timing);
      say(`webview request limit: ${i.root} ${from} -> ${to}: ${why || 'done'}`);
      if (why) failed.push({ install: i, why }); else done++;
    }
    return { failed, done };
  };
  /* The command that makes the same change by hand has to be the one this operation was trying to make: offering
     32 -> 1000000 to someone whose restore failed sends them the wrong way. */
  const stuck = async (failed, from, to) => {
    if (failed[0].why === 'locked') {
      vscode.window.showWarningMessage('Agent Plus: another window is changing VS Code\'s request limit. Try again in a minute.');
      return;
    }
    const how = webviewLimit.byHand(failed[0].install, process.platform, from, to);
    const why = /NoPermissions|EACCES|EPERM/.test(failed[0].why) ? 'no permission to write the file' : failed[0].why;
    if (await vscode.window.showWarningMessage(`Agent Plus: could not change VS Code's request limit (${why}). To change it yourself: ${how}`,
      'Copy the command') === 'Copy the command') await vscode.env.clipboard.writeText(how);
  };
  /* What find() came back with, as three different things: no installation located at all, one whose file does not
     name the limit the way this build knows, and the limits actually read. */
  const tell = (installs) => {
    if (!installs.length) return 'no installation found';
    return installs.map((i) => `${i.root} = ${i.limit === null ? 'the file does not name the limit once' : i.limit}`
      + (i.lost ? ` (the file is missing and could not be put back: ${i.lost})` : i.restored ? ' (put back from the copy beside it)' : '')).join('; ');
  };
  let started = false, checking = false;
  const checkOnce = async (mine) => {
    const mode = cfg().get(SETTING, 'ask');
    if (mode === 'leave' || !host.trusted() || !vscode.workspace.fs || !vscode.env.appRoot) return;
    const at = where();
    const installs = await look(at);
    say('webview request limit: ' + tell(installs));
    const low = installs.filter((i) => i.limit === webviewLimit.OLD);
    if (!low.length) return;
    const linux = low.every((i) => webviewLimit.platformOf(i.root, process.platform) === 'linux');
    if (mode !== 'raise' || linux) {
      if (context.globalState.get(ASKED_KEY, '') === at.commit) return;
      if (!claimAsk(at.commit, opts.home)) {
        say('webview request limit: another window of this machine is asking about this VS Code build');
        await context.globalState.update(ASKED_KEY, at.commit);
        return;
      }
      await context.globalState.update(ASKED_KEY, at.commit);
      const always = 'Raise it, now and after updates', once = 'Raise it this time', no = 'Leave it';
      const pick = await vscode.window.showInformationMessage(
        'Agent Plus: VS Code lets webview tabs, Claude Code\'s and Codex\'s among them, have 32 requests in flight at once '
        + 'across all windows, and a tab can stay blank waiting for one. Raise the limit to 1000000 in VS Code\'s own files?'
        + (linux ? ' VS Code added the limit for Linux, where too many open files can crash a window.' : ''),
        ...(linux ? [once, no] : [always, once, no]));
      if (pick === no) { cancelRaise(); await cfg().update(SETTING, 'leave', vscode.ConfigurationTarget.Global); return; }
      if (pick !== always && pick !== once) return;
      if (pick === always) await cfg().update(SETTING, 'raise', vscode.ConfigurationTarget.Global);
    }
    if (dropped(mine)) { say('webview request limit: the check was dropped, it is no longer wanted'); return; }
    /* Read again: the reader took their time, and in the meantime another window may have raised it, or VS Code may
       have been updated under us. */
    const again = (await look(at)).filter((i) => i.limit === webviewLimit.OLD);
    if (!again.length) { say('webview request limit: nothing left at ' + webviewLimit.OLD); return; }
    const { failed, done } = await change(at, again, webviewLimit.OLD, webviewLimit.NEW, mine);
    if (done) {
      vscode.window.showInformationMessage('Agent Plus: VS Code\'s request limit is now 1000000. Quit and reopen VS Code for this to apply.');
    }
    if (failed.length) await stuck(failed, webviewLimit.OLD, webviewLimit.NEW);
  };
  const check = () => {
    if (checking) return running;
    checking = true;
    const mine = begin('raise');
    return serial(async () => {
      try { await checkOnce(mine); } catch (e) { say(`webview request limit: ${(e && e.message) || e}`); } finally { checking = false; }
    });
  };
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!started || !e.affectsConfiguration(`agentPlus.${SETTING}`)) return;
    const mode = cfg().get(SETTING, 'ask');
    if (mode === 'raise') check(); else cancelRaise();
  }));
  const putBackOnce = async (mine) => {
    if (!host.trusted()) {
      vscode.window.showInformationMessage('Agent Plus: in Restricted Mode VS Code\'s files are left alone. Trust the workspace first.');
      return;
    }
    if (!vscode.workspace.fs || !vscode.env.appRoot) return;
    const at = where();
    const installs = await look(at);
    say('webview request limit: putting back, ' + tell(installs));
    await cfg().update(SETTING, 'leave', vscode.ConfigurationTarget.Global);
    const high = installs.filter((i) => i.limit === webviewLimit.NEW);
    if (!high.length) {
      /* Three different answers, where saying "already 32" for all of them would be a claim about a file nobody read. */
      if (!installs.length) {
        vscode.window.showWarningMessage('Agent Plus: the VS Code installation this window belongs to could not be found on '
          + 'the client, so its request limit was left alone. It will not be raised again.');
      } else if (installs.every((i) => i.limit === webviewLimit.OLD)) {
        vscode.window.showInformationMessage('Agent Plus: VS Code\'s request limit is already 32.');
      } else {
        vscode.window.showWarningMessage(`Agent Plus: VS Code's request limit is not ${webviewLimit.NEW} (${tell(installs)}), `
          + 'so it was left alone. It will not be raised again.');
      }
      return;
    }
    const { failed, done } = await change(at, high, webviewLimit.NEW, webviewLimit.OLD, mine);
    if (done) {
      vscode.window.showInformationMessage('Agent Plus: VS Code\'s request limit is back to 32 and will stay there. Quit and reopen VS Code for this to apply.');
    }
    if (failed.length) await stuck(failed, webviewLimit.NEW, webviewLimit.OLD);
  };
  return {
    check,
    /* Called by the views once something uses this extension and the window is trusted. */
    start() {
      if (started || !host.trusted()) return;
      started = true;
      const t = setTimeout(() => { timers.delete(t); check(); }, Number.isFinite(opts.delayMs) ? opts.delayMs : START_DELAY_MS);
      timers.add(t);
    },
    /* Raises the decision number before waiting for its turn, so a raise already under way gives up rather than
       putting back what this is about to undo. */
    putBack() {
      const mine = begin('putBack');
      return serial(async () => {
        try { await putBackOnce(mine); } catch (e) { say(`webview request limit: ${(e && e.message) || e}`); }
      });
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } }
    },
  };
}

module.exports = { create, claimAsk, SETTING, ASKED_KEY, START_DELAY_MS };
