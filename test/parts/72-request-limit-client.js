// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's webview request limit as seen from a remote: the client is not the machine the extension host runs on, so
 * its platform is read from where VS Code is installed, and several clients can connect to the one machine whose
 * shared folder records who has been asked.
 */
const path = require('path');
const fake = require('../fake-vscode');
const { client } = require('../limit-fs');

module.exports = async ({ eq, root, tmp }) => {
  const wl = require(path.join(root, 'src', 'webview-limit.js'));
  const KEY = 'agentPlus.webviewRequestLimit';
  const text = (n) => `a();${wl.NAME}=${n},b();`;
  const fast = { wait: async () => {} };

  /* A Linux client of a macOS or Windows remote: the installation paths are Linux ones whatever this machine is. */
  const linuxRoots = ['/usr/share/code/resources/app', '/usr/share/code-insiders/resources/app', '/opt/visual-studio-code/resources/app',
    '/snap/code/current/usr/share/code/resources/app'];
  eq(linuxRoots.map((r) => [wl.platformOf(r, 'darwin'), wl.platformOf(r, 'win32')]), linuxRoots.map(() => ['linux', 'linux']),
    'an installation under /usr, /opt or /snap is on a Linux client, whatever the extension host runs on');
  eq([wl.platformOf('/Applications/Visual Studio Code.app/Contents/Resources/app', 'linux'), wl.platformOf('/home/me/VSCode/resources/app', 'darwin')],
    ['darwin', 'darwin'], 'a macOS application is macOS, and a path of nobody\'s package goes by the extension host');
  eq(wl.byHand({ root: '/usr/share/code/resources/app' }, 'darwin').startsWith("sudo sed -i 's/"), true,
    'the command to run by hand on that Linux client is GNU sed\'s, not the macOS form');

  /* Several clients connected to one machine: the marker that one window of a client asks is in that machine's shared
     folder, and it must not stop another client, or another installation on the same client, from being asked. */
  const { vscode, control } = fake.create();
  const undo = fake.install(vscode);
  fake.fresh(root);
  const limit = require(path.join(root, 'src', 'request-limit.js'));
  vscode.workspace.fs = {};
  const home = tmp('client-home');
  const asks = async (machineId, app = '/opt/code/resources/app', memento = fake.memento()) => {
    vscode.env.machineId = machineId;
    vscode.env.appRoot = app;
    control.state.said.length = 0;
    delete control.state.config[KEY];
    const c = client({ [`${app}/product.json`]: '{"commit":"same"}', [`${app}/${wl.SW}`]: text(32) });
    const h = { vscode, context: { globalState: memento }, say: () => {}, trusted: () => true };
    const l = limit.create(h, { where: () => ({ fs: c.fs, at: c.at, local: true, appRoot: app, commit: 'same' }), timing: fast, delayMs: 0, home });
    await l.check();
    l.dispose();
    return control.state.said.filter((s) => /Raise the limit/.test(s.message)).length;
  };
  eq([await asks('client-a'), await asks('client-a'), await asks('client-b'), await asks('client-b', '/usr/share/code/resources/app')], [1, 0, 1, 1],
    'one window of each client is asked, and a second client, or a second installation of the same build, is asked too');
  const old = fake.memento();
  await old.update(limit.ASKED_KEY, 'same');
  eq(await asks('client-c', '/opt/code/resources/app', old), 0, 'a client an earlier version recorded as asked about this build is not asked again');
  vscode.env.machineId = undefined;
  undo();
};
