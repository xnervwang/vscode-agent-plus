// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/envelope.js; sync-shared.js copies it, so edit it there.

'use strict';
/* On a light background a colour emoji font's ✉️ is white and all but invisible, so there the text form is drawn. */
const COLOUR = '✉️';
const TEXT = '✉︎';
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
