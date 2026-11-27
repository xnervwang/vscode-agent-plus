// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The shared Python that reads what Claude Code Plus writes for a supervisor, run from a copy laid out as Claude Code
 * Plus ships it (hooks/ and skills/<name>/SKILL.md). The first line of a relayed message and a notice say "supervisor"
 * or, from older builds, "steward", and a transcript can hold both, so each reader takes either; the skill may sit
 * under either folder name.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LEAD = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

module.exports = async ({ eq, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the supervisor word readers were not run'); return; }
  const shared = path.join(root, 'shared', 'plugin');
  const layout = (name) => {
    const plugin = tmp(`supervisor-${name}`);
    const hooks = path.join(plugin, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(hooks, f));
    for (const f of fs.readdirSync(path.join(shared, 'claude')).filter((x) => x.endsWith('.py'))) {
      fs.copyFileSync(path.join(shared, 'claude', f), path.join(hooks, f));
    }
    return { plugin, hooks };
  };
  const py = (hooks, body, env = {}) => {
    const r = cp.spawnSync(python, ['-B', '-c', `import json, sys\nsys.path.insert(0, ${JSON.stringify(hooks)})\n${body}`],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env } });
    try { return JSON.parse(r.stdout); } catch (_) { return { status: r.status, err: (r.stderr || '').slice(-400) }; }
  };
  const { hooks } = layout('words');

  {
    const lines = [
      `Sent by the supervisor "Fix the build" (${SID.toUpperCase()}) for the user:\nRun the tests.`,
      `Sent by the steward "Fix the build" (${SID}) for the user:\nRun the tests.`,
      `sent by the SUPERVISOR (${SID}) for the user:  `,
      `Sent by the manager (${SID}) for the user:`,
      `Please read this: Sent by the supervisor (${SID}) for the user:`,
    ];
    eq(py(hooks, `import steward_table\nprint(json.dumps([steward_table.sender_of(t) for t in ${JSON.stringify(lines)}]))`),
      [[SID, 'Fix the build'], [SID, 'Fix the build'], [SID, ''], null, null],
      'the first line of a relayed message is read with "supervisor" or "steward" in it, in any case; another word, or the line '
      + 'quoted after other text, names no sender');
  }

  {
    const config = tmp('supervisor-config');
    const project = path.join(config, 'projects', 'p');
    fs.mkdirSync(project, { recursive: true });
    const row = (minute, content) => JSON.stringify({ type: 'user', timestamp: `2026-11-20T10:0${minute}:00.000Z`, message: { content } });
    fs.writeFileSync(path.join(project, SID + '.jsonl'), [
      row(0, 'Fix the build.'),
      row(1, 'Supervisor notice from Claude Code Plus, not a message from the user. Conversations you manage changed.'),
      row(2, 'Steward notice from Claude Code Plus, not a message from the user. Conversations you manage changed.'),
      row(3, `Sent by the supervisor "Lead" (${LEAD}) for the user:\nRun the tests.`),
      row(4, `Sent by the steward "Lead" (${LEAD}) for the user:\nShip it.`),
    ].join('\n') + '\n');
    const r = cp.spawnSync(python, ['-B', path.join(hooks, 'steward-peek.py'), '--said', SID, tmp('supervisor-data')],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CLAUDE_CONFIG_DIR: config } });
    const out = r.stdout || '';
    const by = ` (sent by the supervisor "Lead" (${LEAD}), not typed by the user there):`;
    eq([out.includes('Fix the build.'), /notice from Claude Code Plus/.test(out), out.split(by).length - 1, out.includes('(sent by the steward')],
      [true, false, 2, false],
      '--said leaves out notices that begin with either word, and marks messages signed with either word as sent by the supervisor');
  }

  {
    const version = (files) => {
      const { plugin: p, hooks: h } = layout('skill');
      const want = {};
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.join(p, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(p, 'skills', name, 'SKILL.md'), text);
        want[name] = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
      }
      return [py(h, 'import steward\nprint(json.dumps(steward.skill_version()))'), want];
    };
    const [onlyNew, a] = version({ supervisor: 'new skill' });
    const [onlyOld, b] = version({ steward: 'old skill' });
    const [both, c] = version({ supervisor: 'new skill', steward: 'old skill' });
    const [none] = version({});
    eq([onlyNew === a.supervisor, onlyOld === b.steward, both === c.supervisor, none], [true, true, true, ''],
      'the skill version is read from skills/supervisor/ or else skills/steward/, and is empty with neither');
  }

  {
    const got = py(hooks, [
      'import steward, steward_table',
      `table = {${JSON.stringify(LEAD)}: {"title": "Lead"}}`,
      `text = steward.watched([${JSON.stringify(LEAD)}], table)`,
      'start = text.index("`Sent by") + 1',
      'line = text[start:text.index("`", start)].replace("<title>", "Lead").replace("<session id>", ' + JSON.stringify(LEAD) + ')',
      `print(json.dumps([text.startswith('A supervisor, "Lead" (${LEAD}), watches'), steward_table.sender_of(line),`,
      `                  steward.lead(["${SID}"]).startswith("You are the supervisor of 1 Claude Code conversation the user picked `
        + 'for you in the Supervisor panel; follow the supervisor skill.")]))',
    ].join('\n'));
    eq(got, [true, [LEAD, 'Lead'], true],
      'the note to a watched conversation names its supervisor and gives the first line of its messages, which the reader '
      + 'parses; the note to a supervisor says it is one');
  }
};
