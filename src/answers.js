// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Delivery of answers typed in the Answer view. From src/answers.js of vscode-claude-code-extras bb28f51, moved to a
 * folder no editor owns and given four outcomes.
 *
 * The conversation can be open in any VS Code window on this machine, of any VS Code product, and every window runs its
 * own copy of this extension. So an answer is a file in a folder they all read, ~/.agent-work-plan/answers
 * (src/files.js sharedHome()), readable by this user alone. The window showing that conversation takes the file, has
 * the conversation's source deliver the text, and writes a result file that the window it came from reads.
 *
 * There is one record per answer, and it moves only by rename within that folder: a window takes an answer by renaming
 * <id>.json to <id>.taken, and only the first rename succeeds, so only one window delivers each answer. The sender
 * withdraws one nobody took the same way, so an answer cannot be delivered after the sender has said it was not. The id
 * goes to the source as `deliveryId`, so a source that is asked twice can tell.
 *
 * The outcome is one of four:
 *   submitted     the conversation has it as a message
 *   drafted       it is in the conversation's input box, and the reader still has to send it there
 *   notReceived   it did not get there: no window took it, or the source says it could not take it
 *   uncertain     it was handed over and no outcome came back in time, or the source cannot tell. It may still arrive,
 *                 so it is neither copied to the clipboard nor offered for sending again
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const { languageOf, textFor } = require('./conversations-text');
const { privateDir } = require('./files');

/* The answer file format. A file in a newer format is left for a newer build. */
const FORMAT = 1;
const OUTCOMES = ['submitted', 'drafted', 'notReceived', 'uncertain'];
/* How long an answer waits for a window to take it, how long a taken one waits for its source, and how long any file in
   the folder is kept. */
const TAKE_MS = 15000;
const SEND_MS = 20000;
const KEEP_MS = 3600e3;
/* Added to TAKE_MS before a receiving window calls an answer too late to deliver. The sender withdraws its own at
   TAKE_MS, so this only ever applies to one left behind by a window that closed or lost its connection, and the few
   seconds are there so a record is never thrown away over a rounding difference. */
const LATE_MS = 5000;
const NAME = /^[0-9a-z]+-[0-9a-f]{8}$/;
const MAX_REASON = 200;

const file = (dir, id, ext) => path.join(dir, id + ext);

function writeWhole(target, text) {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/** Puts an answer ({ sourceId, sessionId, row, text }) in the folder and returns its id. */
function post(dir, answer, now = Date.now()) {
  privateDir(dir);
  const id = now.toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  writeWhole(file(dir, id, '.json'), JSON.stringify(Object.assign({}, answer, { id, at: now, format: FORMAT })));
  return id;
}

const readable = (a) => Number.isInteger(a.format) && a.format >= 1 && a.format <= FORMAT;

/** The answers no window has taken yet. One that cannot be read is being written or taken, and is left for next time. */
function waiting(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !NAME.test(n.slice(0, -5))) continue;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (a && a.id === n.slice(0, -5) && sources.usableId(a.sourceId) && sources.usableId(a.sessionId) && typeof a.text === 'string'
        && readable(a)) out.push(a);
    } catch (_) { /* next time */ }
  }
  return out;
}

/** Takes answer `id` for this window. False when another window, or the sender giving up, got to it first. */
function take(dir, id) {
  try { fs.renameSync(file(dir, id, '.json'), file(dir, id, '.taken')); return true; } catch (_) { return false; }
}

/** Writes the outcome of a taken answer, for the window that sent it. */
function settle(dir, id, result) {
  try { writeWhole(file(dir, id, '.result'), JSON.stringify(Object.assign({}, result, { id }))); } catch (_) { /* the sender times out */ }
  try { fs.unlinkSync(file(dir, id, '.taken')); } catch (_) { /* already gone */ }
}

/** Reads the outcome of answer `id` and deletes its file. Null until there is one. */
function outcome(dir, id) {
  let r;
  try { r = JSON.parse(fs.readFileSync(file(dir, id, '.result'), 'utf8')); } catch (_) { return null; }
  try { fs.unlinkSync(file(dir, id, '.result')); } catch (_) { /* read once is enough */ }
  return r && typeof r === 'object' ? normalize(r) : null;
}

/** The sender gives up on an answer nobody took. False when a window took it in the meantime. */
function withdraw(dir, id) {
  try { fs.renameSync(file(dir, id, '.json'), file(dir, id, '.withdrawn')); } catch (_) { return false; }
  try { fs.unlinkSync(file(dir, id, '.withdrawn')); } catch (_) { /* removed by the sweep */ }
  return true;
}

/** Whether answer `id` has been taken and not yet settled. */
function taken(dir, id) {
  return fs.existsSync(file(dir, id, '.taken'));
}

/** Removes files older than KEEP_MS: results nobody read, answers a closed window took and never settled. */
function sweep(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  let gone = 0;
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_MS) { fs.unlinkSync(p); gone++; }
    } catch (_) { /* someone else removed it */ }
  }
  return gone;
}

/* A result as a source or a result file gives it, reduced to { outcome, reason }. Anything else is uncertain: an
   outcome nobody can name is not a failure anyone can act on. */
function normalize(r) {
  const o = sources.get(r, 'outcome');
  if (!OUTCOMES.includes(o)) return { outcome: 'uncertain', reason: '' };
  const reason = sources.get(r, 'reason');
  return { outcome: o, reason: o === 'notReceived' && typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON) : '' };
}

