// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Uninstalling does not put VS Code's request limit back: the uninstall hook runs where this extension is installed,
 * which in a remote window is not the client, and deactivate runs after the extension host has dropped its connection
 * to the client. So the command that puts it back stays in reach once nothing uses this extension, and the notice that
 * says it can be uninstalled says to put the limit back first when it is still raised.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');
const { client } = require('../limit-fs');

module.exports = async ({ eq, root, tmp, wait }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = (pkg.contributes.menus.commandPalette || []).find((m) => m.command === 'agentPlus.restoreWebviewRequestLimit');
  eq(!entry || !/agentPlus\.alone/.test(entry.when || ''), true, 'the put-back command is in the command palette when nothing uses this extension');

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  eq(readme.split('\n').some((l) => /uninstall/i.test(l) && l.includes("Agent Plus: Put Back VS Code's Request Limit")), true,
    'README says to put the limit back before uninstalling');

  const wl = require(path.join(root, 'src', 'webview-limit.js'));
  const APP = '/opt/code/resources/app';
  const SW = `${APP}/${wl.SW}`;
  const text = (n) => `a();${wl.NAME}=${n},b();`;
  const fast = { wait: async () => {} };
  const orphaned = async (limitNow) => {
    const fake = require('../fake-vscode');
    const memento = fake.memento();
    await memento.update('agentPlus.hadDependents', true);
    const c = client({ [`${APP}/product.json`]: '{"commit":"abc"}', [SW]: text(limitNow) });
    const b = boot(root, tmp, { extensions: [], views: false, memento,
      limit: (h, o) => require(path.join(root, 'src', 'request-limit.js')).create(h, Object.assign({}, o,
        { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: APP, commit: 'abc' }), timing: fast, delayMs: 3600e3 })) });
    b.vscode.env.appRoot = APP;
    b.vscode.workspace.fs = {};
    b.control.answer('does not put it back', 'Put Back the Request Limit');
    await wait(60);
    const said = b.control.state.said.filter((s) => /uninstall it in the Extensions view/.test(s.message)).map((s) => s.buttons);
    b.close();
    return [said, c.files[SW]];
  };
  eq(await orphaned(wl.NEW), [[['Put Back the Request Limit']], text(32)],
    'left alone with the limit still raised, the notice says to put it back first, and its button does');
  eq(await orphaned(32), [[[]], text(32)], 'left alone with the limit never raised, the notice is as before');
};
