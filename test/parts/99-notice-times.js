// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs last: every notification the parts before it had this extension show through the stand-in vscode carried its
 * time (src/notice-time.js).
 */
const fake = require('../fake-vscode');

module.exports = ({ eq }) => {
  eq(fake.unstamped.slice(0, 5), [], 'every notification shown in the parts before this one starts with its time');
};
