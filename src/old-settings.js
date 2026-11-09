// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Settings this extension took over from the Claude Code extension that drew its views before it, under that
 * extension's ids (xnervwang.claude-code-extras, whose prefix was claudeCodeExtras and later claudeCodeWorkPlan). A value
 * someone set there is copied to this extension's own setting at the same scope, unless that scope already has one.
 * The old entries are left where they are: they belong to settings another extension declared.
 *
 * Each scope is taken over once, recorded in globalState for the user's settings and in workspaceState for the
 * workspace's, so a value reset afterwards is not copied back from the old entry still standing beside it; a scope
 * whose write failed is not recorded, and is tried again next time. Nothing is written in Restricted Mode, where the
 * workspace's settings file belongs to a folder not yet trusted. From renameSettings in Claude Code Plus's extension.js.
 */
const ADOPTED = [
  { to: 'agentPlus.conversationsView', from: ['claudeCodeWorkPlan.conversations', 'claudeCodeExtras.conversations'] },
];
const SCOPES = [['globalValue', 'Global', 'globalState'], ['workspaceValue', 'Workspace', 'workspaceState']];
const DONE_KEY = 'agentPlus.oldSettingsAdopted';

const split = (key) => { const i = key.indexOf('.'); return [key.slice(0, i), key.slice(i + 1)]; };
function inspect(vscode, key) {
  const [section, name] = split(key);
  try { return vscode.workspace.getConfiguration(section).inspect(name) || {}; } catch (_) { return {}; }
}

/* Resolves to the [key, scope, value] written. `context` holds the record of which scopes are done; without one every
   scope is looked at each time. */
async function adopt(vscode, context) {
  const written = [];
  if (vscode.workspace.isTrusted === false) return written;
  for (const [field, target, store] of SCOPES) {
    const state = context && context[store];
    if (state && state.get(DONE_KEY)) continue;
    let complete = true;
    for (const { to, from } of ADOPTED) {
      if (inspect(vscode, to)[field] !== undefined) continue;
      const old = from.map((k) => inspect(vscode, k)[field]).find((v) => typeof v === 'boolean');
      if (old === undefined) continue;
      const [section, name] = split(to);
      try {
        await vscode.workspace.getConfiguration(section).update(name, old, vscode.ConfigurationTarget[target]);
        written.push([to, target, old]);
      } catch (_) { complete = false; }
    }
    if (state && complete) await state.update(DONE_KEY, true);
  }
  return written;
}

module.exports = { adopt, ADOPTED, DONE_KEY };
