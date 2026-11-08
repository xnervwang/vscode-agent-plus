// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Reading a plan and drawing it: unknown states are shown by name, marked as not known here, and counted nowhere; a
 * plan in a newer format says so; a source's notice sits above its plan. Adapted from "plan rows in unknown states" in
 * vscode-claude-code-extras' test/check.js.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const plan = require(path.join(root, 'src', 'workplan.js'));
  const conv = require(path.join(root, 'src', 'conversations.js'));
  const folders = require(path.join(root, 'src', 'folders.js'));
  const dir = tmp('plans');
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'here', nodes: [
    { title: 'known', state: 'todo' },
    { title: 'newer', state: 'blocked', waitingOn: 'user', question: 'Is this asked?' },
    { title: 'no state' },
    { title: 'parent', state: 'doing', children: [{ title: 'odd child', state: 'snoozed' }] },
  ] }));
  const p = plan.readPlanAt(file, 'abc12345');
  const states = p && p.nodes.map((n) => n.state).concat(p.nodes[3].children.map((n) => n.state));
  eq([p.file, p.session, p.title, states, p.format, p.newer], [file, 'abc12345', 'here', ['todo', 'blocked', 'todo', 'doing', 'snoozed'], 1, false],
    'readPlanAt() reads the given path and keeps unknown states');
  eq([plan.readPlanAt(path.join(dir, 'missing.json'), 'abc12345'), plan.readPlanAt(file, '')], [null, null], 'no file or no session reads as no plan');
  eq(p.nodes.map((n) => n.known).concat(p.nodes[3].children.map((n) => n.known)), [true, false, true, true, false], 'each row says whether its state is known');
  const counts = plan.countOpen(p.nodes);
  if (counts.todo === 2 && counts.doing === 1 && !('blocked' in counts) && conv.openCount(p.nodes) === 3 && plan.countUnknown(p.nodes) === 2
    && !folders.planQuestions(p.nodes).length) {
    ok('rows in unknown states are counted by countUnknown() and nowhere else');
  } else bad(`counts ${JSON.stringify(counts)}`);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{"nodes": [');
  const b = plan.readPlanAt(broken, 's');
  eq([!!b.error, b.nodes.length], [true, 0], 'a file that does not parse comes back with its error');
  const newer = path.join(dir, 'newer.json');
  fs.writeFileSync(newer, JSON.stringify({ format: 3, nodes: [{ title: 'x', state: 'todo' }] }));
  const n = plan.readPlanAt(newer, 's');
  eq([n.format, n.newer, n.nodes.length], [3, true, 1], 'a plan in a newer format is read as far as this format goes, and marked');
  const big = path.join(dir, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ nodes: [{ title: 'x'.repeat(100) }] }));
  eq(plan.readPlanAt(big, 's', 50), null, 'a plan over the size limit is not read');

  const { vscode } = fake.create();
  const undo = fake.install(vscode);
  fake.fresh(root);
  const views = require(path.join(root, 'src', 'workplan-view.js'));
  const tree = new views.WorkPlanProvider({ read: (session, source) => (session === 'abc12345' && source === 'other' ? p
    : session === 'newer' ? n : null) });
  tree.setScoped(true);
  tree.setFocus('abc12345', 'other');
  tree.refresh();
  const items = tree.getChildren().map((e) => tree.getTreeItem(e));
  const odd = items.find((i) => i.label === '2. newer');
  if (odd && odd.iconPath.id === 'question' && /"blocked": this version of Agent Work Plan does not know this state/.test(odd.description)
    && /left out of every count/.test(odd.tooltip.value) && odd.command.command === 'agentWorkPlan.showWorkPlanDetail'
    && odd.command.arguments[0].unknown === true && items.find((i) => i.label === '1. known').iconPath.id === 'circle-large-outline'
    && items[0].id.startsWith('other/abc12345/')) {
    ok('a row in an unknown state says this version does not know it');
  } else bad(`unknown state row: ${JSON.stringify(odd)}`);
  tree.setFocus('newer', 'other');
  tree.refresh();
  const top = tree.getChildren().map((e) => tree.getTreeItem(e));
  eq([top[0].label, top[0].description, top[1].label], ['This plan is in a newer format', 'format 3; this version reads 1', '1. x'],
    'a plan in a newer format gets a row saying so above its rows');
  tree.setProblem({ title: 'The work plan plugin is not installed', description: 'click to install', detail: 'why', command: 'x.install', arguments: [] });
  const withNotice = tree.getChildren().map((e) => tree.getTreeItem(e));
  eq([withNotice[0].label, withNotice[0].command.command, withNotice[0].tooltip], ['The work plan plugin is not installed', 'x.install', 'why'],
    'a source\'s notice is the first row');
  eq(tree.setProblem({ title: 'The work plan plugin is not installed', description: 'click to install', detail: 'why', command: 'x.install', arguments: [] }), false,
    'the same notice again changes nothing');
  tree.setFocus('', 'other');
  tree.setProblem(null);
  tree.refresh();
  eq(tree.getChildren(), [], 'a source\'s tab with no conversation yet shows an empty view');
  undo();
};
