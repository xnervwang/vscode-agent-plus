// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The newest release of an extension on the gallery this editor installs from, with what its package.json says under
 * "agentPlus" and the VS Code versions it supports. Used only after the user clicked an update button, to tell
 * whether updating can fix the mismatch before VS Code is asked to install anything.
 *
 * VS Code itself installs from the Visual Studio Marketplace; editors built from its sources (VSCodium, Cursor, Kiro)
 * install from Open VSX. Which one applies is read from vscode.env.uriScheme.
 */
const MARKETPLACE = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX = 'https://open-vsx.org/api';
const MARKETPLACE_SCHEMES = ['vscode', 'vscode-insiders', 'vscode-exploration'];
const TIMEOUT_MS = 10000;
/* IncludeVersions | IncludeFiles | IncludeVersionProperties | IncludeAssetUri | ExcludeNonValidated. */
const FLAGS = 0x1 | 0x2 | 0x10 | 0x80 | 0x200;
const MANIFEST = 'Microsoft.VisualStudio.Code.Manifest';
const ENGINE = 'Microsoft.VisualStudio.Code.Engine';
const PRE_RELEASE = 'Microsoft.VisualStudio.Code.PreRelease';

const galleryOf = (scheme) => (MARKETPLACE_SCHEMES.includes(String(scheme || 'vscode')) ? 'marketplace' : 'open-vsx');

async function timed(fetchFn, url, init = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
  try {
    const res = await fetchFn(url, ctl ? { ...init, signal: ctl.signal } : init);
    if (!res || !res.ok) throw new Error(`${url.split('?')[0]} answered ${res ? res.status : 'nothing'}`);
    return await res.json();
  } finally { if (t) clearTimeout(t); }
}

async function fromMarketplace(id, fetchFn) {
  const body = await timed(fetchFn, MARKETPLACE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }], pageNumber: 1, pageSize: 1 }], flags: FLAGS }),
  });
  const ext = body && body.results && body.results[0] && body.results[0].extensions && body.results[0].extensions[0];
  if (!ext) return null;
  const prop = (v, k) => ((v.properties || []).find((p) => p.key === k) || {}).value;
  const release = (ext.versions || []).find((v) => prop(v, PRE_RELEASE) !== 'true');
  if (!release) return null;
  const file = (release.files || []).find((f) => f.assetType === MANIFEST);
  const manifest = file ? await timed(fetchFn, file.source) : null;
  return { version: release.version, engine: prop(release, ENGINE) || (manifest && manifest.engines && manifest.engines.vscode) || '', manifest };
}

async function fromOpenVsx(id, fetchFn) {
  const [ns, name] = id.split('.');
  const body = await timed(fetchFn, `${OPEN_VSX}/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`);
  if (!body || !body.version) return null;
  const url = body.files && body.files.manifest;
  const manifest = url ? await timed(fetchFn, url) : null;
  return { version: body.version, engine: (body.engines && body.engines.vscode) || (manifest && manifest.engines && manifest.engines.vscode) || '', manifest };
}

/*
 * { version, engine, protocol, accepts, gallery } for the newest non-pre-release version of `id`, or null when the
 * gallery does not have it. Throws when the gallery cannot be reached. protocol is 0 and accepts [] when the manifest
 * says nothing under "agentPlus".
 */
async function latest(id, { scheme, fetch: fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('this editor has no fetch()');
  const gallery = galleryOf(scheme);
  const r = gallery === 'marketplace' ? await fromMarketplace(id, fetchFn) : await fromOpenVsx(id, fetchFn);
  if (!r) return null;
  const declared = (r.manifest && r.manifest.agentPlus) || {};
  return {
    version: String(r.version),
    engine: String(r.engine || ''),
    protocol: Number.isInteger(declared.protocol) ? declared.protocol : 0,
    accepts: Array.isArray(declared.accepts) ? declared.accepts.filter(Number.isInteger) : [],
    gallery,
  };
}

/* [major, minor, patch] of a version string, or null. */
function parts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/*
 * Whether VS Code `version` satisfies an engines.vscode range as extensions write it: "^1.96.0", ">=1.96.0", "1.96.0"
 * or "*". A range in another form is taken as satisfied: refusing an update on a misread range would leave the user
 * with no way forward, and VS Code checks the range itself when it installs.
 */
function engineAllows(range, version) {
  const r = String(range || '').trim();
  const have = parts(version);
  if (!r || r === '*' || !have) return true;
  const m = /^(\^|>=)?\s*(\d+\.\d+\.\d+)/.exec(r);
  if (!m) return true;
  const need = parts(m[2]);
  if (m[1] === '^') return have[0] === need[0] && cmp(have, need) >= 0;
  return cmp(have, need) >= 0;
}

module.exports = { MARKETPLACE, OPEN_VSX, galleryOf, latest, engineAllows, parts };
