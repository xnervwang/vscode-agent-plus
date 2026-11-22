// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The skill search (shared/plugin/hooks/skill_route.py) beside Claude Code's plan_agent.py: which skills it finds in a
 * made-up Claude Code folder, project and plugins, by which names, which it leaves out, the block a turn is given and
 * what the conversation was given earlier, read from a made-up transcript. The cases are in
 * test/route/claude_skill_route.py, which needs nothing but Python; each line it prints is one check here. It also
 * checks that beside Codex's plan_agent.py the module keeps Codex's shape.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async ({ ok, bad, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the skill search was not run'); return; }
  const shared = path.join(root, 'shared', 'plugin');
  const hooksOf = {};
  for (const agent of ['claude', 'codex']) {
    const dir = path.join(tmp(`route-${agent}`), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(dir, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(dir, 'plan_agent.py'));
    hooksOf[agent] = dir;
  }
  const r = cp.spawnSync(python, ['-B', path.join(root, 'test', 'route', 'claude_skill_route.py'), hooksOf.claude, hooksOf.codex,
    tmp('route-scratch')], { encoding: 'utf8', timeout: 300000 });
  const lines = (r.stdout || '').split('\n');
  for (const line of lines) {
    if (line.startsWith('ok    ')) ok(line.slice(6));
    else if (line.startsWith('FAIL  ')) bad(line.slice(6));
  }
  if (!lines.some((l) => / checks, \d+ failed$/.test(l))) {
    bad(`claude_skill_route.py did not finish (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${(r.stderr || '').slice(-400)}`);
  }
};
