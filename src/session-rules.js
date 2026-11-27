// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's rules, as functions over plain values (docs/protocol.md, Session list): how a row is drawn, which
 * section it goes in, what each filter keeps, and what may be archived or deleted. src/session-list.js gathers the
 * values; the page draws the result.
 *
 * A row here is { key, sourceId, sessionId, title, branch, lastActiveAt, lastReplyAt, viewedAt, activity, waitingFor,
 * asks, kind, agentUnseen, here, elsewhere, pinned, archived, archivedAt, group, seenAt, unreadMark, closedAt }: what
 * the source listed, what this window and the other windows show, and what the store keeps for it. `asks` is true when
 * the conversation's plan has a question newer than the user's last message. `sortAt`, when given, is the time the row
 * sorts by in place of `lastActiveAt` (src/session-list.js sets it for a row that runs).
 */

const DAY_MS = 24 * 3600 * 1000;
const DOTS = ['blue', 'red', 'redRing', 'green', 'greenRing', ''];
const FILTERS = ['all', 'open', 'running', 'needs'];

/* A dialog waiting for the user takes precedence over a question in the plan, and both over a turn or background work
   running. A question while a turn or background work runs is drawn as a ring, since the agent is not yet waiting on
   it. */
function dotOf(row) {
  const a = row && row.activity;
  const kind = row && row.waitingFor && row.waitingFor.kind;
  if (a === 'waiting' && kind !== 'planQuestion') return 'blue';
  const busy = a === 'working' || a === 'background';
  if (row && (row.asks || (a === 'waiting' && kind === 'planQuestion'))) return busy ? 'redRing' : 'red';
  if (a === 'working') return 'green';
  if (a === 'background') return 'greenRing';
  return '';
}

const needsYou = (row) => ['blue', 'red', 'redRing'].includes(dotOf(row));
const runs = (row) => !!row && (row.activity === 'working' || row.activity === 'background');
const busy = (row) => !!row && (runs(row) || row.activity === 'waiting');

function stripeOf(row) {
  if (!row) return '';
  if (row.here) return 'here';
  if (row.elsewhere && row.elsewhere.length) return 'elsewhere';
  if (row.closedAt > 0) return 'closed';
  return '';
}

/* Unread: marked unread by the user, or a reply newer than both the last one seen here and the agent's own record of
   showing it. Seeing a conversation, or marking it read, clears the mark. */
function unread(row) {
  if (!row) return false;
  if (row.unreadMark || row.agentUnseen) return true;
  const seen = Math.max(+row.seenAt || 0, +row.viewedAt || 0);
  return +row.lastReplyAt > 0 && +row.lastReplyAt > seen;
}

const sortTime = (r) => +(r.sortAt !== undefined ? r.sortAt : r.lastActiveAt) || 0;

/*
 * The order in a group or Ungrouped, in three tiers: pinned rows, newest pinned first; running rows, the latest to
 * start running first; the rest, by their last activity. None of these times changes while a row stays in its tier, so
 * a row moves only when it starts or stops running, is pinned or unpinned, appears, or is archived or brought back.
 */
const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || '')) || String(a.key).localeCompare(String(b.key));
function compare(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const t = a.pinned ? (+b.pinnedAt || 0) - (+a.pinnedAt || 0)
    : runs(a) !== runs(b) ? (runs(a) ? -1 : 1) : sortTime(b) - sortTime(a);
  return t || byTitle(a, b);
}
const byArchive = (a, b) => (+b.archivedAt || 0) - (+a.archivedAt || 0) || byTitle(a, b);

/*
 * The sections: Recently closed, then each group in `groups` order, Ungrouped, Archived. A conversation is in its
 * group, Ungrouped or Archived once; one closed in this window lately is in Recently closed as well, newest closed
 * first, at most `recent` of them. A group shows when it holds a row or was made in this window (`made`), which keeps
 * an empty group the user just made. `groups` is [{ id, name, made }] in the order the user put them.
 */
