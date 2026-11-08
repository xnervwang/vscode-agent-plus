// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The whole suite, with no dependencies. Run it after every change:
 *
 *   node test/check.js            every part
 *   node test/check.js answers    only the parts whose file name contains "answers"
 *
 * Each file in test/parts/ is one subject and runs in file-name order. A part exports a function taking the shared
 * harness (ok, bad, note, eq, tmp, root, wait); a part that cannot run here says so with note() rather than passing
 * silently, and the count of those is printed with the total.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let passed = 0, failures = 0, skipped = 0;
const ok = (msg) => { passed++; console.log('  ok    ' + msg); };
const bad = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const note = (msg) => { skipped++; console.log('  note  ' + msg); };
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok(msg); else bad(`${msg}: got ${g}, want ${w}`);
};
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-plan-check-')));
/* Nothing a check runs may reach the real home folder: the shared folder (src/files.js) and every other path derived
   from the home folder point into the scratch folder. */
process.env.AGENT_WORK_PLAN_HOME = path.join(scratch, 'shared-home');
process.env.HOME = process.env.USERPROFILE = path.join(scratch, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
let n = 0;
/** A fresh empty directory for one check, removed with the rest when the suite ends. */
const tmp = (name = 'd') => { const d = path.join(scratch, `${++n}-${name}`); fs.mkdirSync(d, { recursive: true }); return d; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const only = process.argv[2] || '';
(async () => {
  const dir = path.join(__dirname, 'parts');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    if (only && !f.includes(only)) continue;
    console.log(`\n── ${f.replace(/\.js$/, '')}`);
    try {
      await require(path.join(dir, f))({ ok, bad, note, eq, tmp, root, wait });
    } catch (e) {
      bad(`${f} threw: ${e && e.stack || e}`);
    }
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* left for the OS */ }
  console.log(`\n${passed} passed, ${failures} failed, ${skipped} could not run here`);
  process.exit(failures ? 1 : 0);
})();
