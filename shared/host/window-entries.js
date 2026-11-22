// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/window-entries.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * What each VS Code window of an extension shows, as an entry <plan dir>/windows/<pid>.json the window rewrites when
 * that changes and once a minute besides. The other windows read these entries to leave alone what one of them shows:
 * a conversation open in another window is not deleted or swept away from here.
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./files');

const WINDOWS_DIR = 'windows';
/* An entry older than this counts as a window that is gone; a window rewrites its own every half of it. */
const STALE_MS = 120000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const entryFile = (planDir, pid) => path.join(planDir, WINDOWS_DIR, `${pid}.json`);

/*
 * This window's writer. `entry()` returns { name, folders, sessions } and any other fields; the call writes it when it
 * differs from the last one written or the last write is half of STALE_MS old, and returns whether it wrote.
 */
function publisher(planDir, entry, { pid = process.pid, log = () => {} } = {}) {
  let written = '', writtenAt = 0;
  return (now = Date.now()) => {
    let text;
    try { text = JSON.stringify(Object.assign({ pid }, entry())); } catch (e) { log(`window entry: ${(e && e.message) || e}`); return false; }
    if (text === written && now - writtenAt < STALE_MS / 2) return false;
    try {
      fs.mkdirSync(path.join(planDir, WINDOWS_DIR), { recursive: true });
      writeAtomic(entryFile(planDir, pid), JSON.stringify(Object.assign({ at: now }, JSON.parse(text))) + '\n');
      written = text; writtenAt = now;
      return true;
    } catch (e) { log(`window entry: ${(e && e.message) || e}`); return false; }
  };
}

/* Removes this window's entry, as its extension stops. */
function withdraw(planDir, pid = process.pid) {
  try { fs.unlinkSync(entryFile(planDir, pid)); } catch (_) { /* never written */ }
}

/* The fresh entries of the other windows whose process is alive, as [{ pid, name, folders, sessions, ... }]. */
function others(planDir, { self = process.pid, now = Date.now(), alive = alivePid } = {}) {
  let names = [];
  try { names = fs.readdirSync(path.join(planDir, WINDOWS_DIR)).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const pid = Number(n.slice(0, -5));
    if (pid === self) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(planDir, WINDOWS_DIR, n), 'utf8')); } catch (_) { continue; }
    if (!d || typeof d !== 'object' || !(now - d.at < STALE_MS) || !alive(pid)) continue;
    out.push(Object.assign({}, d, { pid, name: typeof d.name === 'string' ? d.name : '', folders: Array.isArray(d.folders) ? d.folders : [],
      sessions: Array.isArray(d.sessions) ? d.sessions.filter((s) => typeof s === 'string') : [] }));
  }
  return out;
}

/* The conversations other windows show, as id -> the names of those windows ('untitled' for a window with none). */
function shownElsewhere(planDir, { self, now, alive, id = ID } = {}) {
  const out = new Map();
  for (const w of others(planDir, { self, now, alive })) {
    const label = w.name || 'untitled';
    for (const s of w.sessions) {
      if (!id.test(s)) continue;
      if (!out.has(s)) out.set(s, []);
      if (!out.get(s).includes(label)) out.get(s).push(label);
    }
  }
  return out;
}

module.exports = { publisher, withdraw, others, shownElsewhere, WINDOWS_DIR, STALE_MS };
