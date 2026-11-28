// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The lead of a managed conversation in the shared Python: steward_table.py reads it from stewards.json of version 4,
 * and steward-relay.py writes each request with the conversation's lead term and a sequence number, refuses before
 * writing one what another supervisor leads, asks the window to take a conversation over or hand it over, sends a
 * hand-off only to the lead, and prints the window's reasons as they are. A small stand-in for a window answers the
 * requests, as Claude Code Plus would.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const S = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
const LEAD = S(1), OBS = S(2), OBS2 = S(3), M = S(4), M2 = S(5), NOBODY = S(9);
const TITLES = { [LEAD]: 'Release supervisor', [OBS]: 'Night supervisor', [OBS2]: 'Docs supervisor' };
const NAME = (s) => `"${TITLES[s]}" (${s})`;
const NOT_HANDED = ' Say in your reply where it seems to belong, so the user decides.';

module.exports = async ({ eq, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the checks of the supervisor leads were not run'); return; }
  const shared = path.join(root, 'shared', 'plugin');
  const hooks = path.join(tmp('leads-plugin'), 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(hooks, f));
  for (const f of fs.readdirSync(path.join(shared, 'claude')).filter((x) => x.endsWith('.py'))) {
    fs.copyFileSync(path.join(shared, 'claude', f), path.join(hooks, f));
  }
  const config = tmp('leads-config');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CLAUDE_CONFIG_DIR: config };
  const py = (body) => {
    const r = cp.spawnSync(python, ['-B', '-c', `import json, sys\nsys.path.insert(0, ${JSON.stringify(hooks)})\n${body}`],
      { encoding: 'utf8', env });
    try { return JSON.parse(r.stdout); } catch (_) { return { status: r.status, err: (r.stderr || '').slice(-600) }; }
  };

  const stewards = () => ({
    [LEAD]: { manages: [M, M2], at: 1, title: TITLES[LEAD], names: { [M]: 'Fix the build', [M2]: 'Port the parser' } },
    [OBS]: { manages: [M, M2], at: 2, title: TITLES[OBS], names: { [M]: 'Fix the build', [M2]: 'Port the parser' } },
    [OBS2]: { manages: [M], at: 3, title: TITLES[OBS2], names: { [M]: 'Fix the build' } },
  });
  const leads = (over = {}) => ({ [M]: Object.assign({ lead: LEAD, term: 3, at: 1, why: 'first' }, over),
    [M2]: { lead: OBS, term: 1, at: 1, why: 'first' } });
  /* A data directory with a table and one window entry, from this process, that shows `showing`. */
  const world = ({ version = 4, lead = {}, tickets, showing = [LEAD, OBS, OBS2], noLeads = false } = {}) => {
    const d = tmp('leads-data');
    const t = { version, stewards: stewards() };
    if (!noLeads) t.leads = leads(lead);
    if (tickets) t.tickets = tickets;
    fs.writeFileSync(path.join(d, 'stewards.json'), JSON.stringify(t));
    fs.mkdirSync(path.join(d, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(d, 'windows', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, at: Date.now(), name: 'Main', folders: [], sessions: showing }));
    fs.mkdirSync(path.join(d, 'relay'), { recursive: true });
    return d;
  };
  /* Runs steward-relay.py as `as`, answering each request it writes like a window, with `answer(request)`. */
  const relay = async (data, as, args, { input = '', answer, skip = [] } = {}) => {
    const dir = path.join(data, 'relay');
    const kid = cp.spawn(python, ['-B', path.join(hooks, 'steward-relay.py'), ...args, data],
      { env: { ...env, CLAUDE_CODE_SESSION_ID: as } });
    let out = '', err = '';
    kid.stdout.on('data', (d) => { out += d; });
    kid.stderr.on('data', (d) => { err += d; });
    kid.stdin.end(input);
    const asked = [];
    const timer = setInterval(() => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { return; }
      for (const n of names) {
        const m = /^([0-9a-f-]{36})(\.v4)?\.json$/.exec(n);
        if (!m || skip.includes(m[1])) continue;
        let req;
        try { req = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
        fs.unlinkSync(path.join(dir, n));
        asked.push(Object.assign({ file: n }, req));
        fs.writeFileSync(path.join(dir, m[1] + '.result.json'), JSON.stringify(answer ? answer(req) : { outcome: 'submitted' }));
      }
    }, 40);
    const code = await new Promise((r) => kid.on('close', r));
    clearInterval(timer);
    return { code, out, err, asked };
  };

  /* Reading the table. */
  {
    const read = (file) => {
      const d = tmp('leads-read');
      fs.writeFileSync(path.join(d, 'stewards.json'), JSON.stringify(file));
      return py([
        'import steward_table as t',
        `table = t.read(${JSON.stringify(d)})`,
        `print(json.dumps([t.lead_of(table, "${M}"), t.role_of(table, "${LEAD}", "${M}"), t.role_of(table, "${OBS}", "${M}"),`,
        `  t.role_of(table, "${NOBODY}", "${M}"), t.term_of(table, "${M}"), t.lead_entry(table, "${M}"), table.tickets, table.version,`,
        `  sorted(table), t.lead_of(table, "${OBS}")]))`,
      ].join('\n'));
    };
    const v4 = read({ version: 4, stewards: stewards(), rev: 7,
      leads: { [M]: { lead: LEAD.toUpperCase(), term: 3, at: 10, why: 'takeover', was: OBS, pending: { to: OBS2, at: 20, by: 'consent' },
        tell: { kind: 'handover', from: OBS, text: 'Keep the tests running.', at: 30 } } },
      tickets: { [`${OBS} ${M}`]: { at: 40, term: 3 }, [OBS]: { at: 1, term: 1 }, [`nobody ${M}`]: { at: 1, term: 1 } } });
    eq(v4, [LEAD, 'lead', 'observer', '', 3,
      { lead: LEAD, term: 3, at: 10, why: 'takeover', was: OBS, pending: { to: OBS2, at: 20, by: 'consent' },
        tell: { kind: 'handover', from: OBS, text: 'Keep the tests running.', at: 30 } },
      { [`${OBS} ${M}`]: { at: 40, term: 3 } }, 4, [LEAD, OBS, OBS2].sort(), ''],
    'a version 4 table gives each conversation its lead, in lower case, its term, a pending hand-over and an untold note; '
      + 'its other supervisors observe it, one that does not manage it has no role, and only well-formed take-over questions are read');

    const v3 = read({ version: 3, stewards: stewards() });
    eq(v3.slice(0, 8), ['', 'observer', 'observer', '', 0, null, {}, 3],
      'a version 3 table has no lead for any conversation and no term: every supervisor that manages one observes it until a window assigns a lead');

    const v5 = read({ version: 5, stewards: stewards(), leads: { [M]: { lead: OBS, term: 9, at: 1, why: 'something new', extra: 1 } } });
    eq([v5[0], v5[2], v5[4], v5[5].why, v5[7]], [OBS, 'lead', 9, 'first', 5],
      'a table of a later version is read for what this build understands: its leads, with a reason this build does not know read as "first"');

    const settle = (people, lead) => read({ version: 4, stewards: people, leads: { [M]: { lead, term: 2, at: 1, why: 'first' } } })[0];
    const gone = stewards(); gone[LEAD].manages = [M2];
    const notOne = stewards(); delete notOne[LEAD];
    const managedNow = stewards(); managedNow[LEAD] = { manages: [], at: 0 }; managedNow[OBS].manages = [M, LEAD];
    eq([settle(gone, LEAD), settle(notOne, LEAD), settle(managedNow, LEAD), settle(stewards(), 'not-an-id'), settle(stewards(), OBS)],
      ['', '', '', '', OBS],
      'a lead that no longer has the conversation on its list, is no supervisor, or is now itself a managed conversation, '
      + 'and a lead that is no session id, all read as no lead');

    const odd = read({ version: 4, stewards: stewards(),
      leads: { [M]: { lead: LEAD, term: '3', at: -1, why: 7, pending: { to: 'x', at: 1 }, tell: { kind: 'shout', text: 'x' } },
        [OBS]: { lead: LEAD, term: 1 } } });
    eq([odd[0], odd[4], odd[5], odd[9]], [LEAD, 0, { lead: LEAD, term: 0, at: 0, why: 'first', was: '' }, ''],
      'malformed fields of a lead entry are dropped or read as nothing: a term or time that is no positive number, an unknown '
      + 'reason, a pending hand-over to no session, a note of an unknown kind; and a supervisor has no lead, whatever the table says');
  }

  /* Flags that are gone. */
  {
    const d = world();
    const anyway = await relay(d, LEAD, ['--anyway', M], { input: 'Ship it.' });
    const to = await relay(d, M, ['--handoff', '--to', OBS], { input: 'This belongs to the docs work.' });
    eq([anyway.code, anyway.out.split('\n')[0], anyway.asked.length, to.code, to.out.split('\n')[0], to.asked.length],
      [2, 'usage error: --anyway is gone: only a conversation\'s lead sends it messages, so no other supervisor\'s message holds yours back.', 0,
        2, 'usage error: --to is gone: a hand-off always goes to the conversation\'s lead supervisor.', 0],
      '--anyway and --to are usage errors that say the flag is gone, and nothing is asked of a window');
  }

  /* A lead's request: the new file name, its lead term and its sequence number. */
  {
    const d = world();
    const dir = path.join(d, 'relay');
    const [a, b, c] = ['a', 'b', 'c'].map((x) => `${x.repeat(8)}-1111-4111-8111-${x.repeat(12)}`);
    fs.writeFileSync(path.join(dir, `${a}.taken-123`), JSON.stringify({ id: a, to: M, seq: 6 }));
    fs.writeFileSync(path.join(dir, `${b}.v4.json`), JSON.stringify({ id: b, to: M, seq: 4 }));
    fs.writeFileSync(path.join(dir, `${c}.v4.json`), JSON.stringify({ id: c, to: M2, seq: 9 }));
    const sent = await relay(d, LEAD, [M], { input: 'Run the tests again.\n', skip: [b, c] });
    const r = sent.asked[0] || {};
    eq([sent.code, sent.out.trim(), sent.asked.length, /^[0-9a-f-]{36}\.v4\.json$/.test(r.file || ''), r.action, r.to, r.steward, r.text, r.term, r.seq],
      [0, 'Sent: it was typed into the conversation\'s message input and sent as the user\'s message.', 1, true, 'send', M, LEAD,
        'Run the tests again.', 3, 7],
      'the lead\'s message is written as <id>.v4.json with the conversation\'s lead term and one more than the highest sequence '
      + 'number among the requests for that conversation, taken ones included');
    const first = await relay(world({ noLeads: true }), LEAD, [M2], { input: 'Carry on.' });
    eq([first.asked[0] && first.asked[0].term, first.asked[0] && first.asked[0].seq], [0, 1],
      'a conversation with no lead entry yet is asked with term 0, and the first request for a conversation gets 1');
  }

  /* An observer is refused before a request is written, whatever it asks. */
  {
    const d = world();
    const why = `"Fix the build" is led by ${NAME(LEAD)}; you observe it. To act on it, run steward-relay.py --take-lead ${M} --ask and ask the user.`;
    const runs = [
      await relay(d, OBS, [M], { input: 'Stop and wait.' }),
      await relay(d, OBS, ['--rename', M], { input: 'Build fix' }),
      await relay(d, OBS, ['--close', M]),
      await relay(d, OBS, ['--resume', M], { input: 'Go on.' }),
      await relay(d, OBS, ['--archive', M, M2]),
    ];
    eq(runs.map((r) => [r.code, r.out.trim().split('\n')[0]]), [
      [1, `Not sent: ${why}`], [1, `Not done: ${why}`], [1, `Not done: ${why}`], [1, `Not done: ${why}`],
      [1, `Not archived: "Fix the build" (${M}): ${why}`]],
    'a message, a rename, a close, a resume and an archive from a supervisor that observes the conversation are refused with the '
      + 'window\'s reason, naming its lead');
    eq([runs.slice(0, 4).every((r) => r.asked.length === 0), runs[4].asked.map((r) => [r.action, r.ids, r.terms])],
      [true, [['archive', [M2], { [M2]: 1 }]]],
      'none of them writes a request, except an archive of the conversations it leads, each with its lead term');
    const pending = world({ lead: { pending: { to: OBS, at: Date.now(), by: 'consent' } } });
    const waiting = await relay(pending, OBS, [M], { input: 'Stop and wait.' });
    eq([waiting.code, waiting.out.trim(), waiting.asked.length],
      [1, `Not sent: "Fix the build" is being handed over from ${NAME(LEAD)} to you; wait for ${NAME(LEAD)}'s hand-over.`, 0],
      'the supervisor a conversation is being handed over to is told to wait for the hand-over');
  }

  /* The window's reasons are printed as they are. */
  {
    const d = world();
    const reasons = [
      `"Fix the build" is led by ${NAME(OBS)}; you observe it. To act on it, run steward-relay.py --take-lead ${M} --ask and ask the user.`,
      `"Fix the build" has no lead supervisor now; run steward-relay.py --take-lead ${M} --ask and ask the user.`,
      `The lead of "Fix the build" changed after you wrote this request; it is ${NAME(OBS)} now.`,
      `"Fix the build" is being handed over from ${NAME(LEAD)} to ${NAME(OBS2)}.`,
      `"Fix the build" is being handed over from ${NAME(LEAD)} to you; wait for ${NAME(LEAD)}'s hand-over.`,
      `The take-over question for "Fix the build" was asked more than 30 minutes ago. Ask the user again with --take-lead ${M} --ask.`,
      `Only ${NAME(LEAD)}, the lead handing "Fix the build" over, can send its hand-over.`,
    ];
    const sends = [], renames = [], takes = [], gives = [];
    for (const reason of reasons) {
      const refuse = () => ({ outcome: 'refused', reason });
      sends.push((await relay(d, LEAD, [M], { input: 'Go on.', answer: refuse })).out.trim());
      renames.push((await relay(d, LEAD, ['--rename', M], { input: 'Build fix', answer: refuse })).out.trim());
      takes.push((await relay(d, OBS, ['--take-lead', M, '--ask'], { answer: refuse })).out.trim());
      gives.push((await relay(d, LEAD, ['--hand-over', M], { input: 'Over to the night supervisor.', answer: refuse })).out.trim());
    }
    eq([sends, renames, takes, gives],
      [reasons.map((r) => `Not sent: ${r}`), reasons.map((r) => `Not done: ${r}`), reasons.map((r) => `Not done: ${r}`),
        reasons.map((r) => `Not done: ${r}`)],
      'every reason a window gives for refusing a message, a rename, a take-over or a hand-over is printed word for word, after "Not sent" or "Not done"');
  }

  /* Taking a conversation over. */
  {
    const question = `Should I (${NAME(OBS)}) take over "Fix the build"? It is led by ${NAME(LEAD)} now. If you agree, ${NAME(LEAD)} becomes an observer and I go on with what you asked.`;
    const d = world();
    const ask = await relay(d, OBS, ['--take-lead', M, '--ask'], { answer: () => ({ outcome: 'ask', question }) });
    const r = ask.asked[0] || {};
    eq([ask.code, r.action, r.ask, r.to, r.steward, r.term, r.seq, /\.v4\.json$/.test(r.file || ''), ask.out.split('\n').includes(question),
      /^Ask the user exactly this, word for word, and end your turn/.test(ask.out), ask.out.includes(`Then run steward-relay.py --take-lead ${M}, without --ask.`)],
    [0, 'take-lead', true, M, OBS, 3, 1, true, true, true, true],
    '--take-lead --ask writes a take-lead request with ask set, the lead term and a sequence number, and prints the window\'s question '
      + 'on a line of its own, with what to do: ask the user exactly that, end the turn, and only after a clear yes run --take-lead');

    const again = ` Ask the user again with --take-lead ${M} --ask.`;
    const none = await relay(d, OBS, ['--take-lead', M]);
    const old = await relay(world({ tickets: { [`${OBS} ${M}`]: { at: Date.now() - 31 * 60000, term: 3 } } }), OBS, ['--take-lead', M]);
    const moved = await relay(world({ tickets: { [`${OBS} ${M}`]: { at: Date.now() - 60000, term: 2 } } }), OBS, ['--take-lead', M]);
    eq([none, old, moved].map((x) => [x.code, x.out.trim(), x.asked.length]), [
      [1, `Not done: you have not asked the user whether to take over "Fix the build".${again}`, 0],
      [1, `Not done: you asked the user about taking over "Fix the build" more than 30 minutes ago.${again}`, 0],
      [1, `Not done: the lead of "Fix the build" changed after you asked the user.${again}`, 0]],
    '--take-lead without a question asked, with one asked more than 30 minutes ago, or with the lead changed since, is refused '
      + 'before a request is written, saying to ask the user again');

    const asked = { tickets: { [`${OBS} ${M}`]: { at: Date.now() - 60000, term: 3 } } };
    const agreed = await relay(world(asked), OBS, ['--take-lead', M], { answer: () => ({ outcome: 'pending', lead: LEAD }) });
    const now = await relay(world(asked), OBS, ['--take-lead', M], { answer: () => ({ outcome: 'lead' }) });
    const busy = await relay(world({ ...asked, lead: { pending: { to: OBS2, at: Date.now(), by: 'consent' } } }), OBS, ['--take-lead', M]);
    const mine = await relay(world(), LEAD, ['--take-lead', M, '--ask']);
    const t = agreed.asked[0] || {};
    eq([t.action, t.ask, t.to, t.term, agreed.code, agreed.out.trim().startsWith(`Agreed: ${NAME(LEAD)} is asked to hand "Fix the build" over to you`),
      now.code, now.out.trim().startsWith('You lead "Fix the build" now. A notice asks you to send it a first message saying so'),
      busy.code, busy.out.trim(), busy.asked.length, mine.code, mine.out.trim(), mine.asked.length],
    ['take-lead', false, M, 3, 0, true, 0, true,
      1, `Not done: "Fix the build" is being handed over from ${NAME(LEAD)} to ${NAME(OBS2)}.`, 0,
      0, 'You already lead "Fix the build"; act on it as the user asked.', 0],
    'after the user agreed, --take-lead writes a take-lead request without ask and says the lead is asked to hand it over, or that '
      + 'this supervisor leads it now; one being handed over to another supervisor is refused, and the lead is told it leads it already');
  }

  /* Handing a conversation over. */
  {
    const handing = { lead: { pending: { to: OBS, at: Date.now(), by: 'consent' } } };
    const stranger = await relay(world(handing), OBS2, ['--hand-over', M], { input: 'Over to the docs supervisor.' });
    const taker = await relay(world(handing), OBS, ['--hand-over', M], { input: 'I take over.' });
    const why = `Not done: Only ${NAME(LEAD)}, the lead handing "Fix the build" over, can send its hand-over.`;
    eq([stranger.code, stranger.out.trim(), stranger.asked.length, taker.code, taker.out.trim(), taker.asked.length],
      [1, why, 0, 1, why, 0],
      '--hand-over from a supervisor other than the lead handing the conversation over, the one it goes to included, is refused before a request is written');
    const note = 'You were fixing the flaky build test. The night supervisor takes over.';
    const done = await relay(world(handing), LEAD, ['--hand-over', M], { input: note + '\n', answer: () => ({ outcome: 'submitted', lead: OBS }) });
    const kept = await relay(world(handing), LEAD, ['--hand-over', M], { input: note, answer: () => ({ outcome: 'kept', lead: OBS }) });
    const after = `The hand-over of "Fix the build" is finished; ${NAME(OBS)} leads it now.`;
    const late = await relay(world({ lead: { lead: OBS, term: 4, was: LEAD } }), LEAD, ['--hand-over', M],
      { input: note, answer: () => ({ outcome: 'refused', reason: after }) });
    const h = done.asked[0] || {};
    eq([h.action, h.to, h.text, h.steward, h.term, done.code, done.out.trim(), kept.code, kept.out.trim().startsWith('Handed over: "Fix the build" is not open in a VS Code window'),
      late.code, late.out.trim(), late.asked.length],
    ['hand-over', M, note, LEAD, 3, 0, `Handed over: the note was sent to "Fix the build", and ${NAME(OBS)} leads it now; you observe it.`, 0, true,
      1, `Not done: ${after}`, 1],
    'the lead\'s --hand-over writes a hand-over request with the note from standard input and says who leads the conversation now, '
      + 'also when the note waits for the conversation\'s next turn; once the hand-over is done, a second one goes to the window, whose refusal is printed');
  }

  /* A hand-off from a managed conversation goes to its lead only. */
  {
    const project = path.join(config, 'projects', 'p');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${M}.jsonl`), JSON.stringify({ type: 'user', message: {
      content: `Sent by the supervisor "Night supervisor" (${OBS}) for the user:\nDeploy the docs.` } }) + '\n');
    const words = 'The user asked for the docs deploy; it belongs to the docs work.';
    const handed = await relay(world(), M, ['--handoff'], { input: words,
      answer: (req) => ({ outcome: 'submitted', steward: req.to, stewardTitle: TITLES[req.to] }) });
    const h = handed.asked[0] || {};
    eq([handed.code, h.action, h.to, h.from, h.term, h.text, handed.out.trim().startsWith(`Handed off to your lead supervisor ${NAME(LEAD)}:`),
      [TITLES[OBS], TITLES[OBS2], OBS, OBS2].some((x) => handed.out.includes(x))],
    [0, 'handoff', LEAD, M, 3, words, true, false],
    '--handoff asks for the conversation\'s lead, with its lead term, even when another supervisor\'s message started the turn, and '
      + 'names only the lead');
    const away = await relay(world({ showing: [OBS, OBS2] }), M, ['--handoff'], { input: words });
    const leaderless = await relay(world({ lead: { lead: '' } }), M, ['--handoff'], { input: words });
    const old = await relay(world({ version: 3, noLeads: true }), M, ['--handoff'], { input: words });
    eq([away, leaderless, old].map((x) => [x.code, x.out.trim(), x.asked.length]), [
      [1, `Not done: its lead supervisor is not open in a VS Code window, so it cannot be told.${NOT_HANDED}`, 0],
      [1, `Not done: no supervisor leads this conversation now, so it cannot be handed off.${NOT_HANDED}`, 0],
      [1, `Not done: no supervisor leads this conversation now, so it cannot be handed off.${NOT_HANDED}`, 0]],
    'a hand-off is refused without a request when the lead is not open in a window, even with its observers open, and when the '
      + 'conversation has no lead; the observers are not named');
  }

  /* A request no window takes: a window of an older build shows the conversation but leaves a new request alone. */
  {
    const quick = (data, as, argv, input) => {
      const r = cp.spawnSync(python, ['-B', '-c', [
        'import importlib.util, sys',
        'spec = importlib.util.spec_from_file_location("relay", sys.argv[1])',
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'm.WAIT_SECONDS = m.OTHER_WAIT_SECONDS = 1',
        'sys.exit(m.main(["steward-relay.py"] + sys.argv[2:]))'].join('\n'), path.join(hooks, 'steward-relay.py'), ...argv, data],
      { input, encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: as } });
      return [r.status, (r.stdout || r.stderr).trim(), fs.readdirSync(path.join(data, 'relay')).length];
    };
    const reload = ' The VS Code window "Main" shows it but took no request; it may run an older build of Claude Code Plus, which does '
      + 'not take requests from this one. Ask the user to reload that window.';
    eq([quick(world(), LEAD, [M], 'Go on.'), quick(world({ showing: [LEAD, M] }), LEAD, [M], 'Go on.'),
      quick(world({ showing: [M] }), OBS, ['--take-lead', M, '--ask'], '')], [
      [1, 'Not done: no VS Code window that shows that conversation took the request. If no window has it open, --resume opens it.', 0],
      [1, `Not done: no VS Code window that shows that conversation took the request.${reload}`, 0],
      [1, 'Not done: no VS Code window that shows this supervisor conversation took the request.', 0]],
    'a request no window took is withdrawn; when a window shows the conversation, the script says that window may run an older build and '
      + 'should be reloaded');
    eq(quick(world({ showing: [OBS] }), OBS, ['--take-lead', M, '--ask'], '')[1],
      `Not done: no VS Code window that shows this supervisor conversation took the request.${reload}`,
      'the same for a request that the window showing the supervisor itself should take');
  }

  /* What a new or reopened conversation's answer says. */
  {
    const d = world();
    const folder = tmp('leads-folder');
    const opened = await relay(d, LEAD, ['--open', folder], { input: 'Port the reader.',
      answer: () => ({ outcome: 'submitted', ticked: true, sessionId: S(6) }) });
    const resumed = py([
      'import importlib.util',
      `spec = importlib.util.spec_from_file_location("relay", ${JSON.stringify(path.join(hooks, 'steward-relay.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(json.dumps(m.resume_said({"outcome": "submitted", "ticked": True}, "Main", "Go on.")))',
    ].join('\n'));
    eq([opened.code, opened.out.split('\n')[0], resumed[0].endsWith('It is now ticked for you in the Supervisor panel. You are its lead supervisor.')],
      [0, 'Opened: a new conversation was started and its first message sent. It is now ticked for you in the Supervisor panel. You are its lead supervisor.', true],
      'a conversation the supervisor opened or reopened is said to be led by it');
  }
};
