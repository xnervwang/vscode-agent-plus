// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs last, and checks that each notification shown in the parts before it began with its time (src/notice-time.js).
 */
const fake = require('../fake-vscode');

module.exports = ({ eq }) => {
  eq(fake.unstamped.slice(0, 5), [], 'every notification shown in the parts before this one starts with its time');
};
