// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's webview request limit: found, changed under a lock beside the file, written through a temporary file, and
 * left alone in Restricted Mode. The client's file system is held in memory, asynchronous like the real one.
 */
const path = require('path');
const fake = require('../fake-vscode');

function client(files, { refuse = '' } = {}) {
  const meta = new Map(Object.keys(files).map((k) => [k, { mtime: Date.now() }]));
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p);
  const dirs = (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1).split('/')[0]))];
  const err = (code) => Object.assign(new Error(code), { code });
  const tick = () => new Promise((r) => setImmediate(r));
  const uri = (p) => ({ path: p, with: (c) => uri(c.path) });
  return {
    at: uri,
    files, meta,
    fs: {
      stat: async (u) => { await tick(); if (has(u.path)) return { mtime: meta.get(u.path).mtime }; if (dirs(u.path).length) return { mtime: 0 }; throw err('ENOENT'); },
      readFile: async (u) => { await tick(); if (!has(u.path)) throw err('ENOENT'); return new TextEncoder().encode(files[u.path]); },
      writeFile: async (u, b) => { await tick(); if (refuse) throw err(refuse); files[u.path] = new TextDecoder().decode(b); meta.set(u.path, { mtime: Date.now() }); },
      rename: async (a, b, opts) => {
        await tick();
        if (!has(a.path)) throw err('ENOENT');
        if (has(b.path) && !(opts && opts.overwrite)) throw err('EEXIST');
        files[b.path] = files[a.path]; meta.set(b.path, meta.get(a.path));
        delete files[a.path]; meta.delete(a.path);
      },
      delete: async (u) => { await tick(); if (!has(u.path)) throw err('ENOENT'); delete files[u.path]; meta.delete(u.path); },
      readDirectory: async (u) => { await tick(); const d = dirs(u.path); if (!d.length) throw err('ENOENT'); return d.map((n) => [n, 2]); },
    },
  };
}

module.exports = async ({ eq, root }) => {
  const wl = require(path.join(root, 'src', 'webview-limit.js'));
  const APP = '/opt/code/resources/app';
  const SW = `${APP}/${wl.SW}`;
  const text = (n) => `a();${wl.NAME}=${n},b();`;
  const fresh = (n = 32, extra = {}) => client(Object.assign({ [`${APP}/product.json`]: '{"commit":"abc"}', [SW]: text(n) }, extra));
  const fast = { wait: async () => {} };
  const leftovers = (c) => Object.keys(c.files).filter((f) => /agent-work-plan/.test(f));

  const c = fresh();
  const [install] = await wl.find({ fs: c.fs, at: c.at, local: true, appRoot: APP });
  eq([install && install.limit, install && install.root], [32, APP], 'find() reads the limit of the running installation');
  eq(await wl.setLimit(c.fs, install, 32, wl.NEW, fast), '', 'setLimit() changes it');
  eq([c.files[SW], leftovers(c)], [text(wl.NEW), []], 'the file holds the new value, and no lock or temporary file is left');
  eq(await wl.setLimit(c.fs, install, 32, wl.NEW, fast), 'changed', 'a file that no longer has the old value is left alone');

  const twice = client({ [SW]: text(32) + text(32) });
  eq(await wl.setLimit(twice.fs, { root: APP, uri: twice.at(SW) }, 32, wl.NEW, fast), 'changed', 'text found twice is not changed');

  const held = fresh(32, { [SW + wl.LOCK_SUFFIX]: '{}' });
  eq([await wl.setLimit(held.fs, { root: APP, uri: held.at(SW) }, 32, wl.NEW, fast), held.files[SW], leftovers(held)],
    ['locked', text(32), [SW + wl.LOCK_SUFFIX]], 'with another window holding the lock, nothing changes and only that lock remains');

  const stale = fresh(32, { [SW + wl.LOCK_SUFFIX]: '{}' });
  stale.meta.set(SW + wl.LOCK_SUFFIX, { mtime: Date.now() - wl.LOCK_STALE_MS - 1000 });
  eq([await wl.setLimit(stale.fs, { root: APP, uri: stale.at(SW) }, 32, wl.NEW, fast), stale.files[SW], leftovers(stale)],
    ['', text(wl.NEW), []], 'a lock left by a window that died is removed');

  const race = fresh();
  const target = { root: APP, uri: race.at(SW) };
  const both = await Promise.all([wl.setLimit(race.fs, target, 32, wl.NEW, { wait: () => new Promise((r) => setTimeout(r, 2)) }),
    wl.setLimit(race.fs, target, 32, wl.NEW, { wait: () => new Promise((r) => setTimeout(r, 2)) })]);
  eq([both.slice().sort(), race.files[SW], leftovers(race)], [['', 'changed'], text(wl.NEW), []], 'two windows at once: one changes it, the other finds it changed');

  const ro = fresh(32);
  const roClient = client(ro.files, { refuse: 'EACCES' });
  eq([await wl.setLimit(roClient.fs, { root: APP, uri: roClient.at(SW) }, 32, wl.NEW, fast), ro.files[SW], leftovers(roClient)],
    ['EACCES', text(32), []], 'a file that cannot be written gives the error\'s code and leaves nothing behind');

  /* The prompt and Restricted Mode. */
  const { vscode, control } = fake.create();
  const undo = fake.install(vscode);
  fake.fresh(root);
  const limit = require(path.join(root, 'src', 'request-limit.js'));
  vscode.env.appRoot = APP;
  vscode.workspace.fs = {};
  let trusted = false;
  const asked = fresh();
  const host = { vscode, context: { globalState: fake.memento() }, say: () => {}, trusted: () => trusted };
  const l = limit.create(host, { where: () => ({ fs: asked.fs, at: asked.at, local: true, appRoot: APP, commit: 'abc' }), timing: fast, delayMs: 0 });
  await l.check();
  eq([control.state.said.length, asked.files[SW]], [0, text(32)], 'in Restricted Mode it does not even ask');
  trusted = true;
  control.answer('Raise the limit to 1000000', 'Raise it this time');
  await l.check();
  const msgs = control.state.said.map((s) => s.message);
  eq([asked.files[SW], msgs.some((m) => /is now 1000000/.test(m))], [text(wl.NEW), true], 'trusted, it asks once per VS Code build and raises it on request');
  await l.check();
  eq(control.state.said.filter((s) => /Raise the limit/.test(s.message)).length, 1, 'and does not ask again for the same build');
  await l.putBack();
  eq([asked.files[SW], control.state.configWrites.slice(-1)[0]], [text(32), ['agentWorkPlan.webviewRequestLimit', 'leave']],
    'putting it back restores 32 and stops it being raised again');
  l.dispose();
  undo();
};
