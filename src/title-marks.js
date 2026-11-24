// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/title-marks.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * The marks Claude Code Plus and Codex Plus show with a conversation's title, after it: the steward crown (Claude Code
 * Plus only), then the envelope for a reply not read yet, and the bell older builds put after a steward's title. They are drawn, never stored: a title
 * typed in a rename box, written by an older build, or set by Claude Code is stripped of every one of them wherever it
 * stands, and then shown with exactly one crown after the title for a steward and exactly one envelope last while a reply
 * is unread. No dependency on Claude Code or VS Code; withoutEnvelope() and withEnvelope() serve an agent that has no
 * steward. The envelope drawn is 📩 (src/envelope.js); the plain envelope ✉ that earlier builds drew, in its colour and
 * text forms, is taken off as well, since titles saved then still carry it. The one to draw is passed in.
 */

const CROWN = '\u{1F451}';
const ENVELOPE = require('./envelope').COLOUR;
/* Each mark with the emoji or the text variation selector after it, or neither. */
const ENVELOPES = /(?:\u{1F4E9}|\u2709)[\uFE0E\uFE0F]?/gu;
const MARKS = /(?:\u{1F451}|\u{1F6CE}|\u{1F4E9}|\u2709)[\uFE0E\uFE0F]?/gu;

/* `text` with what `re` matches taken out, each run of spaces left in it joined into one, and the ends trimmed. */
function strip(text, re) {
  const s = String(text == null ? '' : text);
  re.lastIndex = 0;
  if (!re.test(s)) return s;
  re.lastIndex = 0;
  return s.split(re).map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s{2,}/g, ' ');
}

/** `title` without any envelope. */
function withoutEnvelope(title) {
  return strip(title, ENVELOPES);
}

/** `title` without any crown, envelope or bell. */
function withoutMarks(title) {
  return strip(title, MARKS);
}

/** `title`, stripped of envelopes, with one envelope (`envelope`, the colour form unless given) last when `unseen`. */
function withEnvelope(title, unseen, envelope = ENVELOPE) {
  const t = withoutEnvelope(title);
  return unseen ? (t ? t + ' ' + envelope : envelope) : t;
}

/** `title`, stripped of every mark, with one crown after it for a steward and one envelope last when `unseen`. */
function withMarks(title, { steward = false, unseen = false, envelope = ENVELOPE } = {}) {
  const t = withoutMarks(title);
  return withEnvelope(steward ? (t ? t + ' ' + CROWN : CROWN) : t, unseen, envelope);
}

module.exports = { CROWN, ENVELOPE, withoutEnvelope, withoutMarks, withEnvelope, withMarks };
