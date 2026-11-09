// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which installed extensions depend on this one, read from their manifests. This is synchronous and needs none of them
 * to have activated, so being alone is settled on the first turn this extension gets rather than seconds later, when
 * whichever extension uses it happens to register. That is what src/host.js needs to set agentPlus.alone, the one
 * key the views are hidden by, and that key is read the other way round for a reason the comment above it in
 * src/host.js gives: the panel a window had open is put back before any of this runs, so hiding the views can only ever
 * be something done after the fact, never something they start out as.
 *
 * vscode.extensions.all lists the extensions of this extension host that are enabled, so one installed on the other side
 * of a remote connection, or disabled, is not seen. That is why being alone is only ever said, never acted on.
 */
const SELF = 'xnervwang.agent-plus';
/*
 * The extensions known to use this one, offered when it is installed alone. `name` is the name each one goes by in the
 * marketplace and in the Extensions view. These are the only place the names are written, so a marketplace name
 * changing is one line here.
 */
const KNOWN = [
  { id: 'xnervwang.claude-code-plus', name: 'Claude Code Plus' },
  { id: 'xnervwang.codex-plus', name: 'Codex Plus' },
];
/** "A, B and C" for a list of names. */
const nameList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

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
    const declared = field(pkg, 'agentPlus');
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

module.exports = { SELF, KNOWN, nameList, dependentsOf, notice };
