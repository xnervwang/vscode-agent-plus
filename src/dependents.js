// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which installed extensions depend on this one, read from their manifests. This is synchronous and needs none of them
 * to have activated, so the views can be shown or hidden the moment this extension starts: VS Code restores the panel
 * a window last had open while extensions start, and a view that is hidden then stays hidden.
 *
 * vscode.extensions.all lists the extensions of this extension host that are enabled, so one installed on the other side
 * of a remote connection, or disabled, is not seen. That is why being alone is only ever said, never acted on.
 */
const SELF = 'xnervwang.agent-work-plan';
/* The extensions known to use this one, offered when it is installed alone. */
const KNOWN = [
  { id: 'xnervwang.claude-code-extras', name: 'Claude Code Extras' },
  { id: 'xnervwang.codex-extras', name: 'Codex Extras' },
];

const field = (o, k) => { try { return o == null ? undefined : o[k]; } catch (_) { return undefined; } };

/** The extensions in `all` whose extensionDependencies name `self`: [{ id, name, version, protocol }]. */
function dependentsOf(all, self = SELF) {
  const out = [];
  let list = [];
  try { list = Array.from(all || []); } catch (_) { list = []; }
  const want = self.toLowerCase();
  for (const ext of list) {
    const id = field(ext, 'id');
    const pkg = field(ext, 'packageJSON') || {};
    const deps = field(pkg, 'extensionDependencies');
    if (typeof id !== 'string' || id.toLowerCase() === want || !Array.isArray(deps)) continue;
    if (!deps.some((d) => typeof d === 'string' && d.toLowerCase() === want)) continue;
    const declared = field(pkg, 'agentWorkPlan');
    const protocol = field(declared, 'protocol');
    out.push({
      id,
      name: typeof field(pkg, 'displayName') === 'string' ? pkg.displayName : id,
      version: typeof field(pkg, 'version') === 'string' ? pkg.version : '',
      protocol: Number.isInteger(protocol) ? protocol : 0,
    });
  }
  return out;
}

/*
 * What to tell someone who has this extension with nothing that uses it: 'alone' when nothing ever did on this
 * profile, 'orphaned' when something did and is gone, '' when there is a dependent or it was said already.
 */
function notice({ dependents, hadDependents, told }) {
  if (dependents.length) return '';
  const kind = hadDependents ? 'orphaned' : 'alone';
  return told && told[kind] ? '' : kind;
}

module.exports = { SELF, KNOWN, dependentsOf, notice };
