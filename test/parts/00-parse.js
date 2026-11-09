// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Everything shipped parses, every source file carries the license header, and the numbers package.json states under
 * "agentPlus" are the ones the code uses.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function jsFiles(root) {
  const out = ['extension.js'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel); else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('src');
  walk('test');
  walk('build');
  return out.sort();
}

module.exports = async ({ ok, bad, eq, root }) => {
  const files = jsFiles(root);
  const broken = [];
  for (const f of files) {
    try { new vm.Script(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }); } catch (e) { broken.push(`${f}: ${e.message}`); }
  }
  if (broken.length) bad('parse: ' + broken.join('; ')); else ok(`${files.length} files parse`);
  const header = '// BSD 3-Clause License\n// Copyright (c) 2026, Xnerv Wang\n// All rights reserved.\n';
  eq(files.filter((f) => !fs.readFileSync(path.join(root, f), 'utf8').startsWith(header)), [], 'every source file carries the license header');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sources = require(path.join(root, 'src', 'sources.js'));
  eq([pkg.agentPlus.protocol, pkg.agentPlus.accepts], [sources.PROTOCOL, sources.ACCEPTS], 'package.json states the protocol and accepted majors the code uses');
  eq(Number(pkg.version.split('.')[0]), sources.PROTOCOL, 'the first number of the version is the protocol major');
  if (sources.ACCEPTS.includes(sources.PROTOCOL)) ok('the host accepts its own protocol major'); else bad('ACCEPTS leaves out PROTOCOL');
  eq([pkg.extensionKind, pkg.activationEvents], [['workspace'], ['onStartupFinished']], 'it runs beside its sources and starts after startup');
  eq(pkg.capabilities && pkg.capabilities.untrustedWorkspaces && pkg.capabilities.untrustedWorkspaces.supported, 'limited', 'it runs, limited, in Restricted Mode');
  eq([pkg.icon, fs.existsSync(path.join(root, 'images', 'icon.png')), fs.existsSync(path.join(root, 'images', 'icon.svg'))], ['images/icon.png', true, true], 'the marketplace icon is images/icon.png, with its source beside it');
  const containers = [].concat(pkg.contributes.viewsContainers.activitybar, pkg.contributes.viewsContainers.panel);
  eq([containers.map((c) => c.icon), fs.existsSync(path.join(root, 'images', 'sidebar.svg'))], [['images/sidebar.svg', 'images/sidebar.svg'], true],
    'both containers use images/sidebar.svg, which is in the repository');
  const ids = JSON.stringify(pkg.contributes).match(/"(?:command|id|view)":"[^"]+"/g) || [];
  const foreign = ids.filter((s) => !/"(agentPlus[.A-Za-z]*)"/.test(s));
  eq(foreign, [], 'every container, view and command id is in the agentPlus namespace');
  const settings = Object.keys(pkg.contributes.configuration.properties);
  eq(settings.filter((k) => !k.startsWith('agentPlus.')), [], 'every setting is in the agentPlus namespace');
};
