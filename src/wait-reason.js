// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What a waiting conversation waits for, as a source reports it with the conversation (`waitingFor`, docs/protocol.md),
 * and how that is worded in the notices, in the hover of the status bar's count, and in the list of conversations that
 * need the user.
 *
 *   permission     approval of a tool call; `tool` names the tool when the source knows it
 *   question       an answer to a question the agent asked in the conversation
 *   plan           a plan the agent made, for the user to review
 *   choice         a choice in a box the agent's interface shows, other than the above
 *   planQuestion   a question in the conversation's work plan, put after the user's last message
 *
 * Anything else reads as no reason, and the conversation is then only said to be waiting for the user.
 *
 * No editor API here: the tests load this file directly.
 */
const KINDS = ['permission', 'question', 'plan', 'choice', 'planQuestion'];
const MAX_TOOL = 80;

const clip = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL) : '');

/* `raw` as { kind } or { kind: 'permission', tool }, or null. Never throws: a source's object may. */
function reasonOf(raw) {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const kind = raw.kind;
    if (!KINDS.includes(kind)) return null;
    if (kind !== 'permission') return { kind };
    const tool = clip(raw.tool);
    return tool ? { kind, tool } : { kind };
  } catch (_) { return null; }
}

/* How much a reason says: a permission without its tool says less than any other. Two windows can report one
   conversation, and the one whose panel shows the prompt knows more than one reading a machine-wide list. */
const detail = (r) => (!r ? 0 : r.kind === 'permission' && !r.tool ? 1 : 2);
const better = (a, b) => (detail(b) > detail(a) ? b : a);

/* The rest of a sentence about a waiting conversation: `"<title>" ${predicate(reason)}.` */
function predicate(r) {
  if (!r) return 'is waiting for you';
  switch (r.kind) {
    case 'permission': return r.tool ? `is waiting for you to approve ${r.tool}` : 'is waiting for your approval';
    case 'question': return 'has a question for you';
    case 'plan': return 'has a plan for you to review';
    case 'choice': return 'is waiting for you to choose';
    case 'planQuestion': return 'has a question for you in its plan';
    default: return 'is waiting for you';
  }
}

/* The same without its leading "is", for after a conversation's name in a list: "waiting for you to approve Bash". */
const description = (r) => predicate(r).replace(/^is /, '');

/* A few words for a list that names several conversations: "approve Bash", "a question"; '' without a reason. */
function brief(r) {
  if (!r) return '';
  switch (r.kind) {
    case 'permission': return r.tool ? `approve ${r.tool}` : 'approval';
    case 'question': return 'a question';
    case 'plan': return 'a plan to review';
    case 'choice': return 'a choice';
    case 'planQuestion': return 'a question in its plan';
    default: return '';
  }
}

module.exports = { KINDS, MAX_TOOL, reasonOf, detail, better, predicate, description, brief };
