// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's limit on the requests webview tabs can have in flight (src/webview-limit.js), looked at a few seconds after
 * the views start so the window is not held up, and only in a trusted window. It asks once for each new VS Code build
 * on each client or, if agentPlus.webviewRequestLimit says so, raises the limit again without asking. On Linux it never
 * raises on its own: VS Code added the limit there because too many open files can crash a window. From the request
 * limit part of extension.js in vscode-claude-code-extras bb28f51, and src/request-limit.js of vscode-codex-extras,
 * which this replaces in both.
 *
 * Raising and putting back are the same kind of operation and run one at a time, each carrying the number of the
 * decision it belongs to. Putting back, or turning the setting off, raises that number, so a raise still waiting on the
 * reader or on the client's file system writes nothing when it finally gets its turn.
 *
 * Several windows of this machine come back at once after a VS Code update, which is the moment the limit is reset, so
 * the question is asked by whichever of them creates the marker file in the shared folder. That is a real exclusive
 * create: the shared folder is on the machine this extension runs on, not on the client. The same kind of file is the
 * lock these windows take turns with before any of them writes beside the client's service worker (holdMachine).
 *
 * Every start looks at the file whatever the setting says, because a change that failed part way can leave it missing,
 * and a setting of `leave` is often what that failed change had just written.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const webviewLimit = require('./webview-limit');
const { sharedHome, privateDir } = require('./files');

const SETTING = 'webviewRequestLimit';
const ASKED_KEY = 'agentPlus.webviewLimitAsked';
const START_DELAY_MS = 8000;
const HOLD_FILE = 'webview-limit.lock';
/* A hold older than this was left by a window that died holding it; one whose process is gone on this machine is
   taken over at once. Holding it covers one change, which waits at most about ten seconds for the lock beside the
   file. */
const HOLD_STALE_MS = 120000;
const HOLD_TRIES = 40;
const HOLD_POLL_MS = 250;
const COPY_BUTTON = 'Copy the command';
const EDIT_BUTTON = 'Change It in an Editor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};

/* Removes the hold in `file` when the window that made it is gone, and says whether it did. */
function dropStale(file) {
  let text, st;
  try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch (_) { return true; }
  let who = null;
  try { who = JSON.parse(text); } catch (_) { who = null; }
  const age = Date.now() - (who && Number.isFinite(who.at) ? who.at : st.mtimeMs);
  /* A file just created and not yet written reads as empty, and is someone's hold being taken. */
  const gone = who && who.host === os.hostname() && Number.isInteger(who.pid) && !alive(who.pid);
  if (!gone && age <= HOLD_STALE_MS) return false;
  try {
    if (fs.readFileSync(file, 'utf8') !== text) return false;
    fs.unlinkSync(file);
  } catch (_) { /* taken over meanwhile */ }
  return true;
}

/*
 * Runs `fn` holding the lock this machine's windows take turns with before writing beside the client's service worker.
 * Resolves to fn()'s result, or 'locked' when another window kept it throughout. A shared folder that cannot be
 * written means there is no such lock, and fn() runs with only the lock beside the file.
 */
async function holdMachine(home, fn, { wait = sleep } = {}) {
  const dir = home || sharedHome();
  const file = path.join(dir, HOLD_FILE);
  const me = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try { privateDir(dir); } catch (_) { return fn(); }
  let held = false;
  for (let i = 0; i < HOLD_TRIES && !held; i++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return fn();
      if (!dropStale(file)) await wait(HOLD_POLL_MS);
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ holder: me, pid: process.pid, host: os.hostname(), at: Date.now() }));
      held = true;
    } catch (_) {
      try { fs.unlinkSync(file); } catch (__) { /* gone already */ }
    } finally {
      try { fs.closeSync(fd); } catch (_) { /* closed */ }
    }
    if (!held) return fn();
  }
  if (!held) return 'locked';
  try {
    return await fn();
  } finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).holder === me) fs.unlinkSync(file); } catch (_) { /* gone already */ }
  }
}

function place(vscode) {
  const local = !vscode.env.remoteName;
  let commit = '';
  try { commit = String(JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).commit || ''); } catch (_) { /* unknown */ }
  return { fs: vscode.workspace.fs, local, appRoot: vscode.env.appRoot, commit,
    at: local ? (p) => vscode.Uri.file(p) : (p) => vscode.Uri.from({ scheme: 'vscode-local', path: p }) };
}

/*
 * What being asked is recorded under: the VS Code build, and which client and which installations on it. The marker is
 * in this machine's shared folder, which every client connected to this machine finds, so the build alone would let
 * the first client asked stand for all of them. Windows of one client coming back at once still share one.
 */
function askKeyOf(commit, machineId, roots) {
  const who = crypto.createHash('sha256').update(String(machineId || '') + '\n' + roots.slice().sort().join('\n')).digest('hex').slice(0, 16);
  return `${commit || 'unknown'}.${who}`;
}

/*
 * Whether this window is the one to ask under `key` (askKeyOf). True for the window that creates the marker, and for
 * every window when the folder cannot be written at all: a question nobody asks leaves a reader with blank webview tabs
 * and nothing said about why.
 */
