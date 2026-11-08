// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Writing files other processes and other windows read at any moment: always whole, through a temporary file renamed
 * into place, so a reader never sees half of one. writeAtomic() comes from src/claude-files.js of
 * vscode-claude-code-extras bb28f51.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/*
 * The folder every window of every VS Code product on this machine shares: answers in flight and the lock on VS Code's
 * request limit. It belongs to no editor, so VS Code Stable and Insiders, and the window of each, find the same one.
 * AGENT_WORK_PLAN_HOME moves it, for tests.
 */
function sharedHome() {
  return process.env.AGENT_WORK_PLAN_HOME || path.join(os.homedir(), '.agent-work-plan');
}

/* Creates `dir` and its parents readable by this user alone, and tightens one that exists with wider permissions. An
   answer is whatever the person typed, which can be anything. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return dir;
  const home = sharedHome();
  for (const d of [home, dir]) {
    if (d !== dir && !dir.startsWith(d + path.sep)) continue;
    try {
      const st = fs.statSync(d);
      if ((st.mode & 0o077) !== 0 && st.uid === process.getuid()) fs.chmodSync(d, 0o700);
    } catch (_) { /* checked again next time */ }
  }
  return dir;
}

module.exports = { writeAtomic, sharedHome, privateDir };
