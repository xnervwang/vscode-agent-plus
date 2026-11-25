// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The interface's planSummary() and onDidChangePlanSummary (src/plan-summary.js, src/views.js, src/host.js), for the
 * plan bar a feature extension draws above its agent's input box, and agentPlus.showWorkPlanOf and
 * agentPlus.answerQuestionOf, which run when the bar is clicked.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');

const C = 'dddddddd-0000-4000-8000-000000000004', D = 'aaaaaaaa-0000-4000-8000-000000000001', X = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const row = (title, state, more = {}) => Object.assign({ title, state }, more);

module.exports = async ({ eq, tmp, root, wait }) => {
  const { summarize, MAX_OPEN } = require(path.join(root, 'src', 'plan-summary.js'));
  const { readPlanAt } = require(path.join(root, 'src', 'workplan.js'));
  const plan = (nodes) => ({ session: 's', file: '', nodes, error: '' });
  const read = (nodes) => {
    const dir = tmp('plan'), file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({ nodes }));
    return readPlanAt(file, 's');
  };

  /* The five states a bar draws. */
  {
    const s = summarize(read([
      row('Gather the figures', 'done'),
      row('Export', 'doing', { children: [row('The exporter', 'doing', { children: [row('Write the CSV exporter and its tests', 'doing'),
        row('Its README row', 'doing')] }), row('Wire it into the CLI', 'todo')] }),
      row('Budget subcommand', 'doing', { children: [row('set, list and remove', 'doing')] }),
      row('Which month to default to', 'discussing', { waitingOn: 'user', question: 'This month or last month?' }),
      row('Refunds', 'waiting', { waitingOn: 'user', question: 'Skip negative amounts?' }),
      row('Old idea', 'dropped'),
    ]));
    eq([s.total, s.done, s.counts, s.current, s.allDone, s.questions],
      [10, 1, { discussing: 1, todo: 1, doing: 6, waiting: 1, parked: 0, done: 1 },
        { number: '2.1.1', title: 'Write the CSV exporter and its tests', state: 'doing', dim: false }, false, 2],
      'with rows doing, the current row is the deepest one, the earlier of two at the same depth; dropped rows are not counted, and both questions waiting on the user are');
  }
  {
    const s = summarize(plan([row('A', 'done'), row('B', 'todo'), row('C', 'done', { children: [row('C1', 'waiting', { waitingOn: 'build' }),
      row('C2', 'waiting', { waitingOn: 'user', question: 'Which one?' })] }), row('D', 'discussing')]));
    eq([s.current, s.questions, s.done, s.total], [null, 1, 2, 6],
      'with no row doing there is no current row, though rows wait, are discussed and are to do; a row waiting on a build asks nothing');
  }
  eq([summarize(plan([row('A', 'todo'), row('B', 'doing')])).current, summarize(plan([row('A', 'parked'), row('B', 'todo')])).current],
    [{ number: '2', title: 'B', state: 'doing', dim: false }, null],
    'a row doing is current wherever it is in the plan, and rows to do or parked make none');
  {
    const s = summarize(plan([row('A', 'done'), row('B', 'parked'), row('C', 'dropped'), row('D', 'parked')]));
    eq([s.current, s.allDone, s.total, s.done], [null, false, 3, 1], 'nor do parked rows alone');
  }
  {
    const s = summarize(plan([row('A', 'done'), row('B', 'dropped', { children: [row('B1', 'done')] }), row('C', 'done')]));
    eq([s.current, s.allDone, s.total, s.done, s.open], [null, true, 3, 3, []], 'with every counted row done there is no current row, and allDone is set');
  }
  eq([summarize(null), summarize({ error: 'Unexpected end', nodes: [] }), summarize(plan([])), summarize(plan([row('A', 'reviewing')])),
    summarize(plan([row('A', 'done'), row('B', 'reviewing')])).allDone],
  [null, null, null, null, false],
  'no plan, one that does not parse, an empty one and one whose only row is in a state this version does not know have nothing to draw; such a row is not counted, and is not done either');
  {
    const s = summarize(plan([row('A', 'dropped')]));
    eq([s.total, s.done, s.allDone, s.current], [0, 0, true, null], 'a plan whose rows were all dropped has none open: all done, with nothing counted');
  }

  /* Archived rows, read back from closed/ or left as placeholders. */
  {
    const dir = tmp('archived'), file = path.join(dir, 'long.json');
    const archived = Array.from({ length: 462 }, (_, i) => ({ title: 'Closed long ago ' + (i + 1), state: i % 10 ? 'done' : 'dropped', archived: true }));
    const open = Array.from({ length: 17 }, (_, i) => row('Open ' + (i + 1), i ? 'todo' : 'doing'));
    fs.writeFileSync(file, JSON.stringify({ nodes: archived.concat([row('Closed today', 'done')], open) }));
    fs.mkdirSync(path.join(dir, 'closed'));
    fs.writeFileSync(path.join(dir, 'closed', 'long.json'), JSON.stringify({ format: 1, nodes: [Object.assign(row('Closed long ago 1', 'dropped',
      { children: [row('Its child', 'done')] }), { row: '1' })] }));
    const s = summarize(readPlanAt(file, 'long'));
    eq([s.total, s.done, s.counts, s.current.number, s.open.length, s.allDone],
      [18, 1, { discussing: 0, todo: 16, doing: 1, waiting: 0, parked: 0, done: 1 }, '464', 17, false],
      'a plan of 462 archived rows, one closed today and 17 open counts 18 rows, one done: the archived rows, whether read back from closed/ with their children or left as placeholders, are left out, and the open rows keep their numbers');
    const all = summarize(readPlanAt(path.join(dir, 'gone.json'), 'gone') || plan(archived));
    eq([all.total, all.done, all.allDone, all.current], [0, 0, true, null], 'a plan whose every row is archived has none open: all done');
  }
  {
    const many = Array.from({ length: 40 }, (_, i) => row('Row ' + (i + 1), i % 2 ? 'todo' : 'discussing', { children: i === 0 ? [row('Under the first', 'doing')] : [] }));
    const s = summarize(plan([row('Finished', 'done')].concat(many)));
    eq([s.open.length, MAX_OPEN, s.open.slice(0, 3), s.total - s.done],
      [30, 30, [{ number: '2', title: 'Row 1', state: 'discussing', depth: 1 }, { number: '2.1', title: 'Under the first', state: 'doing', depth: 2 },
        { number: '3', title: 'Row 2', state: 'todo', depth: 1 }], 41],
      'the open rows are listed in plan order with their numbers and depths, cut to 30, while the counts cover them all');
  }

  /* Through the interface, for a Claude Code conversation and a Codex one. */
  const viewOptions = { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, debounceMs: 20, attentionMs: 1e9, attentionWarmupMs: 0, attentionBatchMs: 10 };
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await wait(20); };
  const b = boot(root, tmp, { viewOptions, config: { 'agentPlus.notifications.enabled': false } });
  const ws = tmp('ws');
  b.vscode.workspace.workspaceFolders = [{ uri: b.vscode.Uri.file(ws) }];
  const claudeDir = tmp('claude-plans'), codexDir = tmp('codex-plans');
  const write = (dir, id, body) => fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(body));
  write(claudeDir, C, { nodes: [
    { title: 'Collect the requirements', state: 'done', archived: true },
    row('Export', 'doing', { children: [row('Write the exporter', 'doing')] }),
    row('Which month', 'waiting', { waitingOn: 'user', question: 'This month or last month?' }),
  ] });
  fs.mkdirSync(path.join(claudeDir, 'closed'));
  write(path.join(claudeDir, 'closed'), C, { format: 1, nodes: [Object.assign(row('Collect the requirements', 'done',
    { children: [row('Ask the user', 'done'), row('Read the old exporter', 'done')] }), { row: '1' })] });
  write(codexDir, X, { nodes: [row('Fix the login redirect', 'done'), row('Handle refunds later', 'parked')] });
  b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', planPath: (id) => path.join(claudeDir, id + '.json'), planDir: () => claudeDir,
    listConversations: async () => [{ sessionId: C, title: 'Tidy the import script', cwd: ws, state: 'idle', running: true }] });
  b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', planPath: (id) => path.join(codexDir, id + '.json'), planDir: () => codexDir,
    listConversations: async () => [{ sessionId: X, title: 'Login redirect', cwd: '/elsewhere', state: 'idle', running: true }] });
  await wait(120);

  const cc = b.api.planSummary('claude-code', C);
  eq([cc.total, cc.done, cc.counts.done, cc.current.number, cc.questions, Object.isFrozen(cc), Object.isFrozen(cc.current)],
    [3, 0, 0, '2.1', 1, true, true],
    'a Claude Code conversation: the closed rows archived beside its plan are left out with their children, and no number moves');
  const cx = b.api.planSummary({ sourceId: 'codex', sessionId: X });
  eq([cx.total, cx.done, cx.current], [2, 1, null],
    'a Codex conversation, asked with one object argument');
  eq([b.api.planSummary('codex', D), b.api.planSummary('nobody', C), b.api.planSummary('', ''), b.api.planSummary(null)], [null, null, null, null],
    'a conversation with no plan, an agent not registered and unusable ids give null');

  const told = [];
  const sub = b.api.onDidChangePlanSummary((e) => told.push([e.sourceId, e.sessionId]));
  write(claudeDir, C, { nodes: [{ title: 'Collect the requirements', state: 'done', archived: true },
    row('Export', 'done', { children: [row('Write the exporter', 'done')] }), row('Which month', 'done')] });
  for (const w of b.control.state.watchers) w.fire('change');
  await until(() => told.length);
  await wait(60);
  const after = b.api.planSummary('claude-code', C);
  eq([told, after.allDone, after.done, after.questions], [[['claude-code', C]], true, 3, 0],
    'a change to one plan fires once, carrying the agent and the conversation, and the summary asked for then has the change');
  {
    const grown = Array.from({ length: 9 }, (_, i) => row('Row ' + (i + 1), 'todo'));
    write(claudeDir, C, { nodes: [{ title: 'Collect the requirements', state: 'done', archived: true }].concat(grown) });
    for (const w of b.control.state.watchers) w.fire('change');
    await until(() => told.length > 1);
    const nine = b.api.planSummary('claude-code', C);
    write(claudeDir, C, { nodes: [{ title: 'Collect the requirements', state: 'done', archived: true }].concat(grown,
      Array.from({ length: 111 }, (_, i) => row('Added ' + (i + 1), 'todo'))) });
    for (const w of b.control.state.watchers) w.fire('change');
    await until(() => told.length > 2);
    const more = b.api.planSummary('claude-code', C);
    eq([told.length, nine.total, more.total, more.open.length, more.counts.todo], [3, 9, 120, 30, 120],
      'rows added to a plan between two reads raise the count at once and fire the change each time');
    told.length = 1;
  }
  write(codexDir, X, { nodes: [row('Fix the login redirect', 'done'), row('Handle refunds later', 'parked'), row('Note', 'todo')] });
  write(claudeDir, D, { nodes: [row('Something else', 'todo')] });
  for (const w of b.control.state.watchers) w.fire('change');
  await until(() => told.length > 1);
  await wait(60);
  eq(told, [['claude-code', C], ['codex', X]], 'a Codex plan\'s change fires for that conversation; a plan nobody asked about fires nothing');
  sub.dispose();
  sub.dispose();
  write(codexDir, X, { nodes: [row('Fix the login redirect', 'done')] });
  for (const w of b.control.state.watchers) w.fire('change');
  await wait(150);
  eq(told.length, 2, 'once nothing listens, nothing fires');
  let threw = false;
  try { b.api.onDidChangePlanSummary(null); } catch (_) { threw = true; }
  eq(threw, true, 'a listener that is not a function is refused');

  write(claudeDir, C, { nodes: [row('Export', 'doing'), row('Which month', 'waiting', { waitingOn: 'user', question: 'This month or last month?' }),
    row('Which format', 'discussing', { waitingOn: 'user', question: 'CSV or JSON?' })] });
  write(codexDir, X, { nodes: [row('Refunds', 'waiting', { waitingOn: 'user', question: 'Skip negative amounts?' })] });
  b.control.state.commands.length = 0;
  await b.control.state.handlers['agentPlus.showWorkPlanOf']({ sourceId: 'codex', sessionId: X });
  await wait(30);
  const view = b.control.state.views['agentPlus.workPlan'];
  eq([b.control.state.commands.some((c) => c[0] === 'agentPlus.workPlan.focus'), view.description, view.provider.focus, view.provider.source],
    [true, 'Codex', X, 'codex'], 'agentPlus.showWorkPlanOf moves the work plan view to that conversation and brings the view up');
  {
    const LOOK = require(path.join(root, 'src', 'workplan-view.js')).LOOK;
    const item = view.provider.getTreeItem(view.provider.getChildren()[0]);
    eq([item.iconPath.id, item.iconPath.color.id, item.command.command, item.command.arguments[0]],
      ['question', 'charts.orange', 'agentPlus.answerQuestionOf', { sourceId: 'codex', sessionId: X, row: '1' }],
      'in the work plan view, a row waiting for the user with its question is drawn as a question, and a click opens it in the Answer view');
    write(codexDir, X, { nodes: [row('Refunds', 'waiting', { waitingOn: 'user', question: 'Skip negative amounts?' }),
      row('CI', 'waiting', { waitingOn: 'build' }), row('Later', 'waiting', { waitingOn: 'user' })] });
    view.provider.refresh();
    const drawn = view.provider.getChildren().map((e) => view.provider.getTreeItem(e));
    const kept = ['CI', 'Later'].map((t) => drawn.find((i) => i.label.endsWith('. ' + t))).map((i) => [i.iconPath.id, i.command.command]);
    eq(kept, [[LOOK.waiting.icon, 'agentPlus.showWorkPlanDetail'], [LOOK.waiting.icon, 'agentPlus.showWorkPlanDetail']],
      'a row waiting on anyone else, or on the user with no question written, keeps the clock and opens its description');
    write(codexDir, X, { nodes: [row('Refunds', 'waiting', { waitingOn: 'user', question: 'Skip negative amounts?' })] });
  }
  const answer = b.control.state.webviews['agentPlus.answer'];
  await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 'claude-code', sessionId: C });
  eq([answer.current && answer.current.row, answer.current && answer.current.question, answer.current && answer.current.running,
    b.control.state.commands.some((c) => c[0] === 'agentPlus.answer.focus')], ['2', 'This month or last month?', true, true],
  'agentPlus.answerQuestionOf shows the first question of that conversation\'s plan in the Answer view, ready to be answered');
  await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 'claude-code', sessionId: C, row: '3' });
  const third = answer.current && answer.current.question;
  await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 'claude-code', sessionId: C, row: '1' });
  eq([third, answer.current && answer.current.question], ['CSV or JSON?', 'This month or last month?'],
    'with a row it shows that row\'s question, and the first question when that row asks nothing');
  await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 'codex', sessionId: X });
  eq([answer.current && answer.current.sourceId, answer.current && answer.current.question, answer.current && answer.current.open],
    ['codex', 'Skip negative amounts?', { sourceId: 'codex', sessionId: X, cwd: '/elsewhere', title: 'Login redirect' }],
    'and for a Codex conversation outside this window\'s folders, put together from its plan, with what opens it through its own agent');
  b.control.state.handlers['agentPlus.refreshWorkPlan']();
  await wait(150);
  eq([answer.current && answer.current.gone, answer.current && answer.current.question], [false, 'Skip negative amounts?'],
    'the next pass keeps that question as one still asked, though the Conversations view does not list its conversation');
  {
    const lateDir = tmp('late-plans');
    const L = 'bbbbbbbb-0000-4000-8000-000000000002';
    let listed = [];
    write(lateDir, L, { nodes: [row('Pick a format', 'waiting', { waitingOn: 'user', question: 'CSV or JSON?' })] });
    b.api.registerSource({ protocol: 1, id: 'late', label: 'Late', planPath: (id) => path.join(lateDir, id + '.json'), planDir: () => lateDir,
      listConversations: async () => listed.map((c) => Object.assign({}, c)) });
    await wait(120);
    listed = [{ sessionId: L, title: 'Opened a moment ago', cwd: ws, state: 'idle', running: true }];
    await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 'late', sessionId: L });
    eq([answer.current && answer.current.conversation, answer.current && answer.current.running, answer.current && answer.current.question],
      ['Opened a moment ago', true, 'CSV or JSON?'],
      'a conversation its source did not list last time is asked about once more, so the question comes with its title and as running');
  }
  await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 'codex', sessionId: D });
  await b.control.state.handlers['agentPlus.answerQuestionOf']({ sourceId: 7 });
  eq(b.control.state.said.filter((m) => /no question in that conversation/.test(m.message)).length, 1,
    'a conversation with no question says so, and a target with unusable ids does nothing');
  b.close();
};
