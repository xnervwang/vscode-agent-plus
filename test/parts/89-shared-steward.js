// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A turn started by a notice Claude Code Plus sends a steward conversation, in the shared Python: the injection marks
 * the turn, and the end-of-turn and no-doing reminders keep quiet for it.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENTS = ['claude', 'codex'];
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOTICE = 'Steward notice from Claude Code Plus, not a message from the user: "Fix the build" is waiting for you.';
const WRAPPED = 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1/cc-socks/9.sock" '
  + `from-name="claude-code-plus" from-mode="prompting">\n${NOTICE}\n</cross-session-message>`;
const OTHER_PEER = 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1/cc-socks/9.sock" '
  + 'from-name="some-session" from-mode="prompting">\nThe build is green.\n</cross-session-message>';
const QUOTED = `What does "${NOTICE}" mean?`;

module.exports = async ({ eq, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the steward notice hooks were not run'); return; }
  const shared = path.join(root, 'shared', 'plugin');
  const hooksOf = {};
  for (const agent of AGENTS) {
    const dir = path.join(tmp(`steward-hooks-${agent}`), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(dir, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(dir, 'plan_agent.py'));
    hooksOf[agent] = dir;
  }
  const run = (agent, script, args, input) => cp.spawnSync(python, ['-B', path.join(hooksOf[agent], script), ...args],
    { input, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const turnField = { claude: 'prompt_id', codex: 'turn_id' };
  const now = Date.now() / 1000;
  const old = new Date((now - 3600) * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
  const said = (r) => {
    const out = (r.stdout || '').trim();
    if (!out) return '';
    try { const o = JSON.parse(out); return (o.hookSpecificOutput ? o.hookSpecificOutput.additionalContext : o.reason) || ''; } catch (_) { return out; }
  };

  /* One turn begun by `prompt`: the injection, three working tool calls, and the Stop at its end. */
  const turn = (agent, name, prompt) => {
    const data = tmp(`steward-${agent}-${name}`);
    const file = path.join(data, SID + '.json');
    fs.writeFileSync(file, JSON.stringify({ nodes: [{ title: 'A', state: 'todo', opened: old }],
      brief: { summary: 'S', summaryAt: old, status: { doing: 'd', progress: 'p', next: 'n' }, statusAt: old } }));
    fs.utimesSync(file, now - 120, now - 120);
    const base = { session_id: SID, [turnField[agent]]: 't1' };
    run(agent, 'inject-work-plan.py', [data], JSON.stringify({ ...base, hook_event_name: 'UserPromptSubmit', prompt }));
    let mark = {};
    try { mark = JSON.parse(fs.readFileSync(file.replace(/\.json$/, '.turn'), 'utf8')); } catch (_) { /* none */ }
    const reminded = [];
    if (agent === 'claude') {
      const calls = [1, 2, 3].map(() => ({ tool_name: 'Bash', tool_input: { command: 'touch x' } }));
      reminded.push(said(run(agent, 'remind-work-plan.py', [data], JSON.stringify({ ...base, hook_event_name: 'PostToolBatch', tool_calls: calls }))));
    } else {
      for (let i = 0; i < 3; i++) {
        reminded.push(said(run(agent, 'remind-work-plan.py', [data],
          JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_input: { cmd: 'touch x' } }))));
      }
    }
    const tr = path.join(data, 't.jsonl');
    const lines = [1, 2, 3].map((i) => {
      const ts = new Date((now + i) * 1000).toISOString();
      return JSON.stringify(agent === 'claude'
        ? { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'touch x' } }] } }
        : { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"touch x"}' } });
    });
    fs.writeFileSync(tr, lines.join('\n') + '\n');
    const stopped = said(run(agent, 'nudge-work-plan.py', [data], JSON.stringify({ ...base, hook_event_name: 'Stop', transcript_path: tr,
      last_assistant_message: '-', stop_hook_active: false })));
    return { notice: mark.notice === true, reminded: reminded.filter(Boolean).length, stopped };
  };

  for (const agent of AGENTS) {
    const plain = turn(agent, 'plain', 'Fix the build.');
    eq([plain.notice, plain.reminded, /status/i.test(plain.stopped)], [false, 1, true],
      `${agent}: an ordinary turn that works without a doing row is reminded once and asked for its status at the end`);
    for (const [label, prompt] of [['as Claude Code wraps it', WRAPPED], ['on its own', NOTICE]]) {
      const n = turn(agent, `notice-${label.length}`, prompt);
      eq([n.notice, n.reminded, n.stopped], [true, 0, ''],
        `${agent}: a turn begun by a steward notice ${label} is marked so, and neither reminder speaks in it`);
    }
    for (const [label, prompt] of [['a message from another session', OTHER_PEER], ['a message that quotes a notice', QUOTED]]) {
      const n = turn(agent, `other-${label.length}`, prompt);
      eq([n.notice, n.reminded, /status/i.test(n.stopped)], [false, 1, true], `${agent}: ${label} is not a steward notice`);
    }
  }
};
