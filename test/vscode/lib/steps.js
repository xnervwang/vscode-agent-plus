// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of the window test run. The steps share the windows ui.js opens and run in their order in the file, and a
 * step that uses what an earlier one left says so with needs('<that step>'). A run given a regular expression of step
 * names takes the steps it matches and, in their places before them, the steps those need, followed through. With no
 * expression every step runs.
 */
const fs = require('fs');

const STEP = /^\s*await step\('((?:[^'\\]|\\.)*)', async/;
const unquote = (s) => s.replace(/\\(.)/g, '$1');

/* The names of the steps of the script at `file`, in their order: the string each `await step('…', async` line opens. */
function namesIn(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => STEP.exec(l)).filter(Boolean).map((m) => unquote(m[1]));
}

/* Each step's needs('…') calls, from its line to the next step's: { step: [steps it needs] }. */
function needsIn(file) {
  const out = {};
  let at = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = STEP.exec(line);
    if (m) { at = unquote(m[1]); continue; }
    if (!at) continue;
    for (const n of line.matchAll(/\bneeds\('((?:[^'\\]|\\.)*)'\)/g)) (out[at] = out[at] || []).push(unquote(n[1]));
  }
  return out;
}

/* The set of step names to run, or null for every step: those `only` (a RegExp, or null) matches, with what they need. */
function chosen({ names, only = null, needs = {} }) {
  if (!only) return null;
  const out = new Set();
  const add = (x) => { if (out.has(x)) return; out.add(x); for (const y of needs[x] || []) add(y); };
  for (const x of names.filter((n) => only.test(n))) add(x);
  return out;
}

/* The steps `needs` names that are not steps of `names`. */
function unknown({ names, needs = {} }) {
  const have = new Set(names);
  return [...new Set(Object.values(needs).flat())].filter((x) => !have.has(x));
}

module.exports = { namesIn, needsIn, chosen, unknown };
