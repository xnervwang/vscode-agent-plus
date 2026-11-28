// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the shared Python tells each side about leads: steward.py names only the lead to a managed conversation, in full
 * on its first turn, after a change of lead and after a compaction and in one line otherwise, and marks each line of a
 * supervisor's list as led or observed; steward-peek.py --said marks a lead's hand-over note and a new lead's first
 * message; steward-send-guard.py refuses a supervisor's SendMessage to a conversation it does not lead.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const S = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
const LEAD = S(1), OBS = S(2), OBS2 = S(3), M = S(4), M2 = S(5), LOOSE = S(6), OTHER = S(7), NOBODY = S(9);
const TITLES = { [LEAD]: 'Release supervisor', [OBS]: 'Night supervisor', [OBS2]: 'Docs supervisor', [OTHER]: 'Parser supervisor' };
const NAME = (s) => `"${TITLES[s]}" (${s})`;
const DECISIONS = 'Release, push a tag, approve, merge or speak for the user in public only on the user\'s own words: what the user '
  + 'types here, or what your lead supervisor\'s messages say apart from sentences marked as the supervisor\'s arrangement.';
const NO_LEAD = 'No supervisor watches this conversation now; put questions for the user in your plan.';

module.exports = async ({ eq, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the checks of what supervisors and their conversations are told were not run'); return; }
  const shared = path.join(root, 'shared', 'plugin');
  const hooks = path.join(tmp('told-plugin'), 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(hooks, f));
  for (const f of fs.readdirSync(path.join(shared, 'claude')).filter((x) => x.endsWith('.py'))) {
    fs.copyFileSync(path.join(shared, 'claude', f), path.join(hooks, f));
  }
  const config = tmp('told-config');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CLAUDE_CONFIG_DIR: config };

  const stewards = () => ({
    [LEAD]: { manages: [M, M2], at: 1, title: TITLES[LEAD], names: { [M]: 'Fix the build', [M2]: 'Port the parser' } },
    [OBS]: { manages: [M, M2], at: 2, title: TITLES[OBS], names: { [M]: 'Fix the build', [M2]: 'Port the parser' } },
    [OBS2]: { manages: [M], at: 3, title: TITLES[OBS2], names: { [M]: 'Fix the build' } },
  });
  const write = (d, { version = 4, lead = {}, noLeads = false, more = {} } = {}) => {
    const t = { version, stewards: Object.assign(stewards(), more) };
    if (!noLeads) {
      t.leads = { [M]: Object.assign({ lead: LEAD, term: 3, at: 1, why: 'first' }, lead), [M2]: { lead: OBS, term: 1, at: 1, why: 'first' } };
    }
    fs.writeFileSync(path.join(d, 'stewards.json'), JSON.stringify(t));
  };
  const world = (opts = {}) => {
    const d = tmp('told-data');
    write(d, opts);
    fs.mkdirSync(path.join(d, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(d, 'windows', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, at: Date.now(), name: 'Main', folders: [], sessions: opts.showing || [LEAD, OBS, OBS2] }));
    return d;
  };
  /* steward.py's answer for a turn of `sid`: the text it adds, or "" when it adds nothing. */
  const turn = (d, sid) => {
    const r = cp.spawnSync(python, ['-B', path.join(hooks, 'steward.py'), d],
      { input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env });
    if (!r.stdout.trim()) return r.stderr ? `(stderr) ${r.stderr.slice(-400)}` : '';
    try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return `(stdout) ${r.stdout}`; }
  };
  const observers = (text) => [TITLES[OBS], TITLES[OBS2], OBS, OBS2].filter((x) => text.includes(x));

  /* The managed conversation's note. */
  {
    const d = world();
    const full = turn(d, M), short = turn(d, M), told = JSON.parse(fs.readFileSync(path.join(d, 'stewards-told', `${M}.json`), 'utf8'));
    eq([full.startsWith(`Your lead supervisor is ${NAME(LEAD)}. It watches this conversation for the user through Claude Code Plus:`),
      full.includes(DECISIONS), full.includes('--handoff with a here-document') && full.includes('it goes to your lead supervisor'),
      full.includes('Do not send it status messages'), observers(full), / and |Supervisors|they /.test(full.slice(0, 120))],
    [true, true, true, true, [], false],
    'a managed conversation\'s first turn names its lead with its title and session id, in the singular, never an observer, and says that '
      + 'decisions count only from the user\'s own words and that a hand-off goes to the lead');
    eq([short, observers(short), told], [`Your lead supervisor is still ${NAME(LEAD)}. ${DECISIONS}`, [],
      { lead: LEAD, term: 3, title: TITLES[LEAD], tell: '', compacted: '' }],
    'the next turn gets one line that still names the lead and says decisions count only from the user\'s own words; what was told is kept '
      + 'in stewards-told/<session id>.json');

    fs.writeFileSync(path.join(d, `${M}.compacted`), '2026-11-28T10:00:00.000Z\n');
    const compacted = turn(d, M), afterCompact = turn(d, M);
    eq([compacted.startsWith(`Your lead supervisor is ${NAME(LEAD)}. It watches`), afterCompact.startsWith('Your lead supervisor is still')],
      [true, true], 'after a compaction the whole note comes once more, then the one line again');

    write(d, { lead: { lead: OBS, term: 4, why: 'takeover', was: LEAD } });
    const changed = turn(d, M).split('\n'), next = turn(d, M);
    eq([changed[0], changed[1].startsWith(`Your lead supervisor is ${NAME(OBS)}. It watches`), changed.slice(1).join('\n').includes(TITLES[LEAD]),
      changed.slice(1).join('\n').includes(LEAD), next],
    ['Your lead supervisor is now "Night supervisor" (was "Release supervisor").', true, false, false, `Your lead supervisor is still ${NAME(OBS)}. ${DECISIONS}`],
    'the turn after the lead changed says once from whom to whom, then gives the whole note naming the new lead only; the next turn has the one line');

    write(d, { lead: { lead: OBS, term: 6, why: 'takeover', was: LEAD } });
    const sameLead = turn(d, M);
    eq([sameLead.startsWith(`Your lead supervisor is ${NAME(OBS)}. It watches`), sameLead.includes('is now')], [true, false],
      'a new term with the same lead, as after a hand-over back, gives the whole note again without a line about a change');
  }
  {
    const away = world({ showing: [OBS, OBS2] });
    const full = turn(away, M), short = turn(away, M);
    eq([full.includes('It is not open in a VS Code window now, so put questions for the user in your plan as rows waiting on the user for now.'),
      full.includes('Do not send it status messages'), observers(full),
      short === `Your lead supervisor is still ${NAME(LEAD)}; it is not open in a VS Code window now, so put questions for the user in your plan. ${DECISIONS}`],
    [true, false, [], true],
    'while no window shows the lead, the note and the one line say so and put questions in the plan for now, and still name no observer');
    eq([turn(world({ lead: { lead: '' } }), M), turn(world({ version: 3, noLeads: true }), M), turn(world(), NOBODY)], [NO_LEAD, NO_LEAD, ''],
      'a managed conversation with no lead, or a table without leads, is told no supervisor watches it; a conversation nobody manages is told nothing');

    const text = 'From your lead supervisor "Release supervisor": from now on your lead supervisor is "Night supervisor".\nYou were fixing the flaky build test.';
    const d = world({ lead: { lead: OBS, term: 4, why: 'takeover', was: LEAD, tell: { kind: 'handover', from: LEAD, text, at: 50 } } });
    const first = turn(d, M), second = turn(d, M);
    eq([first.startsWith(`This note was left for you while no window had this conversation open:\n${text}\nYour lead supervisor is ${NAME(OBS)}.`),
      second.includes(text), second.startsWith('Your lead supervisor is still')], [true, false, true],
    'a note the window could not send is shown once, before the note about the lead, and not again');
  }

  /* A supervisor's list. */
  {
    const d = world();
    const obs = turn(d, OBS), lead = turn(d, LEAD), docs = turn(d, OBS2);
    const line = (text, name) => (text.split('\n').find((l) => l.startsWith(`- "${name}"`)) || '');
    eq([line(obs, 'Fix the build'), line(obs, 'Port the parser'), line(lead, 'Fix the build'), line(lead, 'Port the parser'),
      obs.includes(' You lead 1 of them and observe 1. '), obs.includes('A conversation you observe you only read and report on'),
      docs.includes(' You observe it. '), lead.includes(' You lead 1 of them and observe 1. ')],
    [`- "Fix the build" (${M}): observer (lead: "Release supervisor"); not running`, `- "Port the parser" (${M2}): lead; not running`,
      `- "Fix the build" (${M}): lead; not running`, `- "Port the parser" (${M2}): observer (lead: "Night supervisor"); not running`,
      true, true, true, true],
    'each line of a supervisor\'s list says lead, or observer and which supervisor leads it, and the first sentence counts the ones it observes');

    write(d, { lead: { lead: OBS, term: 4, why: 'takeover', was: LEAD } });
    const won = turn(d, OBS), lost = turn(d, LEAD), wonAgain = turn(d, OBS), lostAgain = turn(d, LEAD);
    eq([won.includes('\nLead changes since your previous turn: you now lead "Fix the build".'),
      lost.includes(`\nLead changes since your previous turn: you no longer lead "Fix the build" (${NAME(OBS)} does) and observe it now.`),
      [won, lost].some((t) => t.includes('Nothing has changed')), [wonAgain, lostAgain].map((t) => t.includes('Lead changes')),
      [wonAgain, lostAgain].every((t) => t.includes('Nothing has changed'))],
    [true, true, false, [false, false], true],
    'a change of lead makes the list differ from the one before, and the turn after it says once which conversations the supervisor '
      + 'now leads or no longer leads');
  }

  /* --said marks a lead's hand-over note and a new lead's first message. */
  {
    const project = path.join(config, 'projects', 'q');
    fs.mkdirSync(project, { recursive: true });
    const row = (minute, content) => JSON.stringify({ type: 'user', timestamp: `2026-11-28T10:0${minute}:00.000Z`, message: { content } });
    fs.writeFileSync(path.join(project, `${M2}.jsonl`), [
      row(0, 'Fix the build.'),
      row(1, 'From your lead supervisor "Release supervisor": from now on your lead supervisor is "Night supervisor".\nYou were fixing the test.'),
      row(2, 'From your new lead supervisor "Night supervisor": "Release supervisor" is no longer open.\nCarry on.'),
      row(3, 'What does From your lead supervisor "x": mean?'),
    ].join('\n') + '\n');
    const r = cp.spawnSync(python, ['-B', path.join(hooks, 'steward-peek.py'), '--said', M2, tmp('told-peek')], { encoding: 'utf8', env });
    const out = r.stdout || '';
    eq([out.split(' (sent by the supervisor "Release supervisor", not typed by the user there):').length - 1,
      out.split(' (sent by the supervisor "Night supervisor", not typed by the user there):').length - 1,
      out.includes('2026-11-28 10:03:00 UTC:\n  What does'), out.includes('2026-11-28 10:00:00 UTC:\n  Fix the build.')],
    [1, 1, true, true],
    '--said marks a hand-over note and a new lead\'s first message with the supervisor its first line names, and not a message that only quotes such a line');
  }

  /* SendMessage from a supervisor. */
  {
    const sleepers = [1, 2, 3, 4].map(() => cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }));
    try {
      const sessions = path.join(config, 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      const records = [[process.pid, 'fix-build', M], [sleepers[0].pid, 'port-parser', M2], [sleepers[1].pid, 'scratch', LOOSE],
        [sleepers[2].pid, 'twin', M], [sleepers[3].pid, 'Twin', LOOSE], [2 ** 22 + 7, 'gone', M]];
      for (const [pid, name, sessionId] of records) {
        fs.writeFileSync(path.join(sessions, `${pid}.json`),
          JSON.stringify({ pid, sessionId, name, messagingSocketPath: `/run/cc-socks/${pid}.sock`, status: 'idle' }));
      }
      const d = world({ more: { [OTHER]: { manages: [M2], at: 4, title: TITLES[OTHER] } } });
      const send = (as, to, data = d, tool = 'SendMessage') => {
        const r = cp.spawnSync(python, ['-B', path.join(hooks, 'steward-send-guard.py'), data], { encoding: 'utf8', env,
          input: JSON.stringify({ session_id: as, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { to, message: 'How is it going?' } }) });
        if (!r.stdout.trim()) return r.stderr ? `(stderr) ${r.stderr.slice(-300)}` : 'allowed';
        const o = JSON.parse(r.stdout).hookSpecificOutput;
        return o.permissionDecision === 'deny' ? o.permissionDecisionReason : JSON.stringify(o);
      };
      const tail = ` A supervisor sends nothing with SendMessage to a conversation it does not lead. Read it with steward-peek.py, and to act on it run steward-relay.py --take-lead ${M} --ask and ask the user.`;
      const observed = `Not sent: "Fix the build" is led by ${NAME(LEAD)}; you observe it.${tail}`;
      eq([send(OBS, 'fix-build'), send(OBS, 'fix-build [a1b2c3]'), send(OBS, M.toUpperCase()), send(OTHER, 'fix-build'),
        send(LEAD, 'port-parser').startsWith(`Not sent: "Port the parser" is led by ${NAME(OBS)}; you observe it.`)],
      [observed, observed, observed, `Not sent: "Fix the build" is led by ${NAME(LEAD)}.${tail}`, true],
      'a supervisor\'s SendMessage to a conversation another supervisor leads is refused, the recipient found by its session name, with or '
        + 'without a reference after it, or by its session id, also when the supervisor does not manage it');
      eq([send(LEAD, 'fix-build'), send(OBS, 'port-parser'), send(OBS, 'scratch'), send(OBS, 'main'), send(OBS, 'twin'), send(OBS, 'gone'),
        send(M, 'port-parser'), send(NOBODY, 'fix-build'), send(OBS, 'fix-build', d, 'Bash')],
      ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed'],
      'the lead\'s own SendMessage goes through, and so does one to a conversation no supervisor has on its list, to "main", to a name two '
        + 'running sessions share when only one is managed, to a session that is no longer running, one from a conversation that is no '
        + 'supervisor, and any other tool');
      eq(send(OBS, 'fix-build', world({ lead: { lead: '' } })),
        `Not sent: "Fix the build" has no lead supervisor now.${tail}`, 'SendMessage to a managed conversation with no lead is refused too');
    } finally {
      for (const k of sleepers) k.kill();
    }
  }
};
