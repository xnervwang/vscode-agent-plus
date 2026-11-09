// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Starting up: activate() returns the interface at once and never throws; whether anything uses this extension is read
 * from the installed manifests before any source registers; registration results say what happened; installed alone it
 * shows nothing, writes nothing and says so once.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { boot, CODEX, CLAUDE } = require('../boot');

const source = (over = {}) => Object.assign({ protocol: 1, id: 'codex', label: 'Codex', extensionId: 'xnervwang.codex-plus' }, over);

module.exports = async ({ ok, bad, eq, tmp, root, wait }) => {
  /* extension.js itself, with a host that throws. */
  {
    const { vscode } = fake.create();
    const undo = fake.install(vscode);
    fake.fresh(root);
    const hostPath = require.resolve(path.join(root, 'src', 'host.js'));
    const real = require(hostPath);
    require.cache[hostPath].exports = Object.assign({}, real, { start: () => { throw new Error('boom'); } });
    const ext = require(path.join(root, 'extension.js'));
    let r, threw = '';
    try { r = ext.activate({ subscriptions: [], globalState: fake.memento() }); } catch (e) { threw = e.message; }
    const refused = r && r.agentPlus && r.agentPlus.registerSource(source());
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    eq([threw, typeof (r && r.then), refused && refused.accepted, refused && refused.code, /boom/.test(refused && refused.reason)],
      ['', 'undefined', false, 'failed', true], 'activate() returns synchronously and, when start() throws, an interface that refuses with the reason');
    /* A dependent reads these to work out what to tell the reader, so the refusing interface carries all of them. */
    const started = require(path.join(root, 'src', 'host.js'));
    eq(Object.keys(ext.refusing(new Error('x'))).sort(), Object.keys(started.unavailable(new Error('x'))).sort(),
      'the interface returned when nothing could start has the same members as the one the host returns');
    eq(ext.refusing(new Error('x')).version, pkg.version, 'including the version');
    delete require.cache[hostPath];
    undo();
  }

  /* With Codex Plus installed. */
  {
    const b = boot(root, tmp, { views: false });
    const api = b.api;
    eq([api.family, api.protocol, api.accepts, api.features, api.version, Object.isFrozen(api)],
      ['agent-plus', 1, [1], [], require(path.join(root, 'package.json')).version, true], 'the interface: family, protocol 1, accepted majors, features, version');
    eq(b.control.state.context['agentPlus.alone'], false, 'a dependent in the installed manifests leaves the views showing');
    const r = api.registerSource(source());
    eq([r.accepted, r.code, r.reason, typeof (r.registration && r.registration.dispose), Object.isFrozen(r)], [true, '', '', 'function', true],
      'an accepted registration says so and carries a Disposable');
    const dup = api.registerSource(source());
    eq([dup.accepted, dup.code, dup.registration], [false, 'duplicate', null], 'a second source with the same id is refused, with no Disposable');
    const bad1 = api.registerSource(source({ id: 'x', protocol: 'one' }));
    const bad2 = api.registerSource(null);
    const bad3 = api.registerSource({ protocol: 1, get id() { throw new Error('getter'); } });
    eq([bad1.code, bad2.code, bad3.code], ['shape', 'shape', 'id'], 'malformed sources are refused with a code, never thrown at');
    r.registration.dispose(); r.registration.dispose();
    const again = api.registerSource(source());
    eq(again.accepted, true, 'after disposing, the same id can register again');
    eq(b.control.state.said.length, 0, 'nothing is said when everything fits');
    b.close();
    const late = api.registerSource(source({ id: 'late' }));
    eq([late.accepted, late.code], [false, 'closing'], 'after the window closes, registrations are refused');
  }

  /* Installed alone, never used. */
  {
    const memento = fake.memento();
    const b = boot(root, tmp, { extensions: [], views: false, memento });
    eq(b.control.state.context['agentPlus.alone'], true, 'alone, the one key the views are hidden by is set');
    await wait(20);
    const said = b.control.state.said.map((s) => [s.message.slice(0, 40), s.buttons]);
    /* Each extension is called what it is called in the Extensions view: a reader told to look for something else
       finds nothing. */
    const names = require(path.join(root, 'src', 'dependents.js')).KNOWN.map((k) => k.name);
    eq(said, [[`Agent Plus is used by ${names.join(' and ')}`.slice(0, 40), names.map((n) => 'Install ' + n)]],
      'alone, it says once what it is for, with a button naming each extension as the Extensions view does');
    eq(names, ['Claude Code Plus', 'Codex Plus'], 'and those are the marketplace names');
    eq(fs.readdirSync(b.storage).concat(fs.existsSync(b.home) ? fs.readdirSync(b.home) : []), [], 'and writes nothing');
    b.close();
    const again = boot(root, tmp, { extensions: [], views: false, memento });
    await wait(20);
    eq(again.control.state.said.length, 0, 'the next window does not say it again');
    /* Codex Plus is installed while the window is open. */
    again.control.state.extensions.push(CODEX());
    again.control.fireExtensions();
    eq(again.control.state.context['agentPlus.alone'], false, 'installing an extension that uses it brings the views back');
    again.close();
    /* Then it is gone again. */
    const left = boot(root, tmp, { extensions: [], views: false, memento });
    await wait(20);
    const told = left.control.state.said.map((s) => [/uninstall it in the Extensions view/.test(s.message), s.buttons]);
    eq(told, [[true, []]], 'left alone by the extensions that used it, it says it can be uninstalled, with no uninstall button');
    left.close();
  }

  /* A remote installs extensions one at a time, and this one can arrive seconds before whatever pulled it in. */
  {
    const memento = fake.memento();
    const b = boot(root, tmp, { extensions: [], views: false, memento, noticeDelayMs: 60 });
    await wait(20);
    b.control.state.extensions.push(CODEX());
    b.control.fireExtensions();
    await wait(120);
    const said = b.control.state.said.map((s) => s.message);
    eq([said, b.control.state.context['agentPlus.alone']], [[], false],
      'the extension that uses it arriving before the notice is due keeps the notice from being said at all');
    b.close();
    /* And a notice said too early is taken back, so the next window that really is alone still says it. */
    const early = fake.memento();
    await early.update('agentPlus.toldAlone', { alone: true });
    const c = boot(root, tmp, { extensions: [CODEX()], views: false, memento: early, noticeDelayMs: 0 });
    await wait(20);
    c.close();
    const d = boot(root, tmp, { extensions: [], views: false, memento: early, noticeDelayMs: 0 });
    await wait(20);
    eq(d.control.state.said.filter((s) => /does nothing on its own|is used by Claude Code Plus/.test(s.message)).length, 1,
      'a window with a dependent clears a notice that was said too early');
    d.close();
  }

  /*
   * Restricted Mode: VS Code disables an extension whose own dependency is disabled, so an untrusted window cannot see
   * the extension that uses this one even when it is installed. The views are hidden all the same, since they would be
   * empty either way, but nothing is said and nothing is written down: a notice is said once for good, and a dependent
   * that is only disabled would make it wrong.
   */
  {
    const memento = fake.memento();
    const b = boot(root, tmp, { extensions: [], trusted: false, views: false, memento, noticeDelayMs: 0 });
    await wait(20);
    const untrusted = [b.control.state.context['agentPlus.alone'], b.control.state.said.length,
      memento.get('agentPlus.toldAlone', null)];
    b.control.grantTrust();
    await wait(20);
    eq([untrusted, b.control.state.said.some((s) => /is used by/.test(s.message))],
      [[true, 0, null], true],
      'in Restricted Mode the views are hidden but nothing is said or written down, and trusting the workspace says it');
    b.close();
    /* A dependent an untrusted window can see is a dependent: the views show. */
    const c = boot(root, tmp, { extensions: [CODEX()], trusted: false, views: false, noticeDelayMs: 0 });
    await wait(20);
    eq([c.control.state.context['agentPlus.alone'], c.control.state.said.length], [false, 0],
      'an untrusted window that can see a dependent shows the views, and still says nothing');
    c.close();
  }

  /* The install buttons. */
  {
    const b = boot(root, tmp, { extensions: [], views: false });
    b.control.answer('Agent Plus is used by', 'Install Codex Plus');
    await wait(20);
    const asked = b.control.state.commands.filter((c) => c[0] === 'workbench.extensions.installExtension');
    eq(asked, [['workbench.extensions.installExtension', 'xnervwang.codex-plus']], 'the button installs that extension');
    b.close();
  }

  /* A dependent speaking a newer protocol than this build. */
  {
    const fetched = [];
    const gallery = { version: '2.0.0', protocol: 2, accepts: [2, 1] };
    const fetchFn = async (url, init) => {
      fetched.push(url);
      if (/extensionquery/.test(url)) {
        return { ok: true, json: async () => ({ results: [{ extensions: [{ versions: [{ version: gallery.version,
          properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.96.0' }],
          files: [{ assetType: 'Microsoft.VisualStudio.Code.Manifest', source: 'https://gallery/manifest' }] }] }] }] }) };
      }
      return { ok: true, json: async () => ({ agentPlus: { protocol: gallery.protocol, accepts: gallery.accepts } }) };
    };
    const memento = fake.memento();
    const b = boot(root, tmp, { extensions: [CODEX({ version: '0.2.0', agentPlus: { protocol: 2 } })], views: false, fetch: fetchFn, memento });
    b.control.answer('needs a newer Agent Plus', 'Update Agent Plus');
    await wait(30);
    const said = b.control.state.said.map((s) => s.message);
    const r = b.api.registerSource(source({ protocol: 2 }));
    await wait(30);
    const installs = b.control.state.commands.filter((c) => c[0] === 'workbench.extensions.installExtension');
    if (said.length >= 1 && /Codex Plus needs a newer Agent Plus: it uses protocol 2/.test(said[0])
      && r.code === 'core-too-old' && JSON.stringify(installs) === JSON.stringify([['workbench.extensions.installExtension', 'xnervwang.agent-plus', { enable: true }]])
      && b.control.state.said.filter((s) => /needs a newer/.test(s.message)).length === 1 && fetched.length === 2) {
      ok('a newer dependent is told about once, and the button installs the gallery\'s Agent Plus when that accepts it');
    } else bad(`core too old: ${JSON.stringify([said, r, installs, fetched])}`);
    b.close();
    /* The gallery has nothing newer. */
    const installed = require(path.join(root, 'package.json')).version;
    gallery.version = installed; gallery.protocol = 1; gallery.accepts = [1];
    const c = boot(root, tmp, { extensions: [CODEX({ version: '0.3.0', agentPlus: { protocol: 2 } })], views: false, fetch: fetchFn, memento });
    c.control.answer('needs a newer Agent Plus', 'Update Agent Plus');
    await wait(30);
    const opened = c.control.state.commands.filter((x) => x[0] === 'extension.open' || x[0] === 'workbench.extensions.installExtension');
    const why = c.control.state.said.map((s) => s.message).find((m) => /cannot be updated from here/.test(m)) || '';
    eq([opened, why.includes(`the newest release, ${installed}, is the one installed`)], [[['extension.open', 'xnervwang.agent-plus']], true],
      'when the gallery has no fix, the button opens the extension\'s page and says why');
    c.close();
  }

  /* A dependent this build has left behind, and the gallery is unreachable. */
  {
    const b = boot(root, tmp, { extensions: [CLAUDE({ version: '1.0.30', agentPlus: { protocol: 0 } })], views: false,
      fetch: async () => { throw new Error('offline'); } });
    b.control.answer('is too old for Agent Plus', (m, buttons) => buttons[0]);
    const r = b.api.registerSource(source({ id: 'claude-code', protocol: 0, extensionId: 'xnervwang.claude-code-plus' }));
    eq(r.code, 'shape', 'protocol 0 is not a protocol');
    b.close();
    const accepts = require(path.join(root, 'src', 'sources.js')).ACCEPTS;
    const compat = require(path.join(root, 'src', 'compat.js'));
    eq([compat.behind(1, accepts), compat.behind(2, [2]), compat.behind(1, [3, 2]), compat.behind(0, [1])], ['', '', 'source', ''],
      'behind() names the side to update');
    const { vscode, control } = fake.create();
    control.answer('is too old for Agent Plus', (m, buttons) => buttons[0]);
    const out = await compat.offer({ vscode, memento: fake.memento(), who: 'source',
      ext: { id: 'xnervwang.claude-code-plus', name: 'Claude Code Plus', version: '1.0.30', protocol: 1 },
      core: { version: '2.0.0', accepts: [2] }, fetch: async () => { throw new Error('offline'); } });
    const msgs = control.state.said.map((s) => s.message);
    if (out === 'page' && /Claude Code Plus 1\.0\.30 is too old for Agent Plus 2\.0\.0/.test(msgs[0]) && /Update Claude Code Plus/.test(JSON.stringify(control.state.said[0].buttons))
      && /could not be reached \(offline\)/.test(msgs[1])
      && JSON.stringify(control.state.commands) === JSON.stringify([['extension.open', 'xnervwang.claude-code-plus']])) {
      ok('a dependent left behind is told to update itself; with the gallery unreachable its page opens with the reason');
    } else bad(`source too old: ${JSON.stringify([out, msgs, control.state.commands])}`);
  }

  /* engines.vscode */
  const gallery = require(path.join(root, 'src', 'gallery.js'));
  eq([gallery.engineAllows('^1.96.0', '1.145.2'), gallery.engineAllows('^1.150.0', '1.145.2'), gallery.engineAllows('>=1.90.0', '1.96.0'),
    gallery.engineAllows('^2.0.0', '1.145.2'), gallery.engineAllows('*', '1.0.0'), gallery.engineAllows('weird', '1.0.0')],
  [true, false, true, false, true, true], 'engineAllows() reads the ranges extensions use');
  eq([gallery.galleryOf('vscode'), gallery.galleryOf('vscode-insiders'), gallery.galleryOf('cursor'), gallery.galleryOf('kiro')],
    ['marketplace', 'marketplace', 'open-vsx', 'open-vsx'], 'editors other than VS Code look in Open VSX');
};
