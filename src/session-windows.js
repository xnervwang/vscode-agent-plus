// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which conversations the other VS Code windows on this machine show, for the session list's "open elsewhere". Each
 * source extension already writes the conversations it shows in its window to <its plan dir>/windows/<pid>.json
 * (shared/host/window-entries.js), with the window's name (a remote window's carries its host); this reads those
 * files for every source rather than have each window write a second one. An entry older than STALE_MS, or whose
 * process is gone, is a window that closed.
 */
const fs = require('fs');
const path = require('path');

const WINDOWS_DIR = 'windows';
const STALE_MS = 120000;

const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/*
 * `dirs` is [{ sourceId, planDir }]. Returns key (JSON of [sourceId, sessionId]) -> [{ pid, name }] for the windows
 * other than this process that show it.
 */
function elsewhere(dirs, { self = process.pid, now = Date.now(), alive = alivePid } = {}) {
  const out = new Map();
  for (const { sourceId, planDir } of dirs || []) {
    if (!planDir) continue;
    const dir = path.join(planDir, WINDOWS_DIR);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { continue; }
    for (const n of names) {
      const pid = Number(n.slice(0, -5));
      if (pid === self) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
      if (!d || typeof d !== 'object' || !(now - d.at < STALE_MS) || !Array.isArray(d.sessions) || !alive(pid)) continue;
      const where = { pid, name: typeof d.name === 'string' ? d.name.slice(0, 120) : '' };
      for (const id of d.sessions) {
        if (typeof id !== 'string' || !id) continue;
        const k = JSON.stringify([String(sourceId), id]);
        if (!out.has(k)) out.set(k, []);
        if (!out.get(k).some((w) => w.pid === pid)) out.get(k).push(where);
      }
    }
  }
  return out;
}

/* 'the VS Code window "proj [SSH: host]"', for the hover and a refusal. */
const windowLabel = (w) => `the VS Code window ${w.name ? `"${w.name}"` : `(process ${w.pid})`}`;

module.exports = { elsewhere, windowLabel, WINDOWS_DIR, STALE_MS };
