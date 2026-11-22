// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The feature list of the window test (test/vscode/ui-features.json) against the steps of test/vscode/ui.js and this
 * extension's package.json: no setting, command or view is left out of the list, a feature with no step says why the
 * window cannot show it, and a feature's steps really do what it claims.
 *
 * The steps are read from the source, since loading ui.js needs Playwright. A step runs from its step('<name>', ...)
 * call to the next one. In those bodies:
 *   setting('<key>', ...)       changes a setting's value through the configuration API
 *   exec('<command>', ...)      runs a command
 *   viaUi('<command>', ...)     a click in the window, named after the command it runs
 *   '<view id>'                 a step that reads that view
 *   look('<name>', ...)         a screenshot
 */
const fs = require('fs');
const path = require('path');

/* Each step's name and body, in source order. */
function stepsOf(source) {
  const at = [...source.matchAll(/\bstep\(\s*'([a-z0-9-]+)'/g)];
  return at.map((m, i) => ({ name: m[1], body: source.slice(m.index, i + 1 < at.length ? at[i + 1].index : source.length) }));
}

module.exports = async ({ eq, root }) => {
  const features = JSON.parse(fs.readFileSync(path.join(root, 'test', 'vscode', 'ui-features.json'), 'utf8'));
  const file = path.join(root, 'test', 'vscode', 'ui.js');
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const steps = stepsOf(source);
  const byName = new Map();
  for (const s of steps) byName.set(s.name, (byName.get(s.name) || '') + s.body);
  const looks = new Set([...source.matchAll(/\blook\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = pkg.contributes.commands.map((c) => c.command);
  const settings = Object.keys(pkg.contributes.configuration.properties);
  const views = Object.values(pkg.contributes.views).flat().map((v) => v.id);

  eq(features.filter((f) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id) || typeof f.what !== 'string' || !f.what
    || !['steps', 'looks', 'settings', 'commands', 'views'].every((k) => Array.isArray(f[k]))).map((f) => f.id), [],
  'every feature has a lower-case hyphenated id, a line saying what it is, and lists of steps, looks, settings, commands and views');
  const ids = features.map((f) => f.id);
  eq(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'and no two features share an id');
  eq(features.filter((f) => !f.steps.length && !(typeof f.notInWindow === 'string' && f.notInWindow)).map((f) => f.id), [],
    'each feature is reached by at least one step, or says why the window cannot show it');
  eq(features.filter((f) => f.steps.length && f.notInWindow).map((f) => f.id), [], 'and none does both');
  eq(features.flatMap((f) => f.steps.filter((s) => !byName.has(s)).map((s) => `${f.id}: ${s}`)), [],
    'every step a feature names is a step of ui.js');
  const named = new Set(features.flatMap((f) => f.steps));
  eq([...byName.keys()].filter((s) => !named.has(s)), [], 'and every step of ui.js serves some feature');
  eq(features.filter((f) => f.steps.length && !f.looks.length).map((f) => f.id), [], 'each feature a step reaches has a picture in the look run');
  eq(features.flatMap((f) => f.looks.filter((l) => !looks.has(l)).map((l) => `${f.id}: ${l}`)), [], 'every picture a feature names is taken by ui.js');
  const pictured = new Set(features.flatMap((f) => f.looks));
  eq([...looks].filter((l) => !pictured.has(l)), [], 'and every picture ui.js takes belongs to some feature');

  const listed = (k) => new Set(features.flatMap((f) => f[k]));
  eq(settings.filter((s) => !listed('settings').has(s)), [], `each of the ${settings.length} settings in package.json is in a feature`);
  eq(commands.filter((c) => !listed('commands').has(c)), [], `each of the ${commands.length} commands in package.json is in a feature`);
  eq(views.filter((v) => !listed('views').has(v)), [], `each of the ${views.length} views in package.json is in a feature`);
  eq([...listed('settings')].filter((s) => !settings.includes(s)).concat([...listed('commands')].filter((c) => !commands.includes(c)),
    [...listed('views')].filter((v) => !views.includes(v))), [], 'and the list names no setting, command or view package.json does not have');

  const quoted = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodies = (f) => f.steps.map((s) => byName.get(s) || '');
  eq(features.flatMap((f) => f.settings.filter((key) => !bodies(f).some((b) => new RegExp(`\\bsetting\\(\\s*'${quoted(key)}'`).test(b)))
    .map((key) => `${f.id}: ${key}`)), [], 'every setting a feature lists is changed by one of its steps');
  eq(features.flatMap((f) => f.commands.filter((c) => !bodies(f).some((b) => new RegExp(`\\b(exec|viaUi)\\(\\s*'${quoted(c)}'`).test(b)))
    .map((c) => `${f.id}: ${c}`)), [], 'every command a feature lists is run by one of its steps, from the window or through the API');
  eq(features.flatMap((f) => f.views.filter((v) => !bodies(f).some((b) => b.includes(`'${v}'`))).map((v) => `${f.id}: ${v}`)), [],
    'every view a feature lists is read by one of its steps');
};

module.exports.stepsOf = stepsOf;
