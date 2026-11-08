// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Builds the list for the Conversations view (src/conversations-view.js) from every registered source. From
 * src/conversations.js of vscode-claude-code-extras bb28f51: assemble() and what it needs, without Claude Code's own
 * listing, which stays in that extension's source.
 *
 * A conversation's state (turn running, permission prompt, unread reply, idle) is its source's. Its plan adds the
 * `doing` rows and the questions on rows waiting on the user; any question marks the conversation as needing the user.
 */
const fs = require('fs');
const { OPEN_STATES, countUnknown } = require('./workplan');
const { folderTest, planQuestions } = require('./folders');

/* Stopped conversations are listed only while their plan was written within this many days. */
const CLOSED_DAYS = 7;

/* Sort order: what most needs the user comes first. */
const RANK = { prompt: 0, needs: 1, working: 2, unread: 3, idle: 4 };

function doingRows(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.state === 'doing') out.push({ row: num, title: n.title, since: n.since || 0 });
    doingRows(n.children, num, out);
  });
  return out;
}

function openCount(nodes) {
  return (nodes || []).reduce((n, x) => n + (OPEN_STATES.includes(x.state) ? 1 : 0) + openCount(x.children), 0);
}

/* A source that gives no plan path is believed about hasPlan. */
function entry(c, plan, located) {
  const nodes = plan && plan.nodes;
  const questions = planQuestions(nodes).map((q) => ({
    row: q.num, title: q.title, question: q.question, since: q.since, state: q.state, note: q.note, detail: q.detail }));
  let state = c.running ? c.state : 'idle';
  if (questions.length && state !== 'prompt') state = 'needs';
  const top = nodes && nodes.find((n) => OPEN_STATES.includes(n.state));
  return {
    sessionId: c.sessionId, cwd: c.cwd, running: c.running, state, questions,
    doing: doingRows(nodes), open: openCount(nodes), unknown: countUnknown(nodes),
    hasPlan: located || plan ? !!(plan && !plan.error) : c.hasPlan === true,
    title: c.title || (plan && plan.title) || (top && top.title) || c.sessionId,
    since: c.lastActiveAt || 0,
  };
}

const order = (a, b) => (RANK[a.state] - RANK[b.state]) || (b.since - a.since);

const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; } };

/*
 * { running: [...], stopped: [...], asks } from every source's list, where asks counts the questions of the running
 * conversations. A conversation outside the window's workspace folders is left out; a stopped one is kept only while
 * its plan has open rows and was written in the last CLOSED_DAYS. Rows are keyed by (sourceId, sessionId), since two
 * sources can use the same session id.
 */
function assemble({ lists, folders, planOf, now = Date.now(), modified = mtimeOf, inFolder = folderTest(folders) }) {
  const running = [], stopped = [], seen = new Set();
  for (const { sourceId, conversations } of lists || []) {
    for (const c of conversations || []) {
      const key = JSON.stringify([sourceId, c.sessionId]);
      if (seen.has(key) || !c.cwd || !inFolder(c.cwd)) continue;
      const { plan, file } = planOf(sourceId, c.sessionId);
      if (!c.running) {
        if (!plan || !openCount(plan.nodes)) continue;
        const at = file ? modified(file) : 0;
        if (!at || now - at > CLOSED_DAYS * 86400e3) continue;
      }
      seen.add(key);
      (c.running ? running : stopped).push(Object.assign(entry(c, plan, !!file), { sourceId }));
    }
  }
  running.sort(order);
  stopped.sort(order);
  return { running, stopped, asks: running.reduce((n, c) => n + c.questions.length, 0), at: now };
}

module.exports = { assemble, entry, doingRows, openCount, RANK, CLOSED_DAYS };
