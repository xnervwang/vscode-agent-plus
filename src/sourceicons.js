// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Row icons in the Conversations tab when more than one source is registered: the source's logo with an activity dot at
 * the top right, where Claude Code's own pending icon has its dot, or the logo alone for a conversation that stopped.
 * The logo is read from the agent's own extension, so none is shipped here; the dotted copies are written to this
 * extension's storage on first use.
 * SVG files cannot use theme colours, so COLORS holds the default light and dark theme values. From src/sourceicons.js
 * of vscode-claude-code-extras bb28f51.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./files');
const { readBounded } = require('./bounded');

/* charts.blue, charts.red and charts.green in the default themes, for the session list's dots as
   src/conversations-view.js colours them. `ring` draws the dot hollow; '' is the logo alone. */
const COLORS = {
  blue: { light: '#1a85ff', dark: '#3794ff' },
  red: { light: '#e51400', dark: '#f14c4c' },
  redRing: { light: '#e51400', dark: '#f14c4c', ring: true },
  green: { light: '#388a34', dark: '#89d185' },
  greenRing: { light: '#388a34', dark: '#89d185', ring: true },
  '': null,
};
const MAX_BYTES = 256 * 1024;
const MASK = 'awp-source-dot';
const PLACING = new Set(['width', 'height', 'x', 'y', 'style', 'class', 'id', 'xmlns']);

/* `svg` drawn in 16 pixels with a dot of `color` at the top right, or alone when `color` is empty. */
function withDot(svg, color, ring = false) {
  const text = String(svg || '');
  const open = /<svg\b([^>]*)>/i.exec(text);
  if (!open || /\/\s*$/.test(open[1])) return '';
  const end = text.lastIndexOf('</svg>');
  if (end < open.index + open[0].length) return '';
  const inner = text.slice(open.index + open[0].length, end)
    .replace(/<title\b[\s\S]*?<\/title>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  if (!inner.trim()) return '';
  const attrs = [];
  let viewBox = '', w = NaN, h = NaN;
  for (const m of open[1].matchAll(/([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g)) {
    const name = m[1], value = m[2].slice(1, -1);
    if (name === 'viewBox') viewBox = value;
    else if (name === 'width') w = parseFloat(value);
    else if (name === 'height') h = parseFloat(value);
    if (name !== 'viewBox' && !PLACING.has(name) && !/^on/i.test(name)) attrs.push(`${name}=${m[2]}`);
  }
  if (!viewBox) viewBox = w > 0 && h > 0 ? `0 0 ${w} ${h}` : '0 0 24 24';
  const logo = `<svg x="0" y="0" width="24" height="24" viewBox="${viewBox}"${attrs.length ? ' ' + attrs.join(' ') : ''}>` + inner + '</svg>';
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">';
  if (!color) return head + logo + '</svg>';
  /* The ring's outer edge is where the dot's is, so the two read as the same mark filled and hollow. */
  const dot = ring ? `<circle cx="19.5" cy="4.5" r="3.5" fill="none" stroke="${color}" stroke-width="2"/>`
    : `<circle cx="19.5" cy="4.5" r="4.5" fill="${color}"/>`;
  return head
    + `<defs><mask id="${MASK}"><rect width="24" height="24" fill="white"/><circle cx="19.5" cy="4.5" r="6.5" fill="black"/></mask></defs>`
    + `<g mask="url(#${MASK})">${logo}</g>` + dot + '</svg>';
}

/* The dot becomes part of the file name, so only those in COLORS are accepted and the path must stay inside `dir`. */
function iconsFor(logo, activity, dir, cache) {
  if (!Object.prototype.hasOwnProperty.call(COLORS, activity)) return null;
  const colors = COLORS[activity] || {};
  const key = JSON.stringify([logo && logo.light, logo && logo.dark, activity]);
  if (cache && cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const made = {};
    const home = path.resolve(dir);
    for (const theme of ['light', 'dark']) {
      const file = logo && logo[theme];
      const body = typeof file === 'string' && file ? readBounded(file, MAX_BYTES) : null;
      if (body === null) throw new Error('no usable logo');
      const svg = withDot(body, colors[theme], colors.ring === true);
      if (!svg) throw new Error('not an SVG');
      const target = path.join(home, `${crypto.createHash('sha256').update(svg).digest('hex').slice(0, 12)}-${activity || 'none'}-${theme}.svg`);
      if (path.dirname(target) !== home) throw new Error('outside the icons folder');
      let have = '';
      try { have = fs.readFileSync(target, 'utf8'); } catch (_) { /* not written yet */ }
      if (have !== svg) {
        fs.mkdirSync(dir, { recursive: true });
        writeAtomic(target, svg);
      }
      made[theme] = target;
    }
    out = made;
  } catch (_) { out = null; }
  if (cache) cache.set(key, out);
  return out;
}

module.exports = { COLORS, withDot, iconsFor };
