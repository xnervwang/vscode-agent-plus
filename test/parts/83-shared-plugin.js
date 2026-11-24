// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan plugin's shared Python (shared/plugin/hooks/) with each agent's plan_agent.py, laid out as each
 * extension ships them. Each name a shared hook imports from plan_path must exist for both agents. The self-tests run
 * with both agents' input shapes, the other hooks must answer in their agent's output shape, and each agent's skill is
 * rendered from the template with every block used.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENTS = ['claude', 'codex'];
/* Hooks not every agent's part ships: file name -> the agents whose part has it. */
const ONLY = {};

module.exports = async ({ ok, bad, eq, note, tmp, root }) => {
  const shared = path.join(root, 'shared', 'plugin');
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  const hooksOf = {};
  for (const agent of AGENTS) {
    const dir = path.join(tmp(`hooks-${agent}`), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(dir, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(dir, 'plan_agent.py'));
    hooksOf[agent] = dir;
  }

  {
    const sync = require(path.join(root, 'shared', 'build', 'sync-shared.js'));
    const template = fs.readFileSync(path.join(shared, 'skills', 'maintain', 'SKILL.md'), 'utf8');
    for (const agent of AGENTS) {
      let out = '', err = '';
      try { out = sync.render(template, fs.readFileSync(path.join(shared, agent, 'maintain-skill.txt'), 'utf8')); } catch (e) { err = e.message; }
      eq([err, /^---\nname: maintain\ndescription: .+\n/.test(out), /\{\{[\w-]+\}\}/.test(out)], ['', true, false],
        `the ${agent} skill is made from the template, every block used and every line filled`);
    }
  }

  if (!python) { note('no Python 3.7 or later here: the shared hooks were not run'); return; }
  const run = (args, input, env) => cp.spawnSync(python, ['-B', ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

  {
    const r = run(['-c', `
import ast, json, os, sys
hooks = sys.argv[1]
def defined(f):
    names = set()
    for n in ast.parse(open(f).read()).body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)): names.add(n.name)
        elif isinstance(n, ast.Assign): names |= {t.id for t in n.targets if isinstance(t, ast.Name)}
        elif isinstance(n, (ast.Import, ast.ImportFrom)): names |= {(a.asname or a.name).split('.')[0] for a in n.names}
    return names
common = defined(os.path.join(hooks, 'plan_common.py'))
agents = {a: defined(os.path.join(sys.argv[2], a, 'plan_agent.py')) for a in ('claude', 'codex')}
only = json.loads(sys.argv[3])
missing = {}
for f in sorted(os.listdir(hooks)):
    if not f.endswith('.py'): continue
    for n in ast.walk(ast.parse(open(os.path.join(hooks, f)).read())):
        if isinstance(n, ast.ImportFrom) and n.module in ('plan_path', 'plan_agent'):
            for a in n.names:
                if a.name == '*': continue
                lacking = [ag for ag, names in agents.items() if ag in only.get(f, agents) and a.name not in common and a.name not in names]
                if lacking: missing.setdefault(f, []).append('%s (%s)' % (a.name, ', '.join(lacking)))
print(json.dumps(missing))`, path.join(shared, 'hooks'), shared, JSON.stringify(ONLY)]);
    eq([r.status, r.status === 0 ? JSON.parse(r.stdout) : r.stderr.slice(-300)], [0, {}],
      'every name a shared hook imports is in plan_common.py or in both agents\' plan_agent.py');
  }

  for (const agent of AGENTS) {
    for (const hook of ['changes.py', 'resume-work-plan.py', 'tell-time-zone.py', 'tell-reply-images.py'].filter((h) => !ONLY[h] || ONLY[h].includes(agent))) {
      const r = run([path.join(hooksOf[agent], hook), '--selftest'], '', { TZ: 'UTC' });
      if (r.status === 0 && /all checks pass/.test(r.stdout)) ok(`${hook} passes its self-test with ${agent}'s input shapes`);
      else bad(`${hook} --selftest with ${agent}: ${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join(' | ') || r.status}`);
    }
  }

  const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  for (const agent of AGENTS) {
    const fields = agent === 'claude'
      ? { turn: 'prompt_id', remind: { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'echo a > b' } }] } }
      : { turn: 'turn_id', remind: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo a > b' } } };
    const data = tmp(`data-${agent}`);
    const plan = path.join(data, SID + '.json');
    fs.writeFileSync(plan, JSON.stringify({ nodes: [{ title: 'A', state: 'todo' }] }));
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ remindMinCalls: 1 }));
    /* The user's message, then the reply the Stop hook reads it from. */
    const transcript = path.join(data, 't.jsonl');
    fs.writeFileSync(transcript, (agent === 'claude'
      ? [{ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'merge it' } }]
      : [{ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage' } } }])
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
    const say = (hook, payload) => {
      const r = run([path.join(hooksOf[agent], hook), data], JSON.stringify({ session_id: SID, [fields.turn]: 't1', ...payload }));
      try { return r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : { status: r.status, err: r.stderr.slice(-200) }; } catch (e) { return { out: r.stdout }; }
    };
    const injected = say('inject-work-plan.py', { hook_event_name: 'UserPromptSubmit' });
    const reminded = say('remind-work-plan.py', fields.remind);
    const stopped = say('nudge-work-plan.py', { hook_event_name: 'Stop', transcript_path: transcript, last_assistant_message: 'Should I merge it?' });
    const said = (o) => (o.hookSpecificOutput ? o.hookSpecificOutput.additionalContext : o.reason) || '';
    eq([/work plan \(1 todo\)/.test(said(injected)), /no row of the work plan is `doing`/.test(said(reminded)),
      agent === 'codex' ? stopped.decision : stopped.hookSpecificOutput && stopped.hookSpecificOutput.hookEventName,
      /asking the user something/.test(said(stopped))],
    [true, true, agent === 'codex' ? 'block' : 'Stop', true],
    `with ${agent}'s inputs the plan is injected, the reminder speaks, and the Stop hook answers in ${agent}'s shape`);
  }

  /* The shape of a session id is the agent's (plan_agent.SESSION_ID): an agent whose ids are not hex, as OpenCode's
     ses_ ids are, gives its own, and it stays narrow enough that the other files in the data directory are not plans. */
  {
    const probe = `
import json, sys
sys.path.insert(0, sys.argv[1])
import plan_common as C
ids = json.loads(sys.argv[2])
print(json.dumps([bool(C.SESSION_NAME.match(i)) for i in ids] + [bool(C.PLAN_NAME.match('client-time-zone.json'))]
                 + [C.plan_file({'session_id': ids[0]}, '/d') is not None]))
`;
    const UUID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61', SES = 'ses_df3c28ab2ffe0TYFbXAnoBpqy6';
    for (const agent of AGENTS) {
      const r = run(['-c', probe, hooksOf[agent], JSON.stringify([UUID, SES, 'client-time-zone'])]);
      let got = null;
      try { got = JSON.parse(r.stdout); } catch (_) { got = r.stderr || r.stdout; }
      eq(got, [true, false, false, false, true], `${agent}'s plan_agent.py gives the session id shape: a UUID names a plan, an OpenCode id and the time-zone file do not`);
    }
    const dir = path.join(tmp('hooks-ses'), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(hooksOf.codex)) fs.copyFileSync(path.join(hooksOf.codex, f), path.join(dir, f));
    const agentFile = path.join(dir, 'plan_agent.py');
    const text = fs.readFileSync(agentFile, 'utf8');
    fs.writeFileSync(agentFile, text.replace(/^SESSION_ID = .*$/m, 'SESSION_ID = r"ses_[0-9A-Za-z]{26}"'));
    const r = run(['-c', probe, dir, JSON.stringify([SES, UUID, 'client-time-zone'])]);
    let got = null;
    try { got = JSON.parse(r.stdout); } catch (_) { got = r.stderr || r.stdout; }
    eq(got, [true, false, false, false, true], 'an agent that gives ses_ ids as its shape has them name plans, and only them');
  }
};