function claimAsk(key, home) {
  const dir = path.join(home || sharedHome(), 'asked');
  try { privateDir(dir); } catch (_) { return true; }
  try {
    fs.closeSync(fs.openSync(path.join(dir, encodeURIComponent(key || 'unknown')), 'wx', 0o600));
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
  const timing = Object.assign({}, opts.timing, { hold: (run) => holdMachine(opts.home, run, opts.timing) });
  const look = (at) => webviewLimit.find(Object.assign({}, at, { repair: true, timing }));
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
    const gone = () => { say(`webview request limit: ${from} -> ${to} dropped, it is no longer wanted`); return { failed, done }; };
    /* Asked again inside the change, right up to the rename: a raise can spend seconds waiting on the lock and on the
       client's file system, and the reader can turn the setting off or close the window in that time. */
    const own = Object.assign({}, timing, { wanted: () => !dropped(mine) });
    for (const i of installs) {
      if (dropped(mine)) return gone();
      const why = await webviewLimit.setLimit(at.fs, i, from, to, own);
      say(`webview request limit: ${i.root} ${from} -> ${to}: ${why || 'done'}`);
      if (why === 'dropped') return gone();
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
    const denied = /NoPermissions|EACCES|EPERM/.test(failed[0].why);
    const why = denied ? 'no permission to write the file' : failed[0].why;
    /* The desktop app can retry an editor's save of a file on the client with the reader's password; the web one cannot. */
    const web = vscode.UIKind && vscode.env.uiKind === vscode.UIKind.Web;
    const editable = denied && !web && typeof vscode.workspace.openTextDocument === 'function';
    const pick = await vscode.window.showWarningMessage(`Agent Plus: could not change VS Code's request limit (${why}). To change it yourself: ${how}`,
      ...(editable ? [EDIT_BUTTON, COPY_BUTTON] : [COPY_BUTTON]));
    if (pick === COPY_BUTTON) await vscode.env.clipboard.writeText(how);
    else if (pick === EDIT_BUTTON) await editInEditor(failed[0].install, from, to);
  };
  const editInEditor = async (install, from, to) => {
    try {
      const doc = await vscode.workspace.openTextDocument(install.uri);
      const text = doc.getText();
      const was = `${webviewLimit.NAME}=${from},`;
      const at = text.indexOf(was);
      if (at < 0 || text.indexOf(was, at + 1) >= 0) {
        vscode.window.showWarningMessage(`Agent Plus: the file no longer names the request limit ${from} once, so nothing was changed.`);
        return;
      }
      const range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + was.length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, range, `${webviewLimit.NAME}=${to},`);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('the editor did not take the change');
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (editor && typeof editor.revealRange === 'function') editor.revealRange(range);
      say(`webview request limit: ${install.root} ${from} -> ${to} made in an editor, left for the reader to save`);
      vscode.window.showInformationMessage(`Agent Plus: the request limit reads ${to} in the editor; save the file, choose Retry as Root `
        + '(or Retry as Admin) when VS Code offers it, enter your password, then quit and reopen VS Code.');
    } catch (e) {
      vscode.window.showWarningMessage(`Agent Plus: could not open the file to change the request limit (${(e && e.message) || e}).`);
    }
  };
  /* A failed replacement can leave the file missing, and nothing else puts it back until the next start, so that is
     done before the reader is told; the command to make the change by hand also needs the file to be there. */
  const recover = async (at, failed, from, to) => {
    const again = await look(at);
    if (again.some((i) => i.restored)) say('webview request limit: after the failure, ' + tell(again));
    await stuck(failed, from, to);
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
    if (!host.trusted() || !vscode.workspace.fs || !vscode.env.appRoot) return;
    const at = where();
    const installs = await look(at);
    say('webview request limit: ' + tell(installs));
    const mode = cfg().get(SETTING, 'ask');
    if (mode === 'leave') return;
    const low = installs.filter((i) => i.limit === webviewLimit.OLD);
    if (!low.length) return;
    const linux = low.every((i) => webviewLimit.platformOf(i.root, process.platform) === 'linux');
    if (mode !== 'raise' || linux) {
      const asked = askKeyOf(at.commit, vscode.env.machineId, low.map((i) => i.root));
      /* globalState is kept by the client, so a value an earlier version wrote, the build alone, still means that this
         client was asked about this build. */
      const had = context.globalState.get(ASKED_KEY, '');
      if (had === asked || (had && had === at.commit)) return;
      if (!claimAsk(asked, opts.home)) {
        say('webview request limit: another window of this client is asking about this VS Code build');
        await context.globalState.update(ASKED_KEY, asked);
        return;
      }
      await context.globalState.update(ASKED_KEY, asked);
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
    if (failed.length) await recover(at, failed, webviewLimit.OLD, webviewLimit.NEW);
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
    if (failed.length) await recover(at, failed, webviewLimit.NEW, webviewLimit.OLD);
  };
  return {
    check,
    /* Whether an installation this window belongs to reads 1000000. Reads only, and false in Restricted Mode. */
    async raised() {
      if (!host.trusted() || !vscode.workspace.fs || !vscode.env.appRoot) return false;
      try {
        return (await webviewLimit.find(Object.assign({}, where(), { repair: false }))).some((i) => i.limit === webviewLimit.NEW);
      } catch (_) { return false; }
    },
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
    /* A raise under way stops before it replaces the file: nobody is left to tell about it. A put-back goes on, since
       the reader asked for it and `leave` is already written. */
    dispose() {
      cancelRaise();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } }
    },
  };
}

module.exports = { create, claimAsk, askKeyOf, holdMachine, SETTING, ASKED_KEY, START_DELAY_MS, HOLD_FILE, HOLD_STALE_MS };
