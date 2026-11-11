// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The shape of the injected plan on each turn, run with each agent's plan_agent.py.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENTS = ['claude', 'codex'];
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CAP = 6000;

module.exports = async ({ eq, note, tmp, root }) => {
  const shared = path.join(root, 'shared', 'plugin');
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the injection hook was not run'); return; }
  const now = Date.now() / 1000;
  const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
  for (const agent of AGENTS) {
    const hooks = path.join(tmp(`inject-hooks-${agent}`), 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(hooks, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(hooks, 'plan_agent.py'));
    const turn = agent === 'claude' ? 'prompt_id' : 'turn_id';
    const fresh = (name, plan, config) => {
      const data = tmp(`inject-${agent}-${name}`);
      const file = path.join(data, SID + '.json');
      fs.writeFileSync(file, JSON.stringify(plan));
      if (config) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
      return { data, file, write: (p) => fs.writeFileSync(file, JSON.stringify(p)), side: (s) => file.replace(/\.json$/, s) };
    };
    let n = 0;
    const inject = (p) => {
      const r = cp.spawnSync(python, ['-B', path.join(hooks, 'inject-work-plan.py'), p.data],
        { input: JSON.stringify({ session_id: SID, [turn]: `t${++n}`, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      if (r.status !== 0) return `exit ${r.status}: ${r.stderr.slice(-300)}`;
      try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return r.stdout.trim() ? 'not JSON' : ''; }
    };
    const FULL = /A child is something that has to be finished/;
    const plan = { nodes: [
      { title: 'Ship it', state: 'doing', since: iso(now - 3600), note: 'Building' },
      { title: 'Ask about the name', state: 'waiting', waitingOn: 'user', question: 'Which name?', since: iso(now - 600) },
      { title: 'Later', state: 'todo' },
    ] };

    /* ── First turn, then unchanged, then changed ── */
    {
      const p = fresh('turns', plan);
      const first = inject(p);
      const second = inject(p);
      const aged = JSON.parse(JSON.stringify(plan));
      aged.nodes[0].since = iso(now - 3 * 3600);
      p.write(aged);
      const third = inject(p);
      aged.nodes[2].title = 'Later, but sooner';
      p.write(aged);
      const fourth = inject(p);
      eq([FULL.test(first), /Ship it/.test(first), fs.existsSync(p.side('.injected'))], [true, true, true],
        `${agent}: a conversation's first injection is the whole block, and the hook keeps what it showed beside the plan`);
      eq([second.split('\n').length, /^This conversation's work plan/.test(second), /has not changed/.test(second),
        /1 doing/.test(second) && /1 waiting/.test(second), second.includes(p.file), /Ship it/.test(second)],
      [1, true, true, true, true, false],
      `${agent}: the same plan again is one line, saying how many rows are doing and waiting and where the file is`);
      eq([third.split('\n').length, /has not changed/.test(third)], [1, true],
        `${agent}: a plan whose only change is how long a row has been doing counts as unchanged`);
      eq([/^This conversation's work plan/.test(fourth), FULL.test(fourth), /Later, but sooner/.test(fourth),
        /Ship it/.test(fourth), /doing/.test(fourth.split('\n')[0])], [true, false, true, true, true],
      `${agent}: a changed plan gets its rows under a short head, not the whole block`);
    }

    /* ── After a compaction ── */
    {
      const p = fresh('compacted', plan);
      inject(p);
      fs.writeFileSync(p.side('.compacted'), iso(now));
      const after = inject(p);
      const next = inject(p);
      eq([FULL.test(after), /Ship it/.test(after), next.split('\n').length], [true, true, 1],
        `${agent}: the first injection after a compaction is the whole block again, and the one after that is one line`);
    }

    /* ── Which rows carry what ── */
    {
      const long = 'x'.repeat(400);
      const p = fresh('rows', { nodes: [
        { title: 'Doing ' + long, state: 'doing', note: 'note ' + long },
        { title: 'Asking', state: 'waiting', waitingOn: 'user', question: 'Is it ' + 'y'.repeat(150) + '?', note: 'n' },
        { title: 'Todo ' + long, state: 'todo', note: 'hidden note' },
        { title: 'Build', state: 'waiting', waitingOn: 'build', note: 'hidden too' },
      ] });
      const lines = inject(p).split('\n');
      const row = (num) => lines.find((l) => new RegExp(`^\\S ${num}\\. `).test(l)) || '';
      const body = (l) => l.replace(/^\S \d+\. /, '');
      eq([body(row(1)).length <= 200, /note x/.test(row(1)), body(row(2)).length <= 200, /Is it y/.test(row(2)),
        body(row(3)).length <= 80, /hidden note/.test(row(3)), /hidden too/.test(row(4)), /^~ 4\. Build$/.test(row(4))],
      [true, true, true, true, true, false, false, true],
      `${agent}: a doing row and a row asking the user carry their note or question within 200 characters; any other open row `
        + 'is its title within 80');
    }

    /* ── The cap ── */
    {
      const brief = { summary: 'S'.repeat(400), summaryAt: iso(now - 60), status: { doing: 'd'.repeat(80), progress: 'p'.repeat(100),
        next: 'n'.repeat(60) }, statusAt: iso(now - 60) };
      const nodes = [];
      for (let i = 0; i < 60; i++) nodes.push({ title: `Row ${i} ` + 'w'.repeat(150), state: i % 3 ? 'todo' : 'doing', note: 'v'.repeat(300) });
      const p = fresh('cap', { nodes, brief });
      const first = inject(p);
      nodes.push({ title: 'One more', state: 'todo' });
      p.write({ nodes, brief });
      const changed = inject(p);
      const more = (s) => { const m = /\.\.\. (\d+) more open rows?, see the file/.exec(s); return m ? Number(m[1]) : 0; };
      const shown = (s) => s.split('\n').filter((l) => /^\s*\S \d+(\.\d+)*\. /.test(l)).length;
      eq([first.length <= CAP, changed.length <= CAP, shown(first) + more(first), shown(changed) + more(changed),
        /S{400}/.test(first), /S{400}/.test(changed)], [true, true, 60, 61, true, true],
      `${agent}: the whole block stays within ${CAP} characters with the brief in it, and says how many open rows it left out`);
    }

    /* ── The brief ── */
    {
      const brief = { summary: 'Shipping it.', summaryAt: iso(now - 7200), status: { doing: 'a', progress: 'b', next: 'c' }, statusAt: iso(now - 300) };
      const p = fresh('brief', { nodes: plan.nodes, brief });
      const first = inject(p);
      p.write({ nodes: plan.nodes.concat([{ title: 'New', state: 'todo' }]), brief });
      const changed = inject(p);
      eq([/Shipping it\./.test(first), /Shipping it\./.test(changed)], [true, true],
        `${agent}: the brief is shown with the rows, on the first turn and when the plan changed`);
    }

    /* ── A plan with nothing open ── */
    {
      const p = fresh('closed', { nodes: [{ title: 'Done', state: 'done' }] });
      eq(inject(p), '', `${agent}: a plan with nothing open injects nothing`);
    }
  }
};
