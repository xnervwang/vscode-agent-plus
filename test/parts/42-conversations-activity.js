// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation's activity in the Conversations list (src/conversations.js): its source's, except that a question in
 * its plan put after the user's last message makes it wait for the user once its turn is no longer running. A question
 * from before that message, and any
 * question of a conversation whose source gives no lastUserAt, leaves the activity as the source has it.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root }) => {
  const conv = require(path.join(root, 'src', 'conversations.js'));
  const src = require(path.join(root, 'src', 'sources.js'));
  const { readPlanAt } = require(path.join(root, 'src', 'workplan.js'));
  const base = tmp('activity');
  const ws = path.join(base, 'ws'), plans = path.join(base, 'plans');
  for (const d of [ws, plans]) fs.mkdirSync(d);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const lastUser = now - 3600e3;
  const ask = (asked, extra = {}) => [Object.assign({ title: 'pick', state: 'waiting', waitingOn: 'user', question: 'Which one?' },
    asked ? { asked: iso(asked) } : {}, extra)];
  const files = {};
  const plan = (id, nodes) => { const f = path.join(plans, id + '.json'); fs.writeFileSync(f, JSON.stringify({ nodes })); files[id] = f; };
  plan('later', ask(lastUser + 60e3));
  plan('earlier', ask(lastUser - 3 * 86400e3));
  plan('noUser', ask(now - 1000));
  plan('since', ask(0, { since: iso(lastUser + 5e3) }));
  plan('undated', ask(0));
  plan('stopped', ask(lastUser + 60e3));
  plan('busy', ask(lastUser + 60e3));
  const planOf = (sourceId, id) => ({ file: files[id] || '', plan: files[id] ? readPlanAt(files[id], id) : null });
  const C = (o) => src.conversation(Object.assign({ cwd: ws, running: true, lastActiveAt: now, lastUserAt: lastUser }, o));
  const data = conv.assemble({ folders: [ws], planOf, now, lists: [{ sourceId: 'claude-code', conversations: [
    C({ sessionId: 'later', state: 'unread' }),
    C({ sessionId: 'earlier', state: 'unread' }),
    C({ sessionId: 'noUser', state: 'working', activity: 'working', lastUserAt: undefined }),
    C({ sessionId: 'since', state: 'idle', activity: 'background' }),
    C({ sessionId: 'undated', state: 'idle' }),
    C({ sessionId: 'stopped', state: 'working', activity: 'working', running: false }),
    C({ sessionId: 'busy', state: 'working', activity: 'working', unseen: true }),
    C({ sessionId: 'plain', state: 'idle', activity: 'background' }),
  ] }] });
  const all = data.running.concat(data.stopped);
  const of = (id) => { const c = all.find((x) => x.sessionId === id); return c ? [c.activity, c.unseen, c.state] : null; };
  eq([of('later'), of('earlier')], [['waiting', true, 'needs'], ['stopped', true, 'needs']],
    'a question put after the last user message makes the conversation wait for the user; one put days before does not');
  eq(of('noUser'), ['working', false, 'needs'], 'with no lastUserAt the activity is the source\'s, question or not');
  eq([of('since'), of('undated'), of('plain')], [['waiting', false, 'needs'], ['stopped', false, 'needs'], ['background', false, 'idle']],
    'a question with no asked time is dated by its row\'s since, and one with neither is not taken to be new');
  eq(of('busy'), ['working', true, 'needs'], 'a new question waits for the turn still running to end, as the question reaches the user in its reply');
  eq(of('stopped'), ['waiting', false, 'needs'], 'a conversation no longer running still waits on a question it put after the user last wrote');
  const drop = C({ sessionId: 'x', state: 'working', activity: 'working', running: false });
  eq(conv.activityOf(drop, []), 'stopped', 'a conversation no longer running has stopped, whatever its source said it was doing');
  eq(conv.activityOf({ sessionId: 'raw', state: 'prompt', running: true }, []), 'waiting',
    'a conversation that did not come through the source reader is worked out from its state');
};
