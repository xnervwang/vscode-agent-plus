// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Reading a work plan: what one conversation still has to do, from a file the conversation itself maintains at the path
 * its source gives (planPath()). From src/workplan.js of vscode-claude-code-extras bb28f51, without the parts that
 * belong to Claude Code's own source (where its plans live, and deleting those of conversations that are gone).
 *
 * Nothing here writes those files, and nothing here deletes them. The shape below is the whole contract between this
 * extension and whatever writes them:
 *
 *   { "format": 1,                          optional; plan format version, see PLAN_FORMAT
 *     "title": "optional name for this conversation",
 *     "nodes": [ { "title": "...", "state": "discussing|todo|doing|waiting|parked|done|dropped",
 *                  "note": "optional, read in the dialog and the hover rather than on the row",
 *                  "detail": "optional, several lines; what the row cannot say in its width",
 *                  "opened": "optional ISO 8601; when this row was added",
 *                  "since": "optional ISO 8601; when it entered the state it is in",
 *                  "closed": "optional ISO 8601; when it reached done or dropped",
 *                  "waitingOn": "optional, on a waiting or discussing row: user|build|someone|session|other",
 *                  "question": "optional, with waitingOn user: the one question the user has to answer",
 *                  "asked": "optional ISO 8601; when that question was put",
 *                  "children": [ ... ] } ],
 *     "brief": { "summary": "optional; what the conversation is for, its stage, decisions not to forget",
 *                "summaryAt": "optional ISO 8601",
 *                "status": { "doing": "...", "progress": "...", "next": "..." },
 *                "statusAt": "optional ISO 8601" } }
 *
 * The brief is written by the agent through the plugins' plan-row.py (summary, status), within widths of 400 for the
 * summary and 80, 100 and 60 for the three parts of the status, a CJK character counting 2. Missing or malformed parts
 * are ignored.
 *
 * Closed rows a day old are moved by plan-row.py to closed/<session id>.json beside the plan, a file of the same shape
 * whose rows each carry `row`, their number in the plan. The plan keeps a placeholder in each one's place, with only a
 * short title, the state and `"archived": true`, so no number changes. The rows are read from both files and put back
 * where their placeholders are; a placeholder whose row is not in the archive is drawn as it is.
 *
 * A child is something that has to be finished before its parent can be. Nesting means exactly that and nothing else.
 *
 * Reading is forgiving about a file that is absent or half-written, since another process writes it. It is not
 * forgiving quietly: a file that exists and cannot be parsed comes back as an entry with an error on it, so the view can
 * say so. A plan that silently shows nothing is indistinguishable from no work left.
 */
const path = require('path');
const { readBounded } = require('./bounded');

/*
 * The plan format this build reads. A file without "format" is format 1. A file with a higher one comes from a writer
 * newer than this build: it is still drawn, as far as the fields known here go, with a row saying so. Fields are only
 * ever added to the format; changing what an existing field means takes a new format number.
 */
const PLAN_FORMAT = 1;
/* The same list as STATES in the plugins' plan_path.py, in the same order. */
const STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked', 'done', 'dropped'];
/* Who a held-up row waits on, as WAITING_ON in plan_path.py. A value not in it, or none, reads as '' - not known. */
const WAITING_ON = ['user', 'build', 'someone', 'session', 'other'];
const MAX_QUESTION_CHARS = 200;
const MAX_STATE_CHARS = 40;
/* MAX_NODES takes effect only after the whole file is read and parsed. Plans on the machines this was written on stay
   under a megabyte. */
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
/* Depth and count are bounded because another process writes the file: a cycle turned into JSON, or a runaway generator,
   would otherwise be rendered forever. Both are far above any plan a person reads. */
const MAX_DEPTH = 8;
const MAX_NODES = 2000;
/*
 * How much of a description this view shows, in lines as well as characters: thirty short lines are as unreadable as
 * one long paragraph. The file keeps whatever was cut.
 */
const MAX_DETAIL_LINES = 12;
const MAX_DETAIL_CHARS = 900;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* Where the limit bites it says so, and says it is the description that is at fault rather than the view. */
function detail(v) {
  const s = text(v, MAX_DETAIL_CHARS * 4);
  const lines = s.split('\n');
  let out = lines.slice(0, MAX_DETAIL_LINES).join('\n');
  let cut = lines.length > MAX_DETAIL_LINES;
  if (out.length > MAX_DETAIL_CHARS) {
    out = out.slice(0, MAX_DETAIL_CHARS);
    cut = true;
  }
  if (!cut) return out;
  return out.replace(/\s+$/, '')
    + `\n\n[too long: a description is kept to ${MAX_DETAIL_LINES} lines and ${MAX_DETAIL_CHARS} characters.`
    + ' The rest is in the file, and belongs somewhere other than a task.]';
}

/* A timestamp as milliseconds, or 0 for absent and for anything unparseable. */
function when(v) {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : 0;
}

/** One node and its children, keeping only the fields the view draws. Returns null for anything unusable. */
function node(raw, depth, budget) {
  if (!raw || typeof raw !== 'object' || budget.left <= 0) return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  budget.left--;
  /* An unknown state from a newer writer is kept so the row can show it, marked as not known here. A row with no state
     predates states: todo. */
  const named = typeof raw.state === 'string' ? raw.state.trim().slice(0, MAX_STATE_CHARS) : '';
  const state = STATES.includes(named) ? named : (named || 'todo');
  const children = [];
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const c = node(child, depth + 1, budget);
      if (c) children.push(c);
    }
  }
  const waitingOn = WAITING_ON.includes(raw.waitingOn) ? raw.waitingOn : '';
  const question = waitingOn === 'user' ? text(raw.question, MAX_QUESTION_CHARS * 2).replace(/\s+/g, ' ') : '';
  return {
    title, state, known: STATES.includes(state), note: text(raw.note, 120), detail: detail(raw.detail),
    opened: when(raw.opened), since: when(raw.since), closed: when(raw.closed), waitingOn, question,
    asked: question ? when(raw.asked) : 0, children,
  };
}