function sections(rows, { groups = [], recent = 10 } = {}) {
  const known = new Set(groups.map((g) => g.id));
  const live = rows.filter((r) => !r.archived);
  const out = [];
  const closed = rows.filter((r) => r.closedAt > 0 && !r.here).sort((a, b) => b.closedAt - a.closedAt).slice(0, Math.max(0, recent));
  out.push({ key: 'closed', label: 'Recently closed', rows: closed });
  for (const g of groups) {
    const inside = live.filter((r) => r.group === g.id).sort(compare);
    if (inside.length || g.made) out.push({ key: `group:${g.id}`, groupId: g.id, label: g.name, rows: inside, made: !!g.made });
  }
  out.push({ key: 'ungrouped', label: 'Ungrouped', rows: live.filter((r) => !r.group || !known.has(r.group)).sort(compare) });
  out.push({ key: 'archived', label: 'Archived', rows: rows.filter((r) => r.archived).sort(byArchive) });
  return out;
}

function passes(row, filter) {
  if (filter === 'open') return !!row.here;
  if (filter === 'running') return runs(row);
  if (filter === 'needs') return needsYou(row);
  return true;
}

/* How many rows each filter keeps, counting each conversation once. */
function counts(rows) {
  const out = {};
  for (const f of FILTERS) out[f] = rows.filter((r) => passes(r, f)).length;
  return out;
}

/*
 * Whether the list archives this conversation on its own: inactive for `days` days, and not open anywhere, running or
 * waiting, asking a question, unread, in a group or pinned.
 */
function archiveDue(row, { days, now = Date.now(), groups = null } = {}) {
  if (!(days > 0) || !row || row.archived || row.pinned) return false;
  if (row.group && (!groups || groups.has(row.group))) return false;
  if (row.here || (row.elsewhere && row.elsewhere.length) || busy(row) || dotOf(row) || unread(row)) return false;
  const last = +row.lastActiveAt || 0;
  return last > 0 && now - last >= days * DAY_MS;
}

/* Why a conversation cannot be deleted now, or '' when it can. */
function deleteBlocker(row) {
  if (!row) return 'it is not in the list';
  if (!row.archived) return 'only an archived conversation can be deleted';
  if (row.pinned) return 'it is pinned';
  if (row.here) return 'it is open in this window';
  if (row.elsewhere && row.elsewhere.length) return `it is open in ${row.elsewhere[0].label || 'another place'}`;
  if (busy(row)) return 'it is running';
  return '';
}

/* When an archived conversation is due for deletion, counting from the later of when it was first seen archived and
   its last activity, or null for one that will not be deleted. */
function deleteDueAt(row, { days, on = true } = {}) {
  if (!on || !(days > 0) || !row || !row.archived || row.pinned) return null;
  const from = Math.max(+row.archivedAt || 0, +row.lastActiveAt || 0);
  return from > 0 ? from + days * DAY_MS : null;
}

function deleteDue(row, { days, on = true, now = Date.now() } = {}) {
  const at = deleteDueAt(row, { days, on });
  return at !== null && now >= at && !deleteBlocker(row);
}

/* Search: the title or branch holds the text, ignoring case; a query of four or more characters with no space also
   matches part of the id, which is how ids of every agent are searched (hex and hyphens, or OpenCode's ses_ ids). */
function matches(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  if (String(row.title || '').toLowerCase().includes(q) || String(row.branch || '').toLowerCase().includes(q)) return true;
  return q.length >= 4 && !/\s/.test(q) && String(row.sessionId || '').toLowerCase().includes(q);
}

module.exports = { dotOf, needsYou, runs, busy, stripeOf, unread, compare, sections, passes, counts, archiveDue, deleteBlocker,
  deleteDueAt, deleteDue, matches, DAY_MS, DOTS, FILTERS };
