// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * When an extension that depends on this one speaks a protocol major this build does not accept, the user is told once
 * which extension to update: this one when the other is newer, the other one when this build has dropped its major.
 *
 * The update button first asks the gallery whether its newest release would fix it. If so it runs
 * workbench.extensions.installExtension with the bare id, which for an installed extension installs the gallery's newest
 * version (read from VS Code's sources, extensions.contribution.ts; not tried against a live gallery). If not, or the
 * gallery cannot be reached, it opens the extension's page with the reason. Passing id@version would also work, but VS
 * Code then pins that version and stops updating it.
 */
const sources = require('./sources');
const gallery = require('./gallery');

const OFFERED_KEY = 'agentPlus.updateOffered';
const KEEP = 50;
const SELF = { id: 'xnervwang.agent-plus', name: 'Agent Plus' };

/* 'core' when this build is older than `protocol`, 'source' when it has dropped it, '' when they fit or it is unknown. */
function behind(protocol, accepts = sources.ACCEPTS) {
  if (!Number.isInteger(protocol) || protocol < 1) return '';
  const v = sources.verdict(protocol, accepts);
  return v === sources.REFUSED.coreTooOld ? 'core' : v === sources.REFUSED.sourceTooOld ? 'source' : '';
}

/* The text and button for a mismatch, `ext` being { id, name, version, protocol } of the other extension. */
function wording(who, ext, core) {
  const accepts = core.accepts.join(', ');
  if (who === 'core') {
    return {
      target: SELF,
      button: `Update ${SELF.name}`,
      message: `${ext.name} needs a newer ${SELF.name}: it uses protocol ${ext.protocol}, and ${SELF.name} ${core.version} accepts `
        + `${accepts}. Its conversations stay out of the work plan views until ${SELF.name} is updated.`,
    };
  }
  return {
    target: { id: ext.id, name: ext.name },
    button: `Update ${ext.name}`,
    message: `${ext.name} ${ext.version} is too old for ${SELF.name} ${core.version}: it uses protocol ${ext.protocol}, which `
      + `${SELF.name} no longer accepts (it accepts ${accepts}). Its conversations stay out of the work plan views until it is updated.`,
  };
}

/* Whether a gallery release `found` of the target fixes the mismatch. */
function fixes(who, found, ext, core) {
  if (who === 'core') {
    const accepts = found.accepts.length ? found.accepts : [(gallery.parts(found.version) || [0])[0]];
    return accepts.includes(ext.protocol);
  }
  return core.accepts.includes(found.protocol);
}

/*
 * Asks the gallery, then installs or opens the page. Resolves to 'installed', 'page' or 'failed'. `installed` is the
 * version of the target installed now.
 */
async function update({ vscode, who, ext, core, installed, fetch, say = () => {} }) {
  const w = wording(who, ext, core);
  const where = gallery.galleryOf(vscode.env && vscode.env.uriScheme) === 'marketplace' ? 'the Visual Studio Marketplace' : 'Open VSX';
  let found = null, why = '';
  try { found = await gallery.latest(w.target.id, { scheme: vscode.env && vscode.env.uriScheme, fetch }); }
  catch (e) { why = `${where} could not be reached (${(e && e.message) || e})`; }
  if (!why && !found) why = `${where} has no release of it`;
  if (!why && !gallery.engineAllows(found.engine, vscode.version)) {
    why = `its newest release, ${found.version}, needs VS Code ${found.engine}, and this is ${vscode.version}`;
  }
  if (!why && found.version === installed) why = `the newest release, ${found.version}, is the one installed`;
  if (!why && !fixes(who, found, ext, core)) {
    why = who === 'core'
      ? `its newest release, ${found.version}, does not accept protocol ${ext.protocol} either`
      : `its newest release, ${found.version}, does not use a protocol ${SELF.name} accepts either`;
  }
  if (why) {
    say(`update ${w.target.id}: ${why}`);
    try { await vscode.commands.executeCommand('extension.open', w.target.id); } catch (_) { /* the message still says why */ }
    vscode.window.showInformationMessage(`${w.target.name} cannot be updated from here: ${why}. Its page is open in the Extensions view.`);
    return 'page';
  }
  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', w.target.id, { enable: true });
  } catch (e) {
    say(`update ${w.target.id}: ${(e && e.message) || e}`);
    try { await vscode.commands.executeCommand('extension.open', w.target.id); } catch (_) { /* nothing else to show */ }
    return 'failed';
  }
  say(`updated ${w.target.id} to ${found.version}`);
  const reload = 'Reload Window';
  Promise.resolve(vscode.window.showInformationMessage(`${w.target.name} ${found.version} is installed. Reload the window to use it.`, reload))
    .then((pick) => (pick === reload ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined)).catch(() => {});
  return 'installed';
}

/*
 * Tells the user once per pair of versions. Resolves to 'told' (said before), 'dismissed', or update()'s result.
 * `memento` is this extension's globalState.
 */
async function offer({ vscode, memento, who, ext, core, fetch, say = () => {} }) {
  const key = `${core.version}|${ext.id}@${ext.version}|${who}`;
  const told = (memento && memento.get(OFFERED_KEY, [])) || [];
  if (told.includes(key)) return 'told';
  if (memento) await memento.update(OFFERED_KEY, told.concat([key]).slice(-KEEP));
  const w = wording(who, ext, core);
  say(w.message);
  const pick = await vscode.window.showWarningMessage(w.message, w.button);
  if (pick !== w.button) return 'dismissed';
  const installed = who === 'core' ? core.version : ext.version;
  return update({ vscode, who, ext, core, installed, fetch, say });
}

module.exports = { OFFERED_KEY, SELF, behind, wording, fixes, update, offer };
