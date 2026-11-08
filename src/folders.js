// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The two parts of src/waiting.js in vscode-claude-code-extras bb28f51 that are not about Claude Code: whether a
 * conversation's folder is in this window's workspace, and which rows of a plan wait on the user.
 */
const fs = require('fs');
const path = require('path');

/* So that /home/x and /local/home/x match when one is a symbolic link to the other. */
const realPath = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } };
const caseOf = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;

/*
 * A test for "is this directory one of `folders` or under one", comparing real paths. With a `memo`, each path is
 * resolved once: the test is asked about the folder of every conversation on every pass, and resolving one is a system
 * call per level of it. The caller owns the memo and so decides how long an answer stays good for.
 */
function folderTest(folders, memo) {
  const resolve = memo
    ? (p) => { if (!memo.has(p)) memo.set(p, caseOf(realPath(p))); return memo.get(p); }
    : (p) => caseOf(realPath(p));
  const roots = (folders || []).filter(Boolean).map(resolve);
  return (dir) => {
    if (!dir || !roots.length) return false;
    const cwd = resolve(dir);
    return roots.some((root) => {
      const rel = path.relative(root, cwd);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    });
  };
}

/** The rows of a plan that wait on the user, each with the number shown in front of it. */
function planQuestions(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.waitingOn === 'user' && (n.state === 'waiting' || n.state === 'discussing')) {
      out.push({ num, title: n.title, question: n.question || n.title, since: n.asked || n.since || 0, state: n.state,
        note: n.note || '', detail: n.detail || '' });
    }
    planQuestions(n.children, num, out);
  });
  return out;
}

module.exports = { folderTest, planQuestions };
