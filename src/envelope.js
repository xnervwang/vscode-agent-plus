// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/envelope.js; sync-shared.js copies it, so edit it there.

'use strict';
/* A dark theme draws the envelope with an arrow, which a colour emoji font draws clearer there than the plain envelope ✉️.
   On a light background both are white and faint in that font, and 📩 has no text form, so a light theme draws the plain
   envelope's text form, a dark outline. */
const COLOUR = '\u{1F4E9}';
const TEXT = '\u2709\uFE0E';
/* vscode.ColorThemeKind: Light is 1 and HighContrastLight 4. */
const LIGHT_KINDS = [1, 4];

function envelope(vscode) {
  let kind = 0;
  try { kind = vscode.window.activeColorTheme.kind; } catch (_) { kind = 0; }
  return LIGHT_KINDS.includes(kind) ? TEXT : COLOUR;
}

function onEnvelopeChange(vscode, changed) {
  const on = vscode.window && vscode.window.onDidChangeActiveColorTheme;
  return typeof on === 'function' ? on(() => changed()) : { dispose() {} };
}

module.exports = { envelope, onEnvelopeChange, COLOUR, TEXT };
