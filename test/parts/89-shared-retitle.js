// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * request_retitle in the shared Python and retitle.py around it, against a stand-in host in the same Python process:
 * a thread that claims a request by renaming it, as docs/protocol.md "Retitle requests" says a window does, and
 * answers it, or claims it and never answers.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, note, tmp, root }) => {
  const python = ['python3', 'python'].find((p) => cp.spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 7)']).status === 0);
  if (!python) { note('no Python 3.7 or later here: the retitle request was not run'); return; }
  const shared = path.join(root, 'shared', 'plugin');
  const hooksOf = {};
  for (const agent of ['claude', 'codex', 'opencode']) {
    const dir = path.join(tmp(`retitle-hooks-${agent}`), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(shared, 'hooks'))) fs.copyFileSync(path.join(shared, 'hooks', f), path.join(dir, f));
    fs.copyFileSync(path.join(shared, agent, 'plan_agent.py'), path.join(dir, 'plan_agent.py'));
    hooksOf[agent] = dir;
  }
  const dir = tmp('retitle-plans');
  const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const script = `
import json, os, subprocess, sys, threading, time
sys.path.insert(0, ${JSON.stringify(hooksOf.claude)})
import plan_common as C
base = ${JSON.stringify(dir)}
folder = os.path.join(base, C.RETITLE_DIR)

def host(answer, seen):
    """Claims the first request that shows up and, unless answer is None, writes that answer for it."""
    end = time.time() + 20
    while time.time() < end:
        names = [n for n in os.listdir(folder)] if os.path.isdir(folder) else []
        req = [n for n in names if n.endswith('.json') and not n.endswith('.result.json')
               and C.RETITLE_KEY.match(n[:-5])]
        if req:
            key = req[0][:-5]
            claimed = os.path.join(folder, key + '.claimed')
            os.rename(os.path.join(folder, req[0]), claimed)
            with open(claimed, encoding='utf-8') as fh:
                seen.append(json.load(fh))
            if answer is not None:
                C.write_atomic(os.path.join(folder, key + '.result.json'), json.dumps(dict(answer, format=1, key=key, at=1)))
                os.remove(claimed)
            return
        time.sleep(0.05)

def ask(answer, title, **kw):
    seen = []
    t = threading.Thread(target=host, args=(answer, seen))
    if answer is not False:
        t.start()
    got = C.request_retitle(${JSON.stringify(SID)}, title, directory=base, **kw)
    if answer is not False:
        t.join()
    left = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    for n in left:
        os.remove(os.path.join(folder, n))
    return got, seen, left

out = {}
got, seen, left = ask({'outcome': 'done', 'reason': '', 'title': 'Parser rewrite'}, '  Parser   rewrite 📩 ')
out['done'] = [got, seen[0]['format'], bool(C.RETITLE_KEY.match(seen[0]['key'])), seen[0]['agent'], seen[0]['sessionId'],
               seen[0]['title'], seen[0]['via'], left]
got, seen, left = ask(False, 'Nobody takes this', wait=0.4)
out['untaken'] = [got['outcome'], left]
got, seen, left = ask(None, 'Taken, never answered', wait=0.4, claimed_wait=0.4)
out['unclear'] = [got['outcome'], [n.endswith('.claimed') for n in left]]
out['refused'] = [C.request_retitle('not an id', 'x', directory=base)['outcome'],
                  C.request_retitle(${JSON.stringify(SID)}, '   ', directory=base)['outcome'],
                  C.request_retitle(${JSON.stringify(SID)}, 'x' * (C.RETITLE_MAX_CHARS + 1), directory=base)['outcome'],
                  os.path.isdir(folder) and os.listdir(folder)]

def command(agent, env, title, answer):
    seen = []
    t = threading.Thread(target=host, args=(answer, seen))
    if answer is not False:
        t.start()
    e = dict(os.environ)
    for k in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'):
        e.pop(k, None)
    e.update(env)
    hooks = json.loads(sys.argv[1])[agent]
    r = subprocess.run([sys.executable, '-B', os.path.join(hooks, 'retitle.py'), base], input=title.encode('utf-8'),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e, timeout=60)
    if answer is not False:
        t.join()
    return [r.returncode, r.stdout.decode('utf-8').strip(), seen[0]['title'] if seen else None, seen[0]['via'] if seen else None]

out['command'] = command('claude', {'CLAUDE_CODE_SESSION_ID': ${JSON.stringify(SID)}}, 'Release notes\\n',
                         {'outcome': 'done', 'reason': '', 'title': 'Release notes'})
out['refusedBack'] = command('claude', {'CLAUDE_CODE_SESSION_ID': ${JSON.stringify(SID)}}, 'Release notes',
                             {'outcome': 'refused', 'reason': 'this conversation did not run that command', 'title': ''})
out['noEnv'] = command('claude', {}, 'Release notes', False)
out['opencode'] = command('opencode', {}, 'Release notes', False)
print(json.dumps(out, ensure_ascii=False))
`;
  const r = cp.spawnSync(python, ['-B', '-c', script, JSON.stringify(hooksOf)], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  let got = null;
  try { got = JSON.parse(r.stdout); } catch (_) { got = { status: r.status, err: (r.stderr || '').slice(-600) }; }
  eq(got.done, [{ outcome: 'done', reason: '', title: 'Parser rewrite' }, 1, true, 'Claude Code', SID, '  Parser   rewrite 📩 ', 'command', []],
    'a request names the agent, the conversation and the title as given, and the answer a window writes comes back; no file is left');
  eq(got.untaken, ['untaken', []], 'a request no window takes is withdrawn when the wait ends, and says so');
  eq(got.unclear, ['unclear', [true]], 'a request a window took and never answered says that it is unclear');
  eq(got.refused, ['refused', 'refused', 'refused', []], 'an id of the wrong shape, an empty title and an overlong one are refused without writing anything');
  eq(got.command, [0, "Renamed: the conversation is now titled 'Release notes'.", 'Release notes', 'command'],
    'retitle.py reads the title from standard input and the conversation from the agent\'s variable, and says what came of it');
  eq(got.refusedBack && got.refusedBack.slice(0, 2), [1, 'Not renamed: this conversation did not run that command.'], 'and a refusal comes back with its reason');
  eq(got.noEnv && got.noEnv.slice(0, 3), [1, 'Not renamed: Claude Code does not say which conversation runs this command (CLAUDE_CODE_SESSION_ID is not set).', null],
    'without the variable it asks nothing');
  eq(got.opencode && got.opencode.slice(0, 3), [1, 'Not renamed: OpenCode does not say which conversation runs a command; use the set_title tool instead.', null],
    'and in OpenCode, which names no conversation in a command\'s environment, it asks nothing either');
};
