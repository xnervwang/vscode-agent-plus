// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What a window that stays open does over time: the plans it keeps parsed, a source that reports a change while it is
 * being listed, and a plan file caught empty while it is being written.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  const plan = require(path.join(root, 'src', 'workplan.js'));

  /* A writer that truncates and then writes leaves an empty file for a moment. Empty is not JSON, so it is a plan that
     does not parse, which the views show as the last one that did while it is that fresh, rather than as no plan. */
  {
    const dir = tmp('empty-plan');
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '');
    const p = plan.readPlanAt(file, 's');
    eq([!!p, !!(p && p.error)], [true, true], 'an empty plan file reads as one that does not parse, not as no plan');
  }

  /* Plans of conversations no longer listed are let go, rather than kept parsed for as long as the window is open. */
  {
    let built = null;
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 20, slowMs: 1e9, refreshMs: 30 },
      views: (h, o) => (built = require(path.join(root, 'src', 'views.js')).create(h, o)) });
    const ws = tmp('ws');
    b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(ws) }];
    const plans = tmp('plans');
    for (const id of ['A', 'B']) fs.writeFileSync(path.join(plans, id + '.json'), JSON.stringify({ nodes: [{ title: id, state: 'todo' }] }));
    let listed = ['A', 'B'];
    b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(plans, id + '.json'), planDir: () => plans,
      listConversations: async () => listed.map((id) => ({ sessionId: id, title: id, cwd: ws, state: 'idle', running: true })) });
    await wait(120);
    const cached = () => (built && typeof built._parts.plans === 'function' ? built._parts.plans().map((f) => path.basename(f)).sort() : null);
    const before = cached();
    listed = ['A'];
    await wait(200);
    eq([before, cached()], [['A.json', 'B.json'], ['A.json']], 'the plan of a conversation that is no longer listed is not kept parsed');
    b.close();
  }

  /* A source that reports a change while it is being listed is listed again, but not at once in a loop. */
  {
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 20, slowMs: 1e9, refreshMs: 1e9, debounceMs: 100 } });
    const changed = new fake.EventEmitter();
    let calls = 0;
    b.api.registerSource({ protocol: 1, id: 'busy', label: 'Busy', onDidChangeConversations: changed.event,
      listConversations: async () => { calls++; await new Promise((r) => setImmediate(r)); changed.fire(); return []; } });
    await wait(450);
    const n = calls;
    b.close();
    eq(n >= 2 && n <= 8, true, `a source that reports a change from inside its own list is listed again at the debounced pace (${n} lists in 450 ms)`);
  }
};
