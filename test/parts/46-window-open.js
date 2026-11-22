// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Opening a conversation from a window that does not show it (src/window-open.js): this window first, then the window
 * that shows it takes the request, brings it to the front and itself; a request nobody takes is withdrawn.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root }) => {
  const wo = require(path.join(root, 'src', 'window-open.js'));
  const dir = path.join(tmp('shared'), 'open');
  const make = (name, shows) => {
    const w = { revealed: [], fronted: 0 };
    w.o = wo.createWindowOpen({ dir, windowId: `${name}-00000000`, waitMs: 400, every: 20,
      here: (s, id) => shows.includes(id),
      reveal: async (s, id) => { if (!shows.includes(id)) return false; w.revealed.push(id); return true; },
      front: () => { w.fronted++; } });
    return w;
  };
  const a = make('a', ['mine']), b = make('b', ['theirs']);

  eq([await a.o.open({ sourceId: 'codex', sessionId: 'mine' }), a.revealed], ['here', ['mine']], 'a conversation this window shows opens here');

  const asking = a.o.open({ sourceId: 'codex', sessionId: 'theirs', title: 'T' });
  await new Promise((r) => setTimeout(r, 60));
  eq(await b.o.take(), 1, 'the window that shows it takes the request');
  eq([await asking, b.revealed, b.fronted], ['there', ['theirs'], 1], 'brings the conversation to the front, and itself');

  eq(await a.o.open({ sourceId: 'codex', sessionId: 'nobody' }), 'nowhere', 'one no window shows is nowhere');
  eq([await b.o.take(), fs.readdirSync(dir).filter((n) => n.endsWith('.json'))], [0, []],
    'and its request is withdrawn, so no window takes it afterwards');

  /* Where VS Code keeps its command line beside appRoot in each kind of install, as the desktop builds of 1.147 and the
     remote server lay them out. */
  const cp = require('child_process');
  const name = process.platform === 'win32' ? 'code.cmd' : 'code';
  const layout = (label, appRoot, cli) => {
    const base = tmp(label);
    fs.mkdirSync(path.join(base, appRoot), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(base, cli)), { recursive: true });
    fs.writeFileSync(path.join(base, cli), '');
    return { appRoot: path.join(base, appRoot), cli: path.join(base, cli) };
  };
  const runs = [];
  const real = cp.execFile;
  cp.execFile = (file, argv) => { runs.push([file, argv]); return { on() {} }; };
  try {
    for (const [label, appRoot, cli] of [['linux-or-windows', 'resources/app', `bin/${name}`],
      ['macos', 'Visual Studio Code.app/Contents/Resources/app', `Visual Studio Code.app/Contents/Resources/app/bin/${name}`],
      ['remote', 'server', `server/bin/remote-cli/${name}`]]) {
      const at = layout(label, appRoot, cli);
      runs.length = 0;
      const said = [];
      const folder = { uri: { scheme: 'file', fsPath: path.join(at.appRoot, 'ws') } };
      const shown = wo.bringToFront({ env: { appRoot: at.appRoot }, workspace: { workspaceFolders: [folder] } }, (m) => said.push(m));
      eq([shown, runs.map((r) => [r[0], r[1]])], [true, [[at.cli, [folder.uri.fsPath]]]],
        `a window of the ${label} layout is brought to the front through the command line beside its install`);
    }
  } finally { cp.execFile = real; }
};
