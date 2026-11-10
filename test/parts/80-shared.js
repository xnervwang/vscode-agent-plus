// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * shared/ holds the code Claude Code Plus and Codex Plus each ship a copy of. Every file there names its own path as
 * its source, pack-vsix.js reads .vscodeignore as vsce does, make-manifest.js refuses a file with no extension or a
 * missing license, and sync-shared.js copies files, records their hashes and fails on a copy edited in place.
 * pack-check.js also runs on this repository's own package.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async (h) => {
  const { ok, bad, eq, tmp, root } = h;
  const shared = path.join(root, 'shared');
  const sync = require(path.join(shared, 'build', 'sync-shared.js'));
  const pack = require(path.join(shared, 'build', 'pack-vsix.js'));
  const manifest = path.join(shared, 'build', 'make-manifest.js');

  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else files.push(path.relative(root, path.join(d, e.name)).split(path.sep).join('/')); } };
  walk(shared);
  eq(files.filter((f) => !fs.readFileSync(path.join(root, f), 'utf8').includes(sync.sourceLine(f))), [],
    `each of the ${files.length} files in shared/ names itself as the source its copies come from`);

  await require(path.join(shared, 'test', 'pack-check.js'))(h, root);
  const rules = pack.ignoreRules(root);
  eq([pack.ignored(rules, 'shared/build/pack-vsix.js'), pack.listedIn(root).includes('shared')], [true, false],
    'and this extension\'s own package leaves shared/ out');

  {
    const dir = tmp('ignore');
    fs.writeFileSync(path.join(dir, '.vscodeignore'), '# comment\n*.vsix\nbuild/**\n\ndocs\n**/__pycache__/**\nimages/shot-*.png\n!images/shot-keep.png\nREADME.md\n');
    const r = pack.ignoreRules(dir);
    const got = ['a.vsix', 'src/a.vsix', 'build/x/y.js', 'docs/p.md', 'docsx/p.md', 'src/__pycache__/m.pyc', '__pycache__/m.pyc',
      'images/shot-1.png', 'images/shot-keep.png', 'images/icon.png', 'README.md'].filter((f) => pack.ignored(r, f));
    eq(got, ['a.vsix', 'build/x/y.js', 'docs/p.md', 'src/__pycache__/m.pyc', '__pycache__/m.pyc', 'images/shot-1.png'],
      '.vscodeignore is read as vsce reads it: * stays within the top folder, a name covers a folder, ! takes back, README.md always ships');
    let refused = '';
    try { pack.globRe('{a,b}.js'); } catch (e) { refused = e.message; }
    eq(/braces/.test(refused), true, 'and a pattern this reading does not understand stops the build instead of being misread');
  }

  {
    const stage = tmp('manifest');
    const ext = path.join(stage, 'extension');
    fs.mkdirSync(ext);
    const pkg = { name: 'x', publisher: 'p', version: '1.2.3', displayName: 'X', description: 'd', engines: { vscode: '^1.96.0' } };
    fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(ext, 'a.wasm'), 'x');
    const run = (...a) => cp.spawnSync(process.execPath, [manifest, stage, ...a], { encoding: 'utf8' });
    const noLicense = run();
    eq([noLicense.status, /LICENSE\.txt/.test(noLicense.stderr)], [1, true], 'a package without LICENSE.txt, which the manifest names, stops the build');
    fs.writeFileSync(path.join(ext, 'LICENSE.txt'), 'x');
    const plain = run();
    const vsix = fs.readFileSync(path.join(stage, 'extension.vsixmanifest'), 'utf8');
    const types = fs.readFileSync(path.join(stage, '[Content_Types].xml'), 'utf8');
    eq([plain.status, /<Icon>/.test(vsix), /Version="1\.2\.3"/.test(vsix), /Extension="\.wasm" ContentType="application\/octet-stream"/.test(types)],
      [0, false, true, true], 'without an icon the icon entries are left out, the staged package.json is the one read, and an unlisted extension still gets a type');
    const other = path.join(stage, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ ...pkg, version: '9.9.9', icon: 'i.png' }));
    fs.writeFileSync(path.join(ext, 'i.png'), 'x');
    const named = run(other);
    eq([named.status, /Version="9\.9\.9"/.test(fs.readFileSync(path.join(stage, 'extension.vsixmanifest'), 'utf8'))], [0, true],
      'a package.json named after the staging folder is read instead');
    fs.writeFileSync(path.join(ext, 'NOTICE'), 'x');
    const bare = run();
    eq([bare.status, /NOTICE/.test(bare.stderr)], [1, true], 'a file with no extension, which the package could not carry, stops the build, naming it');
  }

  {
    const repo = tmp('extension-repo');
    fs.writeFileSync(path.join(repo, 'shared.json'), JSON.stringify({ core: '', files: [
      { path: 'build/sync-shared.js', from: 'shared/build/sync-shared.js' },
      { path: 'build/make-manifest.js', from: 'shared/build/make-manifest.js' },
      { path: 'test/shared-copies.js', from: 'shared/test/shared-copies.js' },
    ] }));
    eq(sync.sync(repo, root), ['build/sync-shared.js', 'build/make-manifest.js', 'test/shared-copies.js'], 'sync-shared.js copies each listed file');
    const m = sync.readManifest(repo);
    eq([fs.readFileSync(path.join(repo, 'build', 'make-manifest.js')).equals(fs.readFileSync(manifest)),
      m.files.every((f) => f.sha256 === sync.sha256(path.join(root, f.from))), /^[0-9a-f]{40}(-dirty)?$/.test(m.core)],
    [true, true, true], 'byte for byte, recording each hash and the Agent Plus commit');
    eq(sync.sync(repo, root), [], 'and a second sync copies nothing');

    const results = [];
    const sub = { ok: (s) => results.push('ok ' + s), bad: (s) => results.push('bad ' + s), note: (s) => results.push('note ' + s),
      eq: (g, w, s) => results.push((JSON.stringify(g) === JSON.stringify(w) ? 'ok ' : 'bad ') + s) };
    const copies = require(path.join(repo, 'test', 'shared-copies.js'));
    const committed = !m.core.endsWith('-dirty');
    await copies(sub, repo, root);
    eq(results.filter((r) => !r.startsWith('ok ')).length, committed ? 0 : 1, 'the copied check passes in the extension when nothing has moved');

    fs.appendFileSync(path.join(repo, 'build', 'make-manifest.js'), '// local edit\n');
    eq(sync.checkCopies(repo).length, 1, 'a copy edited in the extension is caught');
    const cli = cp.spawnSync(process.execPath, [path.join(repo, 'build', 'sync-shared.js'), '--check'], { encoding: 'utf8', env: { ...process.env, AGENT_WORK_PLAN_DIR: root } });
    eq([cli.status, /make-manifest\.js was changed here/.test(cli.stdout)], [1, true], 'and --check exits 1 naming it');
    sync.sync(repo, root);

    const core = tmp('core-ahead');
    for (const f of m.files) { fs.mkdirSync(path.dirname(path.join(core, f.from)), { recursive: true }); fs.copyFileSync(path.join(root, f.from), path.join(core, f.from)); }
    fs.appendFileSync(path.join(core, 'shared', 'build', 'make-manifest.js'), '// newer\n');
    results.length = 0;
    await copies(sub, repo, core);
    eq([sync.checkCore(repo, core), results.some((r) => r.startsWith('note ') && /moved on/.test(r)), results.some((r) => r.startsWith('bad ') && /moved on/.test(r))],
      [['shared/build/make-manifest.js has changed in Agent Plus'], true, false],
      'a source that has moved on in Agent Plus is only noted, not failed');
    fs.writeFileSync(path.join(core, 'shared', 'build', 'make-manifest.js'), 'no source line\n');
    let refused = '';
    try { sync.sync(repo, core); } catch (e) { refused = e.message; }
    eq(/does not carry the line naming its source/.test(refused), true, 'and a source without the line naming it is not copied');
  }
  if (!fs.existsSync(path.join(root, 'build', 'make-manifest.js'))) ok('build/ keeps no second copy of the descriptor writer');
  else bad('build/make-manifest.js is a second copy of shared/build/make-manifest.js');
};
