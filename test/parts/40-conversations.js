// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations tree: every source's conversations sorted and filtered together, rows carrying their source, and
 * the logo with a state dot. Adapted from "Conversations tab with several sources" in vscode-claude-code-extras'
 * test/check.js.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const conv = require(path.join(root, 'src', 'conversations.js'));
  const src = require(path.join(root, 'src', 'sources.js'));
  const { readPlanAt } = require(path.join(root, 'src', 'workplan.js'));
  const base = tmp('assemble');
  const ws = path.join(base, 'ws'), out = path.join(base, 'out'), plans = path.join(base, 'plans');
  for (const d of [ws, out, plans]) fs.mkdirSync(d);
  const link = path.join(base, 'ws-link');
  fs.symlinkSync(ws, link);
  const write = (name, nodes, ageDays = 0) => {
    const f = path.join(plans, name + '.json');
    fs.writeFileSync(f, JSON.stringify({ nodes }));
    const t = (Date.now() - ageDays * 86400e3) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };
  const ask = [{ title: 'q', state: 'waiting', waitingOn: 'user', question: 'Which?' }];
  const files = {
    'claude-code/same': write('cc-same', [{ title: 'cc row', state: 'doing' }, { title: 'odd', state: 'snoozed' }]),
    'codex/same': write('cx-same', ask),
    'codex/old': write('cx-old', [{ title: 'o', state: 'todo' }], 9),
    'codex/stopped': write('cx-stopped', [{ title: 's', state: 'todo' }], 1),
    'codex/closed': write('cx-closed', [{ title: 's', state: 'done' }], 1),
  };
  const planOf = (sourceId, id) => {
    const file = files[sourceId + '/' + id] || '';
    return { file, plan: file ? readPlanAt(file, id) : null };
  };
  const now = Date.now();
  const C = (o) => src.conversation(Object.assign({ cwd: ws, running: true, state: 'idle', lastActiveAt: now - 1000 }, o));
  const data = conv.assemble({
    folders: [ws], planOf, now,
    lists: [
      { sourceId: 'claude-code', conversations: [C({ sessionId: 'same', title: 'Claude one', state: 'working', lastActiveAt: now - 5000 }),
        C({ sessionId: 'away', cwd: out }), C({ sessionId: 'linked', cwd: link, title: 'through a link' })] },
      { sourceId: 'codex', conversations: [C({ sessionId: 'same', title: 'Codex one', state: 'mystery' }),
        C({ sessionId: 'same', title: 'twice' }), C({ sessionId: 'old', running: false }), C({ sessionId: 'stopped', running: false }),
        C({ sessionId: 'closed', running: false }), C({ sessionId: 'noplan', state: 'unread', lastActiveAt: now - 9000 })] },
    ],
  });
  const rows = data.running.map((c) => `${c.sourceId}/${c.sessionId}:${c.state}:${c.title}`);
  eq(rows, ['codex/same:needs:Codex one', 'claude-code/same:working:Claude one', 'codex/noplan:unread:noplan', 'claude-code/linked:idle:through a link'],
    'assemble() sorts all sources together; a folder reached through a symbolic link counts as in the workspace');
  eq([data.stopped.map((c) => c.sourceId + '/' + c.sessionId), data.asks, data.running[1].doing.length, data.running[1].unknown, data.running[1].open],
    [['codex/stopped'], 1, 1, 1, 1], 'stopped ones need open rows and a recent plan; doing rows and unknown states are counted apart');

  const { vscode } = fake.create();
  const undo = fake.install(vscode);
  fake.fresh(root);
  const cv = require(path.join(root, 'src', 'conversations-view.js'));
  const decorated = JSON.parse(JSON.stringify(data));
  for (const c of decorated.running.concat(decorated.stopped)) {
    c.source = { id: c.sourceId, label: c.sourceId === 'codex' ? 'Codex' : 'Claude Code' };
    if (c.sourceId === 'codex') c.icon = { light: '/i/l.svg', dark: '/i/d.svg' };
  }
  const tree = new cv.ConversationsProvider();
  tree.set(decorated, '', 'en');
  const top = tree.getChildren().filter((e) => e.kind === 'conversation');
  const items = top.map((e) => tree.getTreeItem(e));
  const q = tree.getTreeItem(tree.getChildren(top[0])[0]);
  if (items[0].id === 'conversations/codex/same' && items[1].id === 'conversations/claude-code/same'
    && items[0].iconPath.light === '/i/l.svg' && items[1].iconPath.id === 'sync~spin'
    && items[0].tooltip.split('\n')[1] === 'Codex' && items[0].command.command === 'agentWorkPlan.openConversation'
    && items[0].command.arguments[0].sourceId === 'codex' && q.command.command === 'agentWorkPlan.answerQuestion'
    && q.command.arguments[0].sourceId === 'codex' && q.command.arguments[0].open.sourceId === 'codex' && q.id === 'conversations/codex/same/?1'
    && items[0].description.startsWith('needs you') && /1 in a state this version does not know/.test(items[1].description)) {
    ok('rows show the logo and label, carry the source id, and say how many rows are in unknown states');
  } else bad(`drawn: ${JSON.stringify(items.slice(0, 2))}`);
  undo();

  const icons = require(path.join(root, 'src', 'sourceicons.js'));
  const idir = tmp('icons');
  const codexLike = '<?xml version="1.0"?>\n<svg\n  xmlns="http://www.w3.org/2000/svg"\n  width="24"\n  height="24"\n  fill="none"\n>\n  <path d="M2 2h3" fill="#000"/>\n</svg>\n';
  const a = icons.withDot(codexLike, '#89d185');
  if (a.includes('viewBox="0 0 24 24" fill="none">') && a.includes('fill="#89d185"') && !a.includes('<?xml')
    && icons.withDot('not an svg', '#000') === '' && icons.withDot('<svg/>', '#000') === '') {
    ok('withDot() draws the state dot over an SVG logo');
  } else bad(`dotted logo: ${a.slice(0, 200)}`);
  const light = path.join(idir, 'black.svg'), dark = path.join(idir, 'white.svg');
  fs.writeFileSync(light, codexLike); fs.writeFileSync(dark, codexLike.replace('#000', '#fff'));
  const made = icons.iconsFor({ light, dark }, 'working', path.join(idir, 'out'), new Map());
  const gone = icons.iconsFor({ light: path.join(idir, 'missing.svg'), dark }, 'idle', path.join(idir, 'out'), new Map());
  eq([!!made && made.light !== made.dark && fs.readFileSync(made.light, 'utf8').includes(icons.COLORS.working.light), gone],
    [true, null], 'iconsFor() writes the dotted icons, and gives up without a logo');
};
