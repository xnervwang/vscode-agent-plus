// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Settings this extension took over from the Claude Code extension that drew its views before it, under that
 * extension's ids (xnervwang.claude-code-extras, whose prefix was claudeCodeExtras and later claudeCodeWorkPlan). A value
 * someone set there is copied to this extension's own setting at the same scope, unless that scope already has one.
 * The old entries are left where they are: they belong to settings another extension declared.
 */
const ADOPTED = [
  { to: 'agentPlus.conversationsView', from: ['claudeCodeWorkPlan.conversations', 'claudeCodeExtras.conversations'] },
];
const SCOPES = [['globalValue', 'Global'], ['workspaceValue', 'Workspace']];

const split = (key) => { const i = key.indexOf('.'); return [key.slice(0, i), key.slice(i + 1)]; };
function inspect(vscode, key) {
  const [section, name] = split(key);
  try { return vscode.workspace.getConfiguration(section).inspect(name) || {}; } catch (_) { return {}; }
}

/* Resolves to the [key, scope, value] written. */
async function adopt(vscode) {
  const written = [];
  for (const { to, from } of ADOPTED) {
    const ours = inspect(vscode, to);
    for (const [field, target] of SCOPES) {
      if (ours[field] !== undefined) continue;
      const old = from.map((k) => inspect(vscode, k)[field]).find((v) => typeof v === 'boolean');
      if (old === undefined) continue;
      const [section, name] = split(to);
      await vscode.workspace.getConfiguration(section).update(name, old, vscode.ConfigurationTarget[target]);
      written.push([to, target, old]);
    }
  }
  return written;
}

module.exports = { adopt, ADOPTED };
