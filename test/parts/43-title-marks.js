// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The marks drawn with a conversation's title (src/title-marks.js): stripped wherever they stand, then shown with one
 * crown first for a steward and one envelope last for a reply not read.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const tm = require(path.join(root, 'src', 'title-marks.js'));
  const env = require(path.join(root, 'src', 'envelope.js'));
  const C = '\u{1F451}', E = env.COLOUR, T = env.TEXT, BELL = '\u{1F6CE}\uFE0F', BELL0 = '\u{1F6CE}';
  const typed = ['Title', C + ' Title', C + ' ' + C + ' Title', 'Ti ' + C + ' tle', 'Title ' + C, 'Title ' + BELL, 'Title ' + BELL0,
    C + ' Title ' + BELL, 'Title ' + E, E + ' Title ' + E + E, C + ' Title ' + E, '  ' + C + 'Title' + E + '  ', 'Title ' + T, 'Ti ' + T + ' tle \u2709'];
  const want = ['Title', 'Title', 'Title', 'Ti tle', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Ti tle'];
  eq(typed.map(tm.withoutMarks), want, 'every crown, envelope in either form and bell is taken off wherever it stands, and the spaces around it closed up');
  eq(typed.map((t) => tm.withMarks(t, { steward: true, unseen: true })), want.map((w) => `${C} ${w} ${E}`), 'and a steward with a reply not read is shown with one crown first and one envelope last');
  eq(typed.map((t) => tm.withMarks(t, {})), want, 'and with no mark at all otherwise');
  eq([tm.withoutMarks(''), tm.withMarks(C, { steward: true }), tm.withEnvelope('Fix ' + E + ' it', true), tm.withEnvelope('Fix it ' + E, false),
    tm.withEnvelope('Fix it', true, T), tm.withoutEnvelope(C + ' Fix ' + T)],
  ['', C, 'Fix it ' + E, 'Fix it', 'Fix it ' + T, C + ' Fix'],
  'the envelope part works on its own, for an agent with no steward, and draws the form it is given');
  eq(tm.ENVELOPE, E, 'the envelope it draws by default is the colour form src/envelope.js gives a dark theme');
};
