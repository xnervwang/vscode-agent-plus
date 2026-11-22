// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Bringing a conversation to the front from a window that does not have it open: the window asks, and the window that
 * has it brings the conversation to the front.
 *
 * A request is a file in OPEN_DIR under sharedHome(), which every window of every VS Code product on this machine
 * reads, as answers are (src/answers.js). A window that shows the conversation takes the request by renaming
 * <id>.json to <id>.taken, which only one window can do, has the source reveal the conversation, brings its own window
 * to the front with VS Code's command line, and writes <id>.done. The asking window waits for that file and withdraws a
 * request nobody took by renaming it to <id>.gone, so that no window takes it after the asker has said nobody had the
 * conversation.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic, sharedHome } = require('./files');

const OPEN_DIR = 'open';
const FORMAT = 1;
/* How long an asking window waits for another to take its request. */
const WAIT_MS = 5000;
/* Files older than this are deleted. */
const KEEP_MS = 600000;
const NAME = /^[0-9a-z]+-[0-9a-f]{8}$/;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * `here(sourceId, sessionId)` answers whether this window shows that conversation;
 * `reveal(sourceId, sessionId, row)` brings it to the front in this window and resolves true when it did; `front()`
 * brings this window itself to the front.
 */
function createWindowOpen({ dir = path.join(sharedHome(), OPEN_DIR), windowId, here, reveal, front = () => {}, now = Date.now,
  waitMs = WAIT_MS, every = 200, log = () => {} }) {
  let closed = false;

  /* Resolves 'here', 'there' (another window took it) or 'nowhere'. */
  async function open(target) {
    const row = { title: String(target.title || ''), cwd: String(target.cwd || '') };
    let shown = false;
    try { shown = (await reveal(target.sourceId, target.sessionId, row)) === true; } catch (_) { shown = false; }
    if (shown) return 'here';
    const id = `${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const file = (ext) => path.join(dir, id + ext);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(file('.json'), JSON.stringify({ format: FORMAT, at: now(), from: windowId, sourceId: target.sourceId,
        sessionId: target.sessionId, title: row.title, cwd: row.cwd }) + '\n', 0o600);
    } catch (e) { log('open: writing the request: ' + ((e && e.message) || e)); return 'nowhere'; }
    const end = now() + waitMs;
    while (now() < end && !closed) {
      if (fs.existsSync(file('.done'))) return 'there';
      await sleep(every);
    }
    if (fs.existsSync(file('.done'))) return 'there';
    try { fs.renameSync(file('.json'), file('.gone')); return 'nowhere'; } catch (_) {
      /* Taken in the last moment: it is being brought to the front. */
      return 'there';
    }
  }

  /* Takes the requests for conversations this window shows. Called on a change in the folder and on a timer. */
  async function take() {
    if (closed) return 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return 0; }
    let taken = 0;
    for (const n of names) {
      const full = path.join(dir, n);
      const id = n.replace(/\.(json|taken|done|gone)$/, '');
      if (!NAME.test(id)) continue;
      let st = null;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (now() - st.mtimeMs > KEEP_MS) { try { fs.unlinkSync(full); } catch (_) { /* gone */ } continue; }
      if (!n.endsWith('.json')) continue;
      const r = readJson(full);
      if (!r || r.format !== FORMAT || r.from === windowId || typeof r.sourceId !== 'string' || typeof r.sessionId !== 'string') continue;
      if (now() - r.at > waitMs) continue;
      let mine = false;
      try { mine = here(r.sourceId, r.sessionId) === true; } catch (_) { mine = false; }
      if (!mine) continue;
      try { fs.renameSync(full, path.join(dir, id + '.taken')); } catch (_) { continue; }
      let shown = false;
      try { shown = (await reveal(r.sourceId, r.sessionId, { title: String(r.title || ''), cwd: String(r.cwd || '') })) === true; } catch (_) { shown = false; }
      if (shown) { try { front(); } catch (e) { log('open: bringing this window to the front: ' + ((e && e.message) || e)); } }
      try { writeAtomic(path.join(dir, id + '.done'), JSON.stringify({ format: FORMAT, at: now(), by: windowId, shown }) + '\n', 0o600); } catch (_) { /* it says nobody had it */ }
      taken++;
    }
    return taken;
  }

  return { open, take, dispose() { closed = true; } };
}

/*
 * Brings this window to the front. VS Code gives an extension no call for that, but its command line opening the
 * window's own folder or workspace file focuses the window that has it open. In a remote window the command line is
 * the one the remote server provides, which asks the local VS Code to do the same.
 */
function bringToFront(vscode, log = () => {}) {
  const cp = require('child_process');
  const ws = vscode.workspace.workspaceFile;
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const target = ws && ws.scheme !== 'untitled' ? ws : (!ws && folder ? folder.uri : null);
  if (!target || target.scheme !== 'file') return false;
  const name = process.platform === 'win32' ? 'code.cmd' : 'code';
  const root = vscode.env.appRoot || '';
  /* A remote server keeps it in its root, the macOS app under appRoot, and the Linux and Windows desktop builds two
     levels up, beside resources/app. */
  const cli = [path.join(root, 'bin', 'remote-cli', name), path.join(root, 'bin', name), path.join(root, '..', '..', 'bin', name)]
    .find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!cli) { log('open: no command line found to bring this window to the front'); return false; }
  cp.execFile(cli, [target.fsPath], { timeout: 15000, shell: process.platform === 'win32', windowsHide: true },
    (e) => { if (e) log('open: bringing this window to the front: ' + e.message); });
  return true;
}

module.exports = { createWindowOpen, bringToFront, OPEN_DIR, WAIT_MS, KEEP_MS };
