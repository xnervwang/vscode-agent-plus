// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The brief in the shared Python, run with each agent's plan_agent.py: the two commands that write it, when the Stop
 * hook asks for it, and what the injection and compaction hooks add.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENTS = ['claude', 'codex'];
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
/* One CJK ideograph, written as an escape because the files here contain only English. */
const HAN = '\u5b57';

module.exports = async ({ ok, bad, eq, note, tmp, root }) => {
  const shared = path.join(root, 'shared', 'plugin');
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the brief commands and hooks were not run'); return; }
  const hooksOf = {};
  for (const agent of AGENTS) {
    const dir = path.join(tmp(`brief-hooks-${agent}`), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(dir, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(dir, 'plan_agent.py'));
    hooksOf[agent] = dir;
  }
  const run = (agent, script, args, input = '') => cp.spawnSync(python, ['-B', path.join(hooksOf[agent], script), ...args],
    { input, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const fresh = (agent, name, plan, config) => {
    const data = tmp(`brief-${agent}-${name}`);
    const file = path.join(data, SID + '.json');
    fs.writeFileSync(file, JSON.stringify(plan));
    if (config) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
    return { data, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  };

  /* ── plan-row.py summary and status ── */
  {
    const p = fresh('claude', 'width', { nodes: [{ title: 'A', state: 'todo' }] });
    const row = (...args) => run('claude', 'plan-row.py', [p.file, ...args]);
    const at = row('summary', HAN.repeat(200));
    const over = row('summary', HAN.repeat(200) + 'a');
    const ascii = row('summary', 'a'.repeat(400));
    const asciiOver = row('summary', 'a'.repeat(401));
    eq([at.status, over.status, /401/.test(over.stderr) && /400/.test(over.stderr), ascii.status, asciiOver.status],
      [0, 1, true, 0, 1], 'a summary of exactly 400 wide is written, one more is refused saying how wide it is and the limit, '
        + 'and an ideograph counts 2');
    const limits = { doing: 80, progress: 100, next: 60 };
    const fill = { doing: 'd', progress: 'p', next: 'n' };
    const got = [];
    for (const [part, limit] of Object.entries(limits)) {
      const args = (n) => ['status', ...Object.entries(fill).flatMap(([k, v]) => [`--${k}`, k === part ? 'x'.repeat(n) : v])];
      const half = (n) => ['status', ...Object.entries(fill).flatMap(([k, v]) => [`--${k}`, k === part ? HAN.repeat(n) : v])];
      const r1 = row(...args(limit)), r2 = row(...args(limit + 1)), r3 = row(...half(limit / 2)), r4 = row(...half(limit / 2 + 1));
      got.push([part, r1.status, r2.status, r3.status, r4.status, new RegExp(String(limit)).test(r2.stderr)]);
    }
    eq(got, Object.keys(limits).map((k) => [k, 0, 1, 0, 1, true]),
      'each status part takes exactly its limit (doing 80, progress 100, next 60) and refuses one more, ideographs counted 2');
    const missing = row('status', '--doing', 'd', '--progress', 'p');
    const empty = row('status', '--doing', 'd', '--progress', ' ', '--next', 'n');
    const blank = row('summary', '  ');
    eq([missing.status !== 0, empty.status, /none/.test(empty.stderr), blank.status], [true, 1, true, 1],
      'status needs all three parts, an empty one is refused with how to say there is nothing, and so is an empty summary');
  }
  {
    const p = fresh('codex', 'fields', { nodes: [{ title: 'A', state: 'todo' }], title: 'kept' });
    const s = run('codex', 'plan-row.py', [p.file, 'summary', '  What this is for.  ']);
    const after1 = p.read();
    after1.brief = after1.brief || {};
    const t = run('codex', 'plan-row.py', [p.file, 'status', '--doing', 'Writing tests', '--progress', 'Half done', '--next', 'none']);
    const after2 = p.read();
    const b = after2.brief || {};
    eq([s.status, t.status, after1.brief.summary, STAMP.test(after1.brief.summaryAt), after1.brief.status, b.summary,
      b.summaryAt === after1.brief.summaryAt, b.status, STAMP.test(b.statusAt), after2.nodes.length, after2.title],
    [0, 0, 'What this is for.', true, undefined, 'What this is for.', true,
      { doing: 'Writing tests', progress: 'Half done', next: 'none' }, true, 1, 'kept'],
    'summary writes summary and summaryAt, status writes the three parts and statusAt, each leaving the rest of the file alone');
    const created = path.join(tmp('brief-new'), 'bbbbbbbb-1111-2222-3333-444444444444.json');
    const c = run('codex', 'plan-row.py', [created, 'summary', 'Started here.']);
    eq([c.status, fs.existsSync(created) && JSON.parse(fs.readFileSync(created, 'utf8')).nodes], [0, []],
      'a brief written before any row starts the plan file');
    const off = fresh('codex', 'off', { nodes: [] }, { brief: false });
    eq(run('codex', 'plan-row.py', [off.file, 'summary', 'Still written.']).status, 0,
      'with the brief switched off for the hooks, the commands still write');
    for (const [agent, prefix] of [['claude', 'claudeCodePlus'], ['codex', 'codexPlus']]) {
      const planOff = fresh(agent, 'plan-off', { nodes: [{ title: 'A', state: 'todo' }] }, { enabled: false });
      const r = run(agent, 'plan-row.py', [planOff.file, 'set', '1', 'doing']);
      eq([r.status, /agentPlus\.tokenMode/.test(r.stderr), r.stderr.includes(`${prefix}.workPlan when that mode is Custom`),
        planOff.read().nodes[0].state], [1, true, true, 'todo'],
        `${agent}: with work plans off, a write is refused naming the token mode, and the editor's own setting for Custom`);
    }
  }

  /* ── The end-of-turn reminder ── */
  const now = Date.now() / 1000;
  const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
  const transcriptLines = (agent, calls, began) => {
    const t0 = began + 5;
    const out = [];
    for (let i = 0; i < calls; i++) {
      const ts = new Date((t0 + i) * 1000).toISOString();
      out.push(agent === 'claude'
        ? { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
        : { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' } });
    }
    return out.map((l) => JSON.stringify(l)).join('\n') + '\n';
  };
  const turnField = { claude: 'prompt_id', codex: 'turn_id' };
  /* A Stop at the end of a turn that began `ago` seconds ago and made `calls` tool calls, with the plan last written
     `planAge` seconds ago. Returns what the hook said, or ''. */
  const stop = (agent, p, { calls = 0, ago = 60, planAge = 120, active = false, marker } = {}) => {
    const began = now - ago;
    fs.writeFileSync(p.file.replace(/\.json$/, '.turn'), JSON.stringify({ prompt: 't1', began }));
    const tr = path.join(p.data, 't.jsonl');
    fs.writeFileSync(tr, transcriptLines(agent, calls, began));
    fs.utimesSync(p.file, now - planAge, now - planAge);
    if (marker !== undefined) fs.writeFileSync(p.file.replace(/\.json$/, '.compacted'), marker);
    const r = run(agent, 'nudge-work-plan.py', [p.data], JSON.stringify({ session_id: SID, [turnField[agent]]: 't1',
      hook_event_name: 'Stop', transcript_path: tr, last_assistant_message: 'Done.', stop_hook_active: active }));
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr.slice(-200)}`;
    const out = r.stdout.trim();
    if (!out) return '';
    try {
      const o = JSON.parse(out);
      return (o.hookSpecificOutput ? o.hookSpecificOutput.additionalContext : o.reason) || '';
    } catch (_) { return 'not one JSON object: ' + out.slice(0, 200); }
  };
  const asksStatus = (s) => /status/i.test(s) && /--doing|set_status/.test(s);
  const asksSummary = (s) => /summary/i.test(s) && /summary TEXT|set_summary/.test(s);
  for (const agent of AGENTS) {
    const old = iso(now - 3600);
    const both = { summary: 'S', summaryAt: old, status: { doing: 'd', progress: 'p', next: 'n' }, statusAt: old };
    const rows = [{ title: 'A', state: 'todo', opened: iso(now - 7200) }];
    const cases = [];
    {
      const p = fresh(agent, 'quiet', { nodes: rows, brief: both });
      cases.push(['a turn that only answered and changed nothing', stop(agent, p, { calls: 0 }), false, false]);
    }
    {
      const p = fresh(agent, 'tools', { nodes: rows, brief: both });
      cases.push(['a turn with tool calls and an older status', stop(agent, p, { calls: 3 }), true, false]);
    }
    {
      const p = fresh(agent, 'fresh-status', { nodes: rows, brief: Object.assign({}, both, { statusAt: iso(now - 10) }) });
      cases.push(['a turn with tool calls whose status was written during it', stop(agent, p, { calls: 3 }), false, false]);
    }
    {
      const p = fresh(agent, 'plan-changed', { nodes: rows, brief: both });
      cases.push(['a turn that changed the plan with no tool call of its own', stop(agent, p, { calls: 0, planAge: 1 }), true, false]);
    }
    {
      const p = fresh(agent, 'no-summary', { nodes: rows, brief: { status: both.status, statusAt: iso(now - 10) } });
      cases.push(['a plan with rows and no summary', stop(agent, p, { calls: 0 }), false, true]);
    }
    {
      const p = fresh(agent, 'empty', { nodes: [] });
      cases.push(['a plan with no rows and no summary', stop(agent, p, { calls: 0 }), false, false]);
    }
    {
      const p = fresh(agent, 'active', { nodes: rows });
      cases.push(['a Stop that follows one that kept the turn going', stop(agent, p, { calls: 3, active: true }), false, false]);
    }
    {
      const p = fresh(agent, 'off', { nodes: rows }, { brief: false });
      cases.push(['the brief switched off in config.json', stop(agent, p, { calls: 3, planAge: 1 }), false, false]);
    }
    for (const [label, said, status, summary] of cases) {
      eq([asksStatus(said), asksSummary(said)], [status, summary], `${agent}: ${label}: ${status ? 'asks' : 'no'} status, ${summary ? 'asks' : 'no'} summary`);
    }
    {
      const p = fresh(agent, 'closed', { nodes: [{ title: 'A', state: 'done', opened: iso(now - 7200), closed: iso(now - 30) }],
        brief: Object.assign({}, both, { statusAt: iso(now - 10) }) });
      const first = stop(agent, p), second = stop(agent, p);
      eq([asksSummary(first), asksSummary(second)], [true, false],
        `${agent}: a top-level row closed after the summary asks for a new one, once`);
    }
    {
      const p = fresh(agent, 'added', { nodes: rows.concat([{ title: 'B', state: 'todo', opened: iso(now - 30) }]),
        brief: Object.assign({}, both, { statusAt: iso(now - 10) }) });
      eq(asksSummary(stop(agent, p)), true, `${agent}: a top-level row added after the summary asks for a new one`);
    }
    {
      const p = fresh(agent, 'removed', { nodes: rows.concat([{ title: 'B', state: 'todo', opened: iso(now - 7200) }]),
        brief: Object.assign({}, both, { statusAt: iso(now - 10) }) });
      const before = stop(agent, p);
      const plan = p.read();
      plan.nodes.pop();
      fs.writeFileSync(p.file, JSON.stringify(plan));
      eq([asksSummary(before), asksSummary(stop(agent, p))], [false, true],
        `${agent}: a top-level row taken out of the file after the summary asks for a new one`);
    }
    {
      const p = fresh(agent, 'compacted', { nodes: rows, brief: Object.assign({}, both, { statusAt: iso(now - 10) }) });
      const first = stop(agent, p, { marker: iso(now - 20) }), second = stop(agent, p);
      const p2 = fresh(agent, 'compacted-before', { nodes: rows, brief: Object.assign({}, both, { statusAt: iso(now - 10) }) });
      eq([asksSummary(first), asksSummary(second), asksSummary(stop(agent, p2, { marker: iso(now - 7200) }))], [true, false, false],
        `${agent}: the first turn to end after a compaction later than the summary asks for one, once; an earlier compaction does not`);
    }
    {
      const p = fresh(agent, 'together', { nodes: rows });
      const said = stop(agent, p, { calls: 3 });
      eq([asksStatus(said), asksSummary(said), !/^not one JSON/.test(said), /stepped away/.test(said), /language/.test(said)],
        [true, true, true, true, true],
        `${agent}: status and summary are asked for in one message, saying who it is for and in which language`);
    }
  }

  /* ── Several Stops in one turn ── */
  const userLine = (agent, ts) => JSON.stringify(agent === 'claude'
    ? { type: 'user', timestamp: ts, message: { role: 'user', content: 'Go on.' } }
    : { timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage' } } });
  const writeLine = (agent, ts) => JSON.stringify(agent === 'claude'
    ? { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x', content: 'y' } }] } }
    : { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' } });
  for (const agent of AGENTS) {
    const p = fresh(agent, 'stops', { nodes: [{ title: 'A', state: 'todo', opened: iso(now - 7200) }] }, { brief: true });
    const tr = path.join(p.data, 't.jsonl');
    const lines = [];
    for (let i = 0; i < 3; i++) lines.push(userLine(agent, new Date((now - 600 + i * 60) * 1000).toISOString()));
    for (let i = 0; i < 10; i++) lines.push(writeLine(agent, new Date((now - 400 + i) * 1000).toISOString()));
    fs.writeFileSync(tr, lines.join('\n') + '\n');
    fs.utimesSync(p.file, now - 3600, now - 3600);
    const once = () => {
      const r = run(agent, 'nudge-work-plan.py', [p.data], JSON.stringify({ session_id: SID, hook_event_name: 'Stop',
        transcript_path: tr, last_assistant_message: 'Done.' }));
      try { const o = JSON.parse(r.stdout); return (o.hookSpecificOutput ? o.hookSpecificOutput.additionalContext : o.reason) || ''; } catch (_) { return ''; }
    };
    const asked = [once(), once(), once(), once()].map(asksStatus);
    fs.appendFileSync(tr, [userLine(agent, new Date((now - 100) * 1000).toISOString()),
      ...[0, 1, 2].map((i) => writeLine(agent, new Date((now - 90 + i) * 1000).toISOString()))].join('\n') + '\n');
    asked.push(asksStatus(once()));
    eq(asked, [true, false, false, false, true],
      `${agent}: of four Stops in one turn only the first asks for the status, and the next turn asks again`);
  }
  for (const agent of AGENTS) {
    const p = fresh(agent, 'reenter', { nodes: [{ title: 'A', state: 'todo', opened: iso(now - 7200) }] });
    const tr = path.join(p.data, 't.jsonl');
    fs.writeFileSync(tr, [userLine(agent, new Date((now - 300) * 1000).toISOString()),
      ...[0, 1, 2].map((i) => writeLine(agent, new Date((now - 200 + i) * 1000).toISOString()))].join('\n') + '\n');
    fs.utimesSync(p.file, now - 3600, now - 3600);
    const r = run(agent, 'nudge-work-plan.py', [p.data], JSON.stringify({ session_id: SID, hook_event_name: 'Stop',
      transcript_path: tr, last_assistant_message: 'Done.', stop_hook_active: true }));
    eq([r.status, r.stdout.trim()], [0, ''],
      `${agent}: a Stop that follows one the hook kept going says nothing, though the turn changed things and left the plan alone`);
  }

  /* ── The brief in the injected block ── */
  for (const agent of AGENTS) {
    const brief = { summary: 'Shipping the brief view.', summaryAt: iso(now - 7200), status: { doing: 'Tests', progress: 'Red', next: 'none' },
      statusAt: iso(now - 300) };
    const say = (config) => {
      const p = fresh(agent, `inject-${config ? 'off' : 'on'}`, { nodes: [{ title: 'A', state: 'todo' }], brief }, config);
      const r = run(agent, 'inject-work-plan.py', [p.data], JSON.stringify({ session_id: SID, [turnField[agent]]: 't1', hook_event_name: 'UserPromptSubmit' }));
      try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return ''; }
    };
    const on = say(), off = say({ brief: false });
    eq([/Shipping the brief view\./.test(on), /2h ago/.test(on), /Tests/.test(on) && /5m ago/.test(on), /work plan/.test(off),
      /Shipping the brief view/.test(off)], [true, true, true, true, false],
    `${agent}: the injected plan carries the brief and how long ago each part was written, and leaves it out when switched off`);
  }

  /* ── The compaction mark ── */
  for (const agent of AGENTS) {
    const mark = (config) => {
      const p = fresh(agent, `mark-${config ? 'off' : 'on'}`, { nodes: [] }, config);
      run(agent, 'resume-work-plan.py', [p.data], JSON.stringify({ session_id: SID, hook_event_name: 'SessionStart', source: 'compact' }));
      const f = p.file.replace(/\.json$/, '.compacted');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
    };
    const on = mark(), off = mark({ brief: false });
    eq([STAMP.test(on), STAMP.test(off)], [true, true],
      `${agent}: a compaction leaves the time it happened beside the plan, with the brief on or off, since the injection reads it too`);
  }
};
