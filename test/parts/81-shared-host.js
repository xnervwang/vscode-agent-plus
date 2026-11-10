// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The extension-host modules in shared/host/, loaded from one src/ folder together with src/files.js, as an extension
 * loads its copies. Covers patching a target and restoring it, finding installed copies for the uninstall hook,
 * writing the hooks' settings files, registering with this extension, and delivering an answer once per delivery id.
 */
const fs = require('fs');
const path = require('path');

/* A folder laid out like an extension's src/, with this repository's copies of every shared host module in it. */
function layout(root, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'src', 'files.js'), path.join(dir, 'files.js'));
  for (const f of fs.readdirSync(path.join(root, 'shared', 'host'))) fs.copyFileSync(path.join(root, 'shared', 'host', f), path.join(dir, f));
  return (name) => require(path.join(dir, name));
}

module.exports = async ({ ok, bad, eq, tmp, root, wait }) => {
  const mod = layout(root, path.join(tmp('ext'), 'src'));
  const { applyEdits } = mod('edits.js');
  eq(applyEdits('a', [{ name: 'x', re: /b/g, to: 'c' }], 'Codex').error, '"x" matched 0 times (expected 1) - this Codex build is not supported yet',
    'an edit that does not fit names the agent whose build it is');

  {
    const { patchTarget, applyAll } = mod('patch-target.js');
    const dir = tmp('agent');
    const file = path.join(dir, 'main.js');
    const order = [];
    let version = 'v1';
    const target = (extra = {}) => ({ name: 'main', ...patchTarget({
      file: (d) => path.join(d, 'main.js'), mark: () => `/* MARK ${version} */`, anyMark: '/* MARK ', backupSuffix: '.mine.bak',
      transform: (src) => (src.includes('ok') ? { out: `/* MARK ${version} */\n` + src.replace('ok', 'OK') } : { error: 'does not fit' }),
      usableBackup: (t) => t.includes('ok'), beforeWrite: () => order.push('side file'), afterRestore: (d, r) => order.push('after ' + r.message),
      say: { missing: (f) => `gone: ${path.basename(f)}`, badBackup: 'backup is bad' }, ...extra }) });
    const t = target();
    eq([t.status(dir), t.apply(dir).message], ['missing', 'gone: main.js'], 'a missing file is reported with the target\'s own words');
    fs.writeFileSync(file, 'ok');
    const first = t.apply(dir);
    eq([first, t.status(dir), fs.readFileSync(file + '.mine.bak', 'utf8'), order],
      [{ changed: true, current: true, message: 'patched' }, 'patched', 'ok', ['side file']],
      'a clean file is backed up, the side file written, and the file patched');
    eq(t.apply(dir), { changed: false, current: true, message: 'already patched' }, 'and patching again changes nothing');
    version = 'v2';
    eq([t.status(dir), t.apply(dir).changed, fs.readFileSync(file, 'utf8')], ['outdated', true, '/* MARK v2 */\nOK'],
      'another version\'s patch is redone from the backup');
    version = 'v3';
    fs.writeFileSync(file + '.mine.bak', '/* MARK v1 */ ok');
    eq(t.apply(dir).message, 'an older patch is present and its backup carries one too', 'a backup carrying a mark is not patched from');
    fs.unlinkSync(file + '.mine.bak');
    eq(t.apply(dir).message, 'an older patch is present but its backup is missing', 'nor is an outdated file without a backup');
    fs.writeFileSync(file + '.mine.bak', 'ok');
    const racing = target({ beforeWrite: () => fs.renameSync(file + '.mine.bak', path.join(dir, 'moved')) });
    racing.apply(dir);
    eq(fs.readFileSync(file + '.mine.bak', 'utf8'), 'ok', 'a backup another window moved back meanwhile is written again from the original');
    order.length = 0;
    eq([t.restore(dir), fs.readFileSync(file, 'utf8'), fs.existsSync(file + '.mine.bak'), order],
      [{ changed: true, message: 'restored' }, 'ok', false, ['after restored']], 'restore moves the backup back over the file');
    eq(t.restore(dir), { changed: false, message: 'nothing to restore' }, 'and a second restore finds nothing to do');
    t.apply(dir);
    fs.writeFileSync(file + '.mine.bak', 'garbage');
    eq(t.restore(dir), { changed: false, message: 'backup is bad' }, 'a backup that fails the target\'s check is not put back');
    fs.writeFileSync(file + '.mine.bak', 'ok');
    t.restore(dir);

    const other = { name: 'other', status: () => 'clean', apply: () => ({ changed: false, current: false, message: 'refused' }), restore: () => {} };
    const r = applyAll([t, other], dir, { allOrNothing: true });
    eq([r.map(([n, x]) => [n, x.current]), fs.readFileSync(file, 'utf8')], [[['main', true], ['other', false]], 'ok'],
      'with allOrNothing, one target that fails has the others put back');
    applyAll([t, other], dir);
    eq(t.status(dir), 'patched', 'without it, the others stay patched');
    t.restore(dir);
  }

  {
    const { writeAtomic } = mod('files.js');
    const dir = tmp('atomic');
    const file = path.join(dir, 'f.txt');
    const real = fs.renameSync;
    let fails = 1;
    fs.renameSync = (a, b) => { if (fails-- > 0) throw new Error('busy'); return real(a, b); };
    try {
      writeAtomic(file, 'x', undefined, { tag: '.mine', tries: 2 });
      eq([fs.readFileSync(file, 'utf8'), fs.readdirSync(dir)], ['x', ['f.txt']], 'a write given two tries survives one failed rename and leaves no temporary file');
      fails = 1;
      let threw = false;
      try { writeAtomic(file, 'y'); } catch (_) { threw = true; }
      eq([threw, fs.readFileSync(file, 'utf8'), fs.readdirSync(dir)], [true, 'x', ['f.txt']], 'and one given a single try fails with the file left whole');
    } finally { fs.renameSync = real; }
  }

  {
    const copies = mod('installed-copies.js');
    const home = tmp('home');
    const ext = (editor) => { const d = path.join(home, editor, 'extensions'); fs.mkdirSync(d, { recursive: true }); return d; };
    const mine = ext('.vscode-server');
    const ID = 'pub.thing', OLD = 'pub.old-thing';
    fs.mkdirSync(path.join(mine, `${ID}-1.0.0`));
    fs.mkdirSync(path.join(mine, `${ID}-0.9.0.1a2b3c4d.vsctmp`));
    fs.mkdirSync(path.join(mine, 'pub.thingamajig-1.0.0'));
    eq(copies.liveCopies(mine, [ID, OLD]).map((d) => path.basename(d)), [`${ID}-1.0.0`],
      'a copy is <id>-<version>: not a leftover renamed to .vsctmp, nor an extension whose name merely starts the same');
    const cursor = ext('.cursor');
    fs.mkdirSync(path.join(cursor, `${OLD}-0.5.0`));
    const elsewhere = path.join(home, 'custom-extensions');
    fs.mkdirSync(elsewhere);
    const saved = process.env.VSCODE_EXTENSIONS;
    process.env.VSCODE_EXTENSIONS = elsewhere;
    try {
      const own = path.join(mine, `${ID}-1.0.0`);
      fs.writeFileSync(path.join(mine, '.obsolete'), JSON.stringify({ [`${ID}-1.0.0`]: true }));
      eq([copies.beingUninstalled(own, [ID, OLD]), copies.standing(own, [ID, OLD], 0)], [true, 'uninstalling'],
        'a marked copy with no other copy beside it is being uninstalled');
      const p = copies.plan(mine, [ID, OLD], { home });
      eq([p.restore.includes(path.resolve(mine)), p.restore.includes(path.resolve(elsewhere)), p.restore.includes(path.resolve(cursor)), p.lastCopy],
        [true, true, false, false], 'the plan puts back its own folder and VSCODE_EXTENSIONS, and leaves an editor whose copy (under a former id) remains');
      fs.mkdirSync(path.join(mine, `${ID}-1.1.0`));
      eq([copies.standing(own, [ID, OLD], 0), copies.plan(mine, [ID, OLD], { home }).lastCopy],
        ['replaced', false], 'after an update the old copy is replaced, and no copy is the last one while the new one stays');
      fs.writeFileSync(path.join(own, 'package.json'), JSON.stringify({ __metadata: { installedTimestamp: 2 } }));
      eq([copies.installStamp(own), copies.replacedSince(own, 1), copies.replacedSince(own, 2), copies.replacedSince(own, 0)], [2, true, false, false],
        'the same version installed again changes the install stamp');
    } finally { if (saved === undefined) delete process.env.VSCODE_EXTENSIONS; else process.env.VSCODE_EXTENSIONS = saved; }
    const spawned = [];
    copies.detachHook('/x/ext', (bin, args, opts) => { spawned.push([args, opts.detached, opts.env.ELECTRON_RUN_AS_NODE]); return { unref() {} }; });
    eq(spawned, [[[path.join('/x/ext', 'uninstall.js')], true, '1']], 'the uninstall hook is started detached, as plain Node');
  }

  {
    const settings = mod('hook-settings.js');
    const dir = path.join(tmp('plugin-data'), 'data');
    const marker = path.join(tmp('storage'), 'mine');
    const gone = path.join(tmp('storage'), 'gone');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ extensionMarkers: [gone, 'relative'] }));
    eq(settings.writeHookSettings(dir, { enabled: true }, { marker }), true, 'the settings are written');
    eq(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { enabled: true, extensionMarkers: [marker] },
      'with this editor\'s marker listed, one that is gone or not absolute dropped');
    const before = fs.statSync(path.join(dir, 'config.json')).mtimeMs;
    await wait(20);
    eq([settings.writeHookSettings(dir, { enabled: true }, { marker }), fs.statSync(path.join(dir, 'config.json')).mtimeMs === before], [false, true],
      'the same settings again leave the file alone');
    eq([settings.writeClientZone(dir, ''), settings.writeClientZone(dir, 'Asia/Tokyo'), settings.writeClientZone(dir, 'Asia/Tokyo')], [false, true, false],
      'the zone is written once, and an empty one not at all');
    eq(fs.readdirSync(dir).sort(), ['client-time-zone.json', 'config.json'], 'and no temporary file is left');
  }

  {
    const link = mod('core-link.js');
    const said = [], context = {};
    const fakeV = (api) => ({
      extensions: { getExtension: (id) => (api && id === link.CORE_ID ? { isActive: true, exports: api } : undefined) },
      commands: { executeCommand: async (cmd, k, v) => { if (cmd === 'setContext') context[k] = v; } },
    });
    const memo = new Map();
    const memento = { get: (k) => memo.get(k), update: async (k, v) => { memo.set(k, v); } };
    const opts = { name: 'the X source', contextKey: 'x.registered', memento, toldKey: 'x.told', tell: (why) => said.push(why) };
    const none = await link.link(fakeV(null), {}, opts);
    await link.link(fakeV(null), {}, opts);
    eq([none.code, context['x.registered'], said], ['no-core', false, ['Agent Plus is not installed or not enabled']],
      'with no Agent Plus the context key is off and the user is told once per reason');
    const reg = { dispose() {} };
    const yes = await link.link(fakeV({ agentPlus: { features: ['python'], registerSource: () => ({ accepted: true, registration: reg }) } }), {}, opts);
    eq([yes.registered, yes.registration === reg, context['x.registered'], link.coreHas(yes.core, 'python'), link.coreHas(yes.core, 'other')],
      [true, true, true, true, false], 'a taken source turns the key on and hands back Agent Plus, whose capabilities can be asked by name');
    const no = await link.link(fakeV({ agentPlus: { registerSource: () => ({ accepted: false, code: 'major', reason: 'too new' }) } }), {}, opts);
    eq([no.registered, no.code, context['x.registered']], [false, 'major', false], 'a refusal is passed on');

    let typed = 0, release;
    const gate = new Promise((r) => { release = r; });
    const deliver = link.oncePerDelivery(async () => { typed++; await gate; return { outcome: 'submitted' }; });
    const a = deliver('s', 'hi', { deliveryId: 'd1' });
    const b = deliver('s', 'hi', { deliveryId: 'd1' });
    release();
    eq([await a, await b, typed], [{ outcome: 'submitted' }, { outcome: 'submitted' }, 1],
      'one delivery id asked twice, the second while the first still runs, is typed once');
    let tries = 0;
    const flaky = link.oncePerDelivery(async () => (++tries === 1 ? { outcome: 'notReceived' } : { outcome: 'drafted' }));
    await flaky('s', 'hi', { deliveryId: 'd2' });
    eq([(await flaky('s', 'hi', { deliveryId: 'd2' })).outcome, tries], ['drafted', 2], 'and an id that did not get there may be tried again');
  }

  {
    const { folderTest, realPath } = require(path.join(root, 'src', 'folders.js'));
    const base = tmp('folders');
    const real = path.join(base, 'real');
    fs.mkdirSync(path.join(real, 'ws'), { recursive: true });
    fs.symlinkSync(real, path.join(base, 'link'));
    const inWs = folderTest([path.join(base, 'link', 'ws')]);
    eq([inWs(path.join(real, 'ws', 'sub')), inWs(path.join(real, 'other')), realPath(path.join(base, 'link', 'ws', 'deleted', 'deeper'))],
      [true, false, path.join(fs.realpathSync(real), 'ws', 'deleted', 'deeper')],
      'a folder is placed by its real path, a deleted one through the nearest folder that still exists');
  }
};