/**
 * What one window does with answers: it takes the ones meant for conversations it shows and has their source deliver
 * them, and it follows the answers it sent until each gets an outcome.
 *
 * `canShow(sessionId, sourceId)` says whether this window can deliver to the conversation; `hand(answer, report)` gives
 * it to the source and later calls report({ outcome, reason }), returning false when it could not even start. `finish(
 * sent, result)` hears the outcome of each answer this window sent. `claiming()` says whether this window may take
 * answers now (not in Restricted Mode).
 */
class Courier {
  constructor({ dir, canShow, hand, finish, claiming = () => true, now = Date.now, later = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { dir, canShow, hand, finish, claiming, now, later, cancel });
    this.outgoing = new Map();
    this.handing = new Map();
    this.checks = new Set();
    this.closed = false;
  }

  /** Sends `answer` and returns its id; `extra` comes back to finish() with the outcome. */
  send(answer, extra) {
    const id = post(this.dir, answer, this.now());
    this.outgoing.set(id, Object.assign({ id, at: this.now(), text: answer.text }, extra));
    /* Checked again when the time to take it is up, and when a window that took it has had time to report, even if
       no change in the folder is seen. */
    for (const ms of [TAKE_MS + 100, TAKE_MS + SEND_MS + 5100]) {
      const t = this.later(() => { this.checks.delete(t); this.pump(); }, ms);
      this.checks.add(t);
    }
    this.pump();
    return id;
  }

  /** Removes the files left behind by windows that closed: see sweep(). Called on the tick as well as at the start. */
  sweep() {
    return sweep(this.dir, this.now());
  }

  pump() {
    if (this.closed) return;
    let claim = false;
    try { claim = this.claiming() === true; } catch (_) { claim = false; }
    for (const a of claim ? waiting(this.dir) : []) {
      if (this.handing.has(a.id)) continue;
      /* The window that sent this one gave up on it long ago, or died before it could. Delivering it now would put a
         message into a conversation the reader has given up on and may have answered by hand already. The record is
         taken first, so of several windows showing that conversation exactly one disposes of it. */
      if (this.now() - Number(a.at) > TAKE_MS + LATE_MS) {
        if (take(this.dir, a.id)) settle(this.dir, a.id, { outcome: 'notReceived', reason: 'it was too late to deliver' });
        continue;
      }
      let shows = false;
      try { shows = this.canShow(a.sessionId, a.sourceId) === true; } catch (_) { shows = false; }
      if (!shows || !take(this.dir, a.id)) continue;
      this.handing.set(a.id, this.later(() => this.handed(a.id, { outcome: 'uncertain' }), SEND_MS));
      let started = false;
      try { started = this.hand(a, (r) => this.handed(a.id, r)) === true; } catch (_) { started = false; }
      if (!started) this.handed(a.id, { outcome: 'notReceived', reason: '' });
    }
    for (const [id, o] of this.outgoing) {
      const r = outcome(this.dir, id);
      const age = this.now() - o.at;
      let result = null;
      if (r) result = r;
      else if (age > TAKE_MS && !taken(this.dir, id) && withdraw(this.dir, id)) result = { outcome: 'notReceived', reason: 'nobody' };
      else if (age > TAKE_MS + SEND_MS + 5000) result = { outcome: 'uncertain', reason: '' };
      if (!result) continue;
      this.outgoing.delete(id);
      try { this.finish(o, result); } catch (_) { /* the view is gone */ }
    }
  }

  /** The source's report on answer `id`. A report after the SEND_MS timeout has nobody to hear it. */
  handed(id, result) {
    if (!this.handing.has(id)) return;
    this.cancel(this.handing.get(id));
    this.handing.delete(id);
    settle(this.dir, id, normalize(result));
    this.pump();
  }

  dispose() {
    this.closed = true;
    for (const t of this.handing.values()) this.cancel(t);
    for (const t of this.checks) this.cancel(t);
    this.handing.clear();
    this.checks.clear();
    /* A window closing takes back the answers it sent that no window has taken: nobody is left to hear the outcome, so
       one delivered after this would arrive with nothing on screen to say it had. One already taken is left alone, the
       window that took it is still working on it. */
    for (const id of [...this.outgoing.keys()]) {
      this.outgoing.delete(id);
      if (!taken(this.dir, id)) withdraw(this.dir, id);
    }
  }
}

/* canShow and hand for a Courier, through the registered sources. `find(sourceId)` gives the source or null. */
function throughSources(find) {
  return {
    canShow: (sessionId, sourceId) => {
      const s = find(sourceId);
      return !!s && typeof sources.get(s, 'deliverAnswer') === 'function' && sources.call(s, 'canDeliver', [sessionId], false) === true;
    },
    hand: (answer, report) => {
      const s = find(answer.sourceId);
      const deliver = sources.get(s, 'deliverAnswer');
      if (typeof deliver !== 'function') return false;
      Promise.resolve().then(() => deliver.call(s, answer.sessionId, answer.text, { deliveryId: answer.id }))
        .then((r) => report(normalize(r)), () => report({ outcome: 'uncertain' }));
      return true;
    },
  };
}

/** The message sent to the conversation. An agent reads it, so it uses the question's language, not the tab's. */
function message(row, question, answer) {
  const t = textFor(languageOf(question));
  return t.answerMessage(row, String(question || '').trim(), String(answer || '').trim());
}

module.exports = { FORMAT, OUTCOMES, TAKE_MS, SEND_MS, KEEP_MS, LATE_MS, post, waiting, take, settle, outcome, withdraw,
  taken, sweep, normalize, message, throughSources, Courier };
