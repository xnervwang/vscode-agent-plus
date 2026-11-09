// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's webview request limit when things happen at the same moment: two windows that both believe they hold the
 * lock, a put-back that fails half way, the setting turned off while a raise is under way, and VS Code updated between
 * the read and the replacement. Each check stops a window at a given step of the client's file system
 * (test/limit-fs.js), so the order is the same on every run.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');
const { client } = require('../limit-fs');

module.exports = async ({ eq, root, tmp }) => {
  const wl = require(path.join(root, 'src', 'webview-limit.js'));
  const APP = '/opt/code/resources/app';
  const PRODUCT = `${APP}/product.json`;
  const SW = `${APP}/${wl.SW}`;
  const LOCK = SW + wl.LOCK_SUFFIX;
  const KEY = 'agentPlus.webviewRequestLimit';
  const text = (n, v = '') => `a();${v}${wl.NAME}=${n},b();`;
  const named = (s) => (typeof s === 'string' ? [...s.matchAll(new RegExp(wl.NAME + '=(\\d+),', 'g'))].length : 0);
  const copies = (files) => Object.keys(files).filter((f) => f.startsWith(SW + wl.BACKUP_SUFFIX) && !f.endsWith('.tmp'));
  /* What the reader must never be left without: the file as VS Code can use it, or a whole copy to put it back from. */
  const intact = (files) => named(files[SW]) === 1 || copies(files).some((f) => named(files[f]) === 1);
  const leftovers = (files) => Object.keys(files).filter((f) => /agent-work-plan/.test(f));
  const fast = { wait: async () => {} };
  /* Fires when told to, or after a second regardless, so a check set up wrong fails instead of hanging. */
  const signal = () => { let fire; const p = new Promise((r) => { fire = r; setTimeout(r, 1000); }); return { p, fire }; };

  /* Two windows both hold the lock, as VS Code's non-exclusive rename allows. The first makes its copy, replaces the
     file and removes its copy; the second read the file before that, and its own replacement then fails between the
     delete and the move. After every single step there has to be either a usable file or a whole copy of one. */
  {
    const files = { [PRODUCT]: '{"commit":"abc"}', [SW]: text(32) };
    const meta = new Map(Object.keys(files).map((k) => [k, { mtime: Date.now() }]));
    const broken = [];
    const watch = (op, p) => { if (!intact(files)) broken.push(`${op} ${p.slice(APP.length)}`); };
    const bThere = signal(), aDone = signal();
    let second = null;
    const b = client(files, { meta, gapRename: true, tornRename: (p) => p === SW, remap: (p) => (p === LOCK ? LOCK + '.b' : p), after: watch,
      gate: async (op, p) => { if (op === 'rename' && p === SW) { bThere.fire(); await aDone.p; } } });
    const a = client(files, { meta, gapRename: true, after: watch,
      gate: async (op, p) => {
        if (op === 'rename' && p === SW && !second) {
          second = wl.setLimit(b.fs, { root: APP, uri: b.at(SW) }, 32, wl.NEW, fast);
          await bThere.p;
        }
      } });
    const first = await wl.setLimit(a.fs, { root: APP, uri: a.at(SW) }, 32, wl.NEW, fast);
    aDone.fire();
    const late = await second;
    const [now] = await wl.find({ fs: a.fs, at: a.at, local: true, appRoot: APP, repair: true, timing: fast });
    eq([first, late, broken, now && now.limit], ['', 'EIO', [], 32],
      'two windows holding the lock at once: at every step the file or a whole copy of it is there, and the file comes back');
  }

  /* VS Code updated in place between the read and the replacement: what is there now is not what the new text was
     made from, so it is left as it is. */
  {
    const updated = text(32, 'v2();');
    let c = null, swapped = false;
    c = client({ [SW]: text(32) }, { gapRename: true,
      gate: async (op, p) => {
        if (op === 'writeFile' && /\.agent-work-plan\.[0-9a-z]+\.tmp$/.test(p) && !p.includes('backup') && !swapped) { swapped = true; c.files[SW] = updated; }
      } });
    const why = await wl.setLimit(c.fs, { root: APP, uri: c.at(SW) }, 32, wl.NEW, fast);
    eq([why, c.files[SW], leftovers(c.files)], ['changed', updated, []],
      'a file that changed after it was read is not replaced with text made from the old one');
  }

  /* Copies left by changes that never finished: once the file is usable again, those too old to belong to a change
     still under way are removed, and a young one stays. With the file missing, the newest copy is the one used. */
  {
    const legacy = SW + wl.BACKUP_SUFFIX, aged = SW + wl.BACKUP_SUFFIX + '.aged', young = SW + wl.BACKUP_SUFFIX + '.young';
    const c = client({ [SW]: text(32), [legacy]: text(32), [aged]: text(32), [young]: text(32) });
    c.meta.set(legacy, { mtime: Date.now() - wl.LOCK_STALE_MS - 1000 });
    c.meta.set(aged, { mtime: Date.now() - wl.LOCK_STALE_MS - 1000 });
    await wl.find({ fs: c.fs, at: c.at, local: true, appRoot: APP, repair: true, timing: fast });
    eq(leftovers(c.files).sort(), [legacy, young].sort(),
      'a copy left long ago is removed once the file is usable; a young one, and the one an earlier version made, are left');
    const m = client({ [legacy]: text(32), [young]: text(wl.NEW) });
    m.meta.set(legacy, { mtime: Date.now() - 5000 });
    const [back] = await wl.find({ fs: m.fs, at: m.at, local: true, appRoot: APP, repair: true, timing: fast });
    eq([back && back.restored, m.files[SW]], [true, text(wl.NEW)], 'with the file missing, the newest of several copies is the one put back');
  }

  const { vscode, control } = fake.create();
  const undo = fake.install(vscode);
  fake.fresh(root);
  const limit = require(path.join(root, 'src', 'request-limit.js'));
  vscode.env.appRoot = APP;
  vscode.workspace.fs = {};
  const host = () => ({ vscode, context: { globalState: fake.memento() }, say: (m) => control.state.log.push(m), trusted: () => true });
  const reset = () => { control.state.answers.length = 0; control.state.said.length = 0; control.state.log.length = 0; delete control.state.config[KEY]; };

  /* A put-back writes `leave` first and then replaces the file. When the replacement fails once the original is gone,
     nothing later would put it back while the setting says leave, so it is put back at once. */
  {
    reset();
    let tears = 1;
    const c = client({ [PRODUCT]: '{"commit":"abc"}', [SW]: text(wl.NEW) }, { tornRename: (p) => p === SW && tears-- > 0 });
    const l = limit.create(host(), { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: APP, commit: 'torn' }),
      timing: fast, delayMs: 0, home: tmp('races-home-1') });
    await l.putBack();
    l.dispose();
    eq([named(c.files[SW]), control.state.config[KEY]], [1, 'leave'], 'a put-back that fails once the file is gone puts the file back straight away');
  }

  /* The same missing file found at a later start, with the setting already at leave. */
  {
    reset();
    const c = client({ [PRODUCT]: '{"commit":"abc"}', [SW + wl.BACKUP_SUFFIX]: text(32) });
    control.state.config[KEY] = 'leave';
    const l = limit.create(host(), { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: APP, commit: 'leave' }),
      timing: fast, delayMs: 0, home: tmp('races-home-2') });
    await l.check();
    l.dispose();
    eq(c.files[SW], text(32), 'with the setting at leave, a start still puts back a file that a failed change left missing');
  }

  /* The windows of one machine take turns for certain, through a file in the shared folder made with an exclusive
     create, before any of them writes beside the client's file. */
  {
    const home = tmp('races-hold');
    let inside = 0, most = 0;
    const body = async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 20)); inside--; return 'ran'; };
    const slow = { wait: () => new Promise((r) => setTimeout(r, 5)) };
    const all = await Promise.all([1, 2, 3].map(() => limit.holdMachine(home, body, slow)));
    eq([all, most, fs.existsSync(path.join(home, limit.HOLD_FILE))], [['ran', 'ran', 'ran'], 1, false],
      'three windows of one machine take turns, and the last one leaves no lock behind');
  }
  {
    const home = tmp('races-hold-dead');
    fs.writeFileSync(path.join(home, limit.HOLD_FILE), JSON.stringify({ holder: 'x', pid: 2147483000, host: os.hostname(), at: Date.now() }));
    eq(await limit.holdMachine(home, async () => 'ran', fast), 'ran', 'a lock left by a window whose process is gone is taken over');
  }
  {
    reset();
    const home = tmp('races-hold-live');
    const held = path.join(home, limit.HOLD_FILE);
    fs.writeFileSync(held, JSON.stringify({ holder: 'other', pid: process.pid, host: os.hostname(), at: Date.now() }));
    let ran = false;
    const r = await limit.holdMachine(home, async () => { ran = true; }, fast);
    const c = client({ [PRODUCT]: '{"commit":"abc"}', [SW]: text(wl.NEW) });
    const l = limit.create(host(), { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: APP, commit: 'held' }),
      timing: fast, delayMs: 0, home });
    await l.putBack();
    l.dispose();
    eq([r, ran, c.files[SW], control.state.said.some((m) => /another window is changing/.test(m.message))], ['locked', false, text(wl.NEW), true],
      'while another window of this machine holds it, nothing runs, and a put-back here leaves the file alone and says why');
    fs.unlinkSync(held);
  }
  /* The setting turned to leave while the raise is making its copy: the file is not replaced, and nothing says it was. */
  {
    reset();
    let turned = false;
    const c = client({ [PRODUCT]: '{"commit":"abc"}', [SW]: text(32) }, {
      gate: async (op, p) => {
        if (op === 'writeFile' && p.includes(wl.BACKUP_SUFFIX) && !turned) { turned = true; control.state.config[KEY] = 'leave'; control.changeConfig([KEY]); }
      } });
    control.answer('Raise the limit to 1000000', 'Raise it this time');
    const l = limit.create(host(), { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: APP, commit: 'cancel' }),
      timing: fast, delayMs: 3600e3, home: tmp('races-home-3') });
    l.start();
    await l.check();
    l.dispose();
    eq([turned, c.files[SW], control.state.said.some((s) => /is now 1000000/.test(s.message))], [true, text(32), false],
      'turning the setting to leave while a raise is making its copy stops it before the file is replaced');
  }
  /* The window closing while a raise is making its copy: nobody is left to be told, and the file is left as it was. */
  {
    reset();
    let l = null, closed = false;
    const c = client({ [PRODUCT]: '{"commit":"abc"}', [SW]: text(32) }, {
      gate: async (op, p) => { if (op === 'writeFile' && p.includes(wl.BACKUP_SUFFIX) && !closed) { closed = true; l.dispose(); } } });
    control.answer('Raise the limit to 1000000', 'Raise it this time');
    l = limit.create(host(), { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: APP, commit: 'closing' }),
      timing: fast, delayMs: 0, home: tmp('races-home-4') });
    await l.check();
    eq([closed, c.files[SW], leftovers(c.files)], [true, text(32), []], 'a window closing while a raise is under way stops it before the file is replaced');
  }
  reset();
  undo();
};
