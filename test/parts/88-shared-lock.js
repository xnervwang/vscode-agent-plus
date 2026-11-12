// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * plan_lock in the shared Python, with os.mkdir made to refuse a few times, and os.name set to Windows' or a POSIX
 * system's for the length of one call.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the plan lock was not run'); return; }
  const hooks = path.join(tmp('lock-hooks'), 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const shared = path.join(root, 'shared', 'plugin');
  for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(hooks, f));
  fs.copyFileSync(path.join(shared, 'claude', 'plan_agent.py'), path.join(hooks, 'plan_agent.py'));
  const dir = tmp('lock-plans');
  const script = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(hooks)})
import plan_common as C
real = os.mkdir

def attempt(name, osname, refusals, wait):
    plan = os.path.join(${JSON.stringify(dir)}, name + ".json")
    calls = [0]
    def mkdir(p, *rest):
        calls[0] += 1
        if calls[0] <= refusals:
            raise PermissionError(13, "Access is denied", p)
        return real(p, *rest)
    missed = []
    saved_name, saved_wait = os.name, C.LOCK_WAIT
    os.mkdir, os.name, C.LOCK_WAIT = mkdir, osname, wait
    try:
        with C.plan_lock(plan, missed.append) as held:
            pass
    finally:
        os.mkdir, os.name, C.LOCK_WAIT = real, saved_name, saved_wait
    return [held, missed, calls[0], os.path.exists(plan + C.LOCK_SUFFIX)]

print(json.dumps([attempt("nt-brief", "nt", 3, 5), attempt("posix", "posix", 3, 5), attempt("nt-long", "nt", 10 ** 6, 0.2)]))
`;
  const r = cp.spawnSync(python, ['-B', '-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  let got;
  try { got = JSON.parse(r.stdout); } catch (_) { got = { status: r.status, err: (r.stderr || '').slice(-400) }; }
  const [brief, posix, long] = Array.isArray(got) ? got : [[], [], []];
  eq([brief[0], brief[1], brief[2], brief[3]], [true, [], 4, false],
    'on Windows, a lock directory that cannot be made for want of access is one still being removed: the lock waits and is taken');
  eq([posix[0], posix[1].length, /could not make .*Access is denied/.test(posix[1][0] || ''), posix[2]], [false, 1, true, 1],
    'elsewhere the same error means the folder cannot be written, and the lock gives up at once saying so');
  eq([long[0], long[1].length, /could not make .*Access is denied/.test(long[1][0] || ''), long[2] > 1], [false, 1, true, true],
    'on Windows, a refusal that lasts until the wait is over gives up then, with the error');
};
