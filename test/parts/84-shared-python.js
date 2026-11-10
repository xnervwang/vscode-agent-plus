// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * shared/host/python-runtime.js and python-offer.js, loaded beside src/files.js as an extension loads them. Which build
 * is offered turns on process.platform, so Windows' answers are asked for in a child process that reports itself as
 * Windows; overwriting platform here would leave it overwritten for every part that follows.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root }) => {
  const dir = path.join(tmp('ext'), 'src');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'src', 'files.js'), path.join(dir, 'files.js'));
  for (const f of ['python-runtime.js', 'python-offer.js']) fs.copyFileSync(path.join(root, 'shared', 'host', f), path.join(dir, f));
  const home = tmp('shared-home');
  const run = (body) => {
    const r = cp.spawnSync(process.execPath, ['-e', `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const fs = require('fs'), path = require('path');
      const rt = require(${JSON.stringify(path.join(dir, 'python-runtime.js'))});
      const offer = require(${JSON.stringify(path.join(dir, 'python-offer.js'))});
      (async () => { process.stdout.write(JSON.stringify(await (async () => { ${body} })())); })();`],
    { encoding: 'utf8', env: { ...process.env, AGENT_WORK_PLAN_HOME: home } });
    try { return JSON.parse(r.stdout); } catch (_) { return { status: r.status, err: r.stderr.slice(-300) }; }
  };

  const store = tmp('storage');
  eq(run(`return [rt.home().startsWith(${JSON.stringify(home)}), rt.home(${JSON.stringify(store)}).startsWith(${JSON.stringify(store)})];`),
    [true, true], 'Python is fetched into the shared folder, in the same layout an extension\'s storage held it');
  eq(run(`
    const put = (base) => { const exe = rt.executable(base); fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, ''); return exe.replace(/\\\\/g, '/'); };
    const before = rt.pythons(${JSON.stringify(store)}).length;
    const old = put(${JSON.stringify(store)});
    const shared = put(rt.home().replace(/[\\\\/]python[\\\\/][^\\\\/]+$/, ''));
    const after = rt.pythons(${JSON.stringify(store)}).map((l) => l.join(' '));
    return [after.length - before, after[after.length - 2] === shared, after[after.length - 1] === old];`),
  [2, true, true], 'the candidates end with the shared download and then one an earlier version left in its storage');
  eq(run(`
    const n = offer.notice([['py', '-3'], ['python']], { download: 'x.download', install: 'x.install', without: 'Nothing is written.' });
    return [n.command, /tried py -3, python\\)/.test(n.detail), /Nothing is written\\.$/.test(n.detail)];`),
  ['x.download', true, true], 'the row above the plan names what was tried and offers the download where there is one');
  eq(run(`
    const asked = [];
    const ask = async (m, ...b) => { asked.push(m); return 'Not now'; };
    const first = await offer.offer({ ask, get: async () => true, home: ${JSON.stringify(home)} });
    const second = await offer.offer({ ask, get: async () => true, home: ${JSON.stringify(home)} });
    return [first, second, asked.length];`),
  [false, false, 1], 'the download is offered once per version on the machine, whichever extension asks first');
  eq(run(`
    let calls = 0, release;
    const gate = new Promise((r) => { release = r; });
    const get = offer.single(async () => { calls++; await gate; return 'done'; });
    const a = get(), b = get();
    release();
    const c = await a, d = await b, e = await get();
    return [calls, c, d, e];`),
  [2, 'done', 'done', 'done'], 'a window runs one download at a time: a call while one runs gets that one, a later call starts another');
};
