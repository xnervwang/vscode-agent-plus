// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of the window test a run takes (test/vscode/lib/steps.js): those a regular expression of step names
 * matches, with the steps they name in needs('…'), and how .github/workflows/vscode.yml passes such an expression and a
 * system when it is run by hand.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ eq, tmp, root }) => {
  const steps = require(path.join(root, 'test', 'vscode', 'lib', 'steps.js'));
  const file = path.join(tmp('steps'), 'ui.js');
  fs.writeFileSync(file, ["  await step('a', async () => {", '  });', "  await step('b\\'s', async () => {", "    needs('a');", '  });',
    "  await step('c', async () => {", "    needs('b\\'s');", '  });', "  await step('d', async () => {", '  });'].join('\n'));
  const names = steps.namesIn(file), needs = steps.needsIn(file);
  eq([names, needs], [['a', "b's", 'c', 'd'], { "b's": ['a'], c: ["b's"] }], 'the steps are read in order, each with the steps it needs');
  const run = (only) => { const s = steps.chosen({ names, only, needs }); return s && names.filter((x) => s.has(x)); };
  eq([run(null), run(/^c$/), run(/^d$/), run(/^z$/)], [null, ['a', "b's", 'c'], ['d'], []],
    'with no expression every step runs; one runs the steps it matches and what they need, followed through');
  eq(steps.unknown({ names, needs: { c: ['x'] } }), ['x'], 'a need that is no step is found');

  const ui = path.join(root, 'test', 'vscode', 'ui.js');
  const all = steps.namesIn(ui), declared = steps.needsIn(ui);
  eq([all.length > 40, new Set(all).size === all.length, steps.unknown({ names: all, needs: declared })], [true, true, []],
    'the window test\'s steps are read from it, each once, and every step it needs is one of them');
  eq(Object.entries(declared).filter(([x, ys]) => ys.some((y) => all.indexOf(y) >= all.indexOf(x))), [], 'and comes before the step that needs it');

  const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'vscode.yml'), 'utf8');
  eq([/inputs:\s*\n\s+os:[\s\S]*options:\s*\[all,\s*ubuntu-latest,\s*macos-latest,\s*windows-latest\]/.test(yml), /\n\s+steps:\s*\n\s+description:/.test(yml),
    /os:[^\n]*\["ubuntu-latest",\s*"macos-latest",\s*"windows-latest"\]/.test(yml), /AGENT_PLUS_UI_STEPS:\s*\$\{\{\s*inputs\.steps\s*\}\}/.test(yml)],
  [true, true, true, true], 'the workflow runs on all three systems, and by hand on one, with only the steps an expression names');
};
