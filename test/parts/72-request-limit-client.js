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

  /* An installation the reader's account cannot write, as an installer running as root leaves it. */
  const unwritable = async (pick, uiKind = vscode.UIKind.Desktop) => {
    const app = '/Applications/Visual Studio Code.app/Contents/Resources/app';
    const file = `${app}/${wl.SW}`;
    vscode.env.appRoot = app;
    vscode.env.uiKind = uiKind;
    control.state.said.length = 0;
    control.state.shown.length = 0;
    control.state.answers.length = 0;
    control.state.config[KEY] = 'raise';
    const c = client({ [`${app}/product.json`]: '{"commit":"root-owned"}', [file]: text(32) }, { refuse: 'EACCES' });
    control.state.documents[file] = c.files[file];
    if (pick) control.answer('could not change VS Code\'s request limit', pick);
    const h = { vscode, context: { globalState: fake.memento() }, say: () => {}, trusted: () => true };
    const l = limit.create(h, { where: () => ({ fs: c.fs, at: c.at, local: false, appRoot: app, commit: 'root-owned' }), timing: fast, delayMs: 0, home });
    await l.check();
    l.dispose();
    const warning = control.state.said.find((s) => /could not change/.test(s.message));
    return { buttons: warning && warning.buttons, onDisk: c.files[file], inEditor: control.state.documents[file],
      shown: control.state.shown.map((e) => [e.document.uri.path === file, !!(e.options && e.options.preview === false), e.revealed.length]),
      told: control.state.said.filter((s) => /Retry as/.test(s.message)).length, clipboard: control.state.clipboard };
  };
  const EDIT = 'Change It in an Editor', COPY = 'Copy the command';
  const edited = await unwritable(EDIT);
  eq([edited.buttons, edited.onDisk, edited.inEditor, edited.shown, edited.told], [[EDIT, COPY], text(32), text(1000000), [[true, true, 1]], 1],
    'a file the reader cannot write: the notice offers an editor first, which opens it with the limit changed and unsaved, says to save it '
      + 'and retry with the password, and leaves the file on disk to that save');
  const copied = await unwritable(COPY);
  eq([copied.inEditor, copied.shown.length, /^sudo sed -i '' /.test(copied.clipboard)], [text(32), 0, true],
    'Copy the command still copies the command and opens nothing');
  const web = await unwritable(undefined, vscode.UIKind.Web);
  eq(web.buttons, [COPY], 'in the browser, where VS Code has no save with a password, only the command is offered');
  vscode.env.uiKind = undefined;
  vscode.env.machineId = undefined;
  undo();
};