/* Upper bounds for a brief edited by hand; the plugins refuse anything this long. */
const MAX_SUMMARY_CHARS = 800;
const MAX_STATUS_CHARS = 200;
const STATUS_PARTS = ['doing', 'progress', 'next'];

/** The brief of a parsed plan, or null when it has neither a summary nor a status. */
function brief(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = text(raw.summary, MAX_SUMMARY_CHARS);
  const given = raw.status && typeof raw.status === 'object' && !Array.isArray(raw.status) ? raw.status : null;
  const parts = given ? STATUS_PARTS.map((k) => text(given[k], MAX_STATUS_CHARS).replace(/\s+/g, ' ')) : [];
  const status = parts.some(Boolean) ? { doing: parts[0], progress: parts[1], next: parts[2] } : null;
  if (!summary && !status) return null;
  return { summary, summaryAt: summary ? when(raw.summaryAt) : 0, status, statusAt: status ? when(raw.statusAt) : 0 };
}

/** Where the closed rows moved out of the plan in `file` are kept. */
const closedFileOf = (file) => path.join(path.dirname(file), 'closed', path.basename(file));

/** The rows of the archive beside the plan in `file`, by row number; empty when there is none or it does not parse. */
function archivedRows(file, max) {
  const body = readBounded(closedFileOf(file), max);
  const rows = new Map();
  if (!body) return rows;
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return rows; }
  for (const n of parsed && Array.isArray(parsed.nodes) ? parsed.nodes : []) {
    if (n && typeof n === 'object' && typeof n.row === 'string') rows.set(n.row, n);
  }
  return rows;
}

/** `nodes` with each placeholder replaced by its row from `rows`, as far down as the view draws. */
function restoreArchived(nodes, rows, prefix = '', depth = 0) {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return nodes;
  return nodes.map((raw, i) => {
    const num = prefix + (i + 1);
    let n = raw;
    if (n && typeof n === 'object' && n.archived === true && rows.has(num)) {
      n = Object.assign({}, rows.get(num));
      delete n.row;
    }
    if (n && typeof n === 'object' && Array.isArray(n.children)) n = Object.assign({}, n, { children: restoreArchived(n.children, rows, num + '.', depth + 1) });
    return n;
  });
}

/** The plan in `file` for conversation `session`, or null when there is none. */
function readPlanAt(file, session, max = MAX_PLAN_BYTES) {
  if (!file || !session) return null;
  const body = readBounded(file, max);
  /* An empty file goes on to fail the parse below: it is what a writer that truncates first leaves for a moment. */
  if (body === null) return null;
  const entry = { session, file, title: '', nodes: [], error: '', format: PLAN_FORMAT, newer: false, brief: null };
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) {
    entry.error = e.message;
    return entry;
  }
  const format = parsed && parsed.format;
  if (Number.isInteger(format) && format > 0) entry.format = format;
  entry.newer = entry.format > PLAN_FORMAT;
  entry.title = text(parsed && parsed.title, 120);
  entry.brief = brief(parsed && parsed.brief);
  const budget = { left: MAX_NODES };
  if (parsed && Array.isArray(parsed.nodes)) {
    const archived = parsed.nodes.some(function has(n) {
      return n && typeof n === 'object' && (n.archived === true || (Array.isArray(n.children) && n.children.some(has)));
    });
    const rows = archived ? archivedRows(file, max) : new Map();
    for (const raw of rows.size ? restoreArchived(parsed.nodes, rows) : parsed.nodes) {
      const n = node(raw, 0, budget);
      if (n) entry.nodes.push(n);
    }
  }
  return entry;
}

/** The states that mean a row still needs something done to it. */
const OPEN_STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked'];

/*
 * The same rows with the unfinished ones first, newest first within each group. Rows are only ever appended, so the
 * end of the file is the part of the work that is current. Drawing only: the file is untouched.
 */
function openFirst(items, stateOf = (n) => n && n.state) {
  const rows = items || [];
  const isOpen = (n) => OPEN_STATES.includes(stateOf(n));
  const newest = rows.slice().reverse();
  const open = newest.filter(isOpen);
  if (!open.length) return newest;
  return open.concat(newest.filter((n) => !isOpen(n)));
}

/** Counts per known state. Rows in a state this build does not know are counted by countUnknown() instead. */
function countOpen(nodes, acc = { discussing: 0, todo: 0, doing: 0, waiting: 0, parked: 0, done: 0, dropped: 0 }) {
  for (const n of nodes || []) {
    if (STATES.includes(n.state)) acc[n.state] = (acc[n.state] || 0) + 1;
    countOpen(n.children, acc);
  }
  return acc;
}

/** How many rows are in a state this build does not know. They may be open or closed; nobody here can tell. */
function countUnknown(nodes) {
  return (nodes || []).reduce((n, x) => n + (STATES.includes(x.state) ? 0 : 1) + countUnknown(x.children), 0);
}

module.exports = {
  readPlanAt, closedFileOf, countOpen, countUnknown, openFirst, brief, OPEN_STATES, PLAN_FORMAT, STATUS_PARTS,
  STATES, MAX_DEPTH, MAX_NODES, MAX_DETAIL_LINES, MAX_DETAIL_CHARS, WAITING_ON, MAX_QUESTION_CHARS, MAX_PLAN_BYTES,
};
